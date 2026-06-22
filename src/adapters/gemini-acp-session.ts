import { Readable, Writable } from "node:stream";
import { execa } from "execa";
import * as acp from "@agentclientprotocol/sdk";
import { AsyncEventQueue } from "../agent-session.js";
import type { AgentResult, AgentSession, AgentSessionEvent, AgentTask, InteractionResponse } from "../domain.js";

type PermissionParams = acp.RequestPermissionRequest;
type PermissionResponse = acp.RequestPermissionResponse;
type UnsequencedEvent =
  | { kind: "transcript"; item: AgentResult["transcript"][number]; delta?: boolean }
  | { kind: "interaction_requested"; request: import("../domain.js").InteractionRequest }
  | { kind: "diagnostic"; message: string };

export function createGeminiAcpSession(executable: string, task: AgentTask): AgentSession {
  const events = new AsyncEventQueue<AgentSessionEvent>();
  const transcript: AgentResult["transcript"] = [];
  const rawEvents: unknown[] = [];
  const pending = new Map<string, { params: PermissionParams; resolve: (response: PermissionResponse) => void }>();
  let sequence = 0;
  let output = "";
  let sessionId = "";
  let cancelSession: (() => Promise<void>) | undefined;
  const started = performance.now();
  const readOnly = task.role === "planner" || task.role === "verifier" || task.role === "reviewer";
  const child = execa(executable, ["--acp", "--approval-mode", readOnly ? "plan" : "default", ...(task.model ? ["--model", task.model] : [])], {
    cwd: task.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    reject: false,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += String(chunk);
    events.push({ kind: "diagnostic", message: String(chunk), sequence: ++sequence });
  });
  const emit = (event: UnsequencedEvent): void => events.push({ ...event, sequence: ++sequence } as AgentSessionEvent);

  const permission = async (params: PermissionParams): Promise<PermissionResponse> => {
    const id = `gemini-${params.toolCall.toolCallId}`;
    emit({
      kind: "interaction_requested",
      request: {
        id,
        kind: "permission",
        prompt: params.toolCall.title ?? "Allow this Gemini tool call?",
        choices: params.options.map((option) => ({ id: option.optionId, label: `${option.name} (${option.kind})` })),
      },
    });
    return new Promise((resolve) => pending.set(id, { params, resolve }));
  };

  if (!child.stdin || !child.stdout) throw new Error("Gemini ACP stdio is unavailable");
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const result = acp.client({ name: "caris" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => permission(ctx.params))
    .connectWith(stream, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      return ctx.buildSession(task.cwd).withSession(async (session) => {
        sessionId = session.sessionId;
        cancelSession = async () => ctx.notify(acp.methods.agent.session.cancel, { sessionId });
        void session.prompt(task.prompt);
        for (;;) {
          const message = await session.nextUpdate();
          rawEvents.push(message);
          if (message.kind === "stop") return message.response;
          const update = message.update;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            output += update.content.text;
            emit({ kind: "transcript", item: { kind: "assistant_message", text: update.content.text }, delta: true });
          } else if (update.sessionUpdate === "tool_call") {
            const item = { kind: "tool_call" as const, tool: update.kind ?? "tool", text: update.title };
            transcript.push(item);
            emit({ kind: "transcript", item });
          } else if (update.sessionUpdate === "tool_call_update") {
            const item = { kind: "tool_result" as const, text: `${update.toolCallId}: ${update.status ?? "updated"}` };
            transcript.push(item);
            emit({ kind: "transcript", item });
          }
        }
      });
    })
    .then((): AgentResult => {
      if (output.trim()) transcript.push({ kind: "assistant_message", text: output.trim() });
      return { provider: "gemini", exitCode: 0, output: output.trim(), stdout: rawEvents.map((item) => JSON.stringify(item)).join("\n"), stderr, durationMs: Math.round(performance.now() - started), rawEvents, transcript };
    })
    .catch((error: unknown): AgentResult => ({ provider: "gemini", exitCode: 1, output: output.trim(), stdout: rawEvents.map((item) => JSON.stringify(item)).join("\n"), stderr: stderr || (error instanceof Error ? error.message : String(error)), durationMs: Math.round(performance.now() - started), rawEvents, transcript }))
    .finally(() => { events.close(); child.kill(); });

  task.signal?.addEventListener("abort", () => { void cancelSession?.(); child.kill(); }, { once: true });
  return {
    events,
    result,
    respond: async (id: string, response: InteractionResponse) => {
      const request = pending.get(id);
      if (!request) throw new Error(`Unknown Gemini interaction: ${id}`);
      pending.delete(id);
      const desired = response.kind === "allow_session" ? "allow_always" : response.kind === "allow_once" ? "allow_once" : "reject_once";
      const option = request.params.options.find((candidate) => candidate.kind === desired) ?? request.params.options.at(-1);
      request.resolve(option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } });
    },
    steer: async () => { throw new Error("Gemini ACP does not support same-turn steering"); },
    cancel: async () => { await cancelSession?.(); child.kill(); },
  };
}
