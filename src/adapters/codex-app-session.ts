import { AsyncEventQueue } from "../agent-session.js";
import type {
  AgentResult,
  AgentSession,
  AgentSessionEvent,
  AgentTask,
  InteractionResponse,
} from "../domain.js";
import type { ProcessHandle, ProcessRunner } from "../process-runner.js";

type JsonRecord = Record<string, unknown>;
type UnsequencedEvent =
  | { kind: "transcript"; item: AgentResult["transcript"][number]; delta?: boolean }
  | { kind: "interaction_requested"; request: import("../domain.js").InteractionRequest }
  | { kind: "diagnostic"; message: string };

export function createCodexAppSession(
  runner: ProcessRunner,
  executable: string,
  task: AgentTask,
): AgentSession | undefined {
  if (!runner.spawn) return undefined;
  const events = new AsyncEventQueue<AgentSessionEvent>();
  const rawEvents: unknown[] = [];
  const transcript: AgentResult["transcript"] = [];
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const serverRequests = new Map<string, { rpcId: string | number; method: string; params: JsonRecord }>();
  let requestId = 0;
  let sequence = 0;
  let buffer = "";
  let stderrBuffer = "";
  const seenDiagnostics = new Set<string>();
  let output = "";
  let threadId = "";
  let turnId = "";
  let terminal = false;
  const started = performance.now();

  let handle: ProcessHandle;
  const send = (message: unknown): void => handle.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = ++requestId;
    send({ id, method, params });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const emit = (event: UnsequencedEvent): void => {
    events.push({ ...event, sequence: ++sequence } as AgentSessionEvent);
  };
  const emitItem = (item: AgentResult["transcript"][number], delta = false): void => {
    if (!delta) transcript.push(item);
    emit({ kind: "transcript", item, ...(delta ? { delta: true } : {}) });
  };

  const processMessage = (message: JsonRecord): void => {
    rawEvents.push(message);
    if (message.id !== undefined && ("result" in message || "error" in message) && typeof message.id === "number") {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(stringify(message.error)));
        else waiter.resolve(message.result);
      }
      return;
    }
    const method = typeof message.method === "string" ? message.method : "";
    const params = record(message.params);
    if (message.id !== undefined && method) {
      const interactionId = `codex-${String(message.id)}`;
      serverRequests.set(interactionId, { rpcId: message.id as string | number, method, params });
      if (method === "item/tool/requestUserInput") {
        const questions = Array.isArray(params.questions) ? params.questions.map(record) : [];
        emit({
          kind: "interaction_requested",
          request: {
            id: interactionId,
            kind: "question",
            prompt: questions.map((question) => String(question.question ?? "Answer required")).join("\n"),
            choices: questions.flatMap((question) => Array.isArray(question.options)
              ? question.options.map((option) => ({ id: String(record(option).label ?? "option"), label: String(record(option).description ?? record(option).label ?? "option") }))
              : []),
            allowMultiple: questions.length > 1,
            secret: questions.some((question) => question.isSecret === true),
          },
        });
      } else if (method.includes("requestApproval")) {
        emit({
          kind: "interaction_requested",
          request: {
            id: interactionId,
            kind: "permission",
            prompt: [params.reason, params.command, params.grantRoot].filter((value) => typeof value === "string").join("\n") || "Allow this agent action?",
            choices: [
              { id: "y", label: "Allow once" },
              { id: "a", label: "Allow for session" },
              { id: "n", label: "Deny" },
            ],
          },
        });
      }
      return;
    }
    if (method === "turn/started") turnId = String(record(params.turn).id ?? "");
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      output += params.delta;
      emitItem({ kind: "assistant_message", text: params.delta }, true);
    } else if (method === "item/commandExecution/outputDelta" && typeof params.delta === "string") {
      emitItem({ kind: "tool_result", text: params.delta }, true);
    } else if (method === "item/started") {
      const item = record(params.item);
      if (item.type === "commandExecution") emitItem({ kind: "tool_call", tool: "shell", text: stringify(item.command ?? item.commands ?? "command") });
    } else if (method === "item/completed") {
      const item = record(params.item);
      if (item.type === "agentMessage" && typeof item.text === "string") {
        output = item.text;
        transcript.push({ kind: "assistant_message", text: item.text });
      } else if (item.type === "fileChange") {
        emitItem({ kind: "file_change", text: stringify(item.changes ?? item) });
      } else if (item.type === "commandExecution" && typeof item.aggregatedOutput === "string") {
        transcript.push({ kind: "tool_result", text: item.aggregatedOutput, ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}) });
      }
    } else if (method === "turn/completed") {
      const turn = record(params.turn);
      terminal = true;
      if (turn.status === "failed") emit({ kind: "diagnostic", message: stringify(turn.error ?? "Codex turn failed") });
      handle.endInput();
    }
  };

  handle = runner.spawn({
    executable,
    args: ["app-server"],
    cwd: task.cwd,
    ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  }, {
    stdout: (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { processMessage(record(JSON.parse(line))); }
        catch (error) { emit({ kind: "diagnostic", message: `Invalid Codex app-server event: ${error instanceof Error ? error.message : String(error)}` }); }
      }
    },
    stderr: (chunk) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const message = formatCodexDiagnostic(line);
        if (!message || seenDiagnostics.has(message)) continue;
        seenDiagnostics.add(message);
        emit({ kind: "diagnostic", message });
      }
    },
  });

  const initialized = (async () => {
    await request("initialize", { clientInfo: { name: "caris", title: "CARIS", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized", params: {} });
    const threadResult = record(await request("thread/start", {
      cwd: task.cwd,
      model: task.model ?? null,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: task.role === "planner" || task.role === "verifier" || task.role === "reviewer" ? "read-only" : "workspace-write",
      ephemeral: true,
      config: task.effort ? { model_reasoning_effort: task.effort } : null,
    }));
    threadId = String(record(threadResult.thread).id ?? "");
    const turnResult = record(await request("turn/start", {
      threadId,
      input: [{ type: "text", text: task.prompt, text_elements: [] }],
      cwd: task.cwd,
      model: task.model ?? null,
      effort: task.effort ?? null,
      approvalPolicy: "on-request",
    }));
    turnId = String(record(turnResult.turn).id ?? turnId);
  })();

  const result = Promise.all([initialized, handle.completed]).then(([, processResult]): AgentResult => ({
    provider: "codex",
    exitCode: terminal && processResult.exitCode === 0 ? 0 : processResult.exitCode || (terminal ? 0 : 1),
    output: output.trim(),
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    durationMs: Math.round(performance.now() - started),
    rawEvents,
    transcript,
  })).catch((error: unknown): AgentResult => ({
    provider: "codex",
    exitCode: 1,
    output: output.trim(),
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    durationMs: Math.round(performance.now() - started),
    rawEvents,
    transcript,
  })).finally(() => events.close());

  return {
    events,
    result,
    respond: async (id: string, response: InteractionResponse) => {
      const pendingRequest = serverRequests.get(id);
      if (!pendingRequest) throw new Error(`Unknown Codex interaction: ${id}`);
      serverRequests.delete(id);
      let resultPayload: unknown;
      if (pendingRequest.method === "item/tool/requestUserInput") {
        const questions = Array.isArray(pendingRequest.params.questions) ? pendingRequest.params.questions.map(record) : [];
        const answers = response.kind === "answer" ? response.answers : [];
        resultPayload = { answers: Object.fromEntries(questions.map((question, index) => [String(question.id), { answers: answers[index] ? [answers[index]] : answers }])) };
      } else {
        resultPayload = { decision: response.kind === "allow_once" ? "accept" : response.kind === "allow_session" ? "acceptForSession" : "decline" };
      }
      send({ id: pendingRequest.rpcId, result: resultPayload });
    },
    steer: async (message: string) => {
      if (!threadId || !turnId) throw new Error("Codex turn has not started yet");
      await request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: message, text_elements: [] }] });
    },
    cancel: async () => {
      if (threadId && turnId) await request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      else handle.cancel();
    },
  };
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function formatCodexDiagnostic(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  try {
    const event = record(JSON.parse(trimmed));
    const fields = record(event.fields);
    const message = typeof fields.message === "string" ? fields.message : typeof event.message === "string" ? event.message : "";
    const level = typeof event.level === "string" ? event.level.toUpperCase() : "DIAGNOSTIC";
    return message ? `${level}: ${message}` : "";
  } catch {
    return trimmed;
  }
}
