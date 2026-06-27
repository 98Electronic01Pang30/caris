import { describe, expect, it } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { createAcpSession } from "../src/adapters/acp-session.js";
import type { ProcessHandle, ProcessListener, ProcessRequest, ProcessResult, ProcessRunner } from "../src/process-runner.js";

class AcpRunner implements ProcessRunner {
  requests: Array<{ executable: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  decision = "";
  private listener?: ProcessListener;
  private stdout = "";
  private resolveCompleted?: (result: ProcessResult) => void;

  async run(): Promise<ProcessResult> { throw new Error("not used"); }

  spawn(request: ProcessRequest, listener: ProcessListener): ProcessHandle {
    this.requests.push({
      executable: request.executable,
      args: request.args,
      ...(request.env ? { env: request.env } : {}),
    });
    this.listener = listener;
    const completed = new Promise<ProcessResult>((resolve) => { this.resolveCompleted = resolve; });
    return {
      completed,
      write: (chunk) => this.receive(chunk),
      endInput: () => undefined,
      cancel: () => this.resolveCompleted?.({ exitCode: 0, stdout: this.stdout, stderr: "", durationMs: 1, failed: false, timedOut: false, cancelled: true }),
    };
  }

  private receive(chunk: string): void {
    for (const line of chunk.trim().split(/\r?\n/)) {
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number | string; method?: string; params?: { sessionId?: string }; result?: { outcome?: { optionId?: string } } };
      if (message.method === methods.agent.initialize) this.send({ id: message.id, result: { protocolVersion: 1 } });
      if (message.method === methods.agent.session.new) this.send({ id: message.id, result: { sessionId: "session-1", cwd: process.cwd() } });
      if (message.method === methods.agent.session.prompt && message.params?.sessionId === "session-1") {
        this.send({ method: methods.client.session.update, params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } } } });
        this.send({
          id: "permission-1",
          method: methods.client.session.requestPermission,
          params: {
            sessionId: "session-1",
            toolCall: { toolCallId: "tool-1", title: "Run tests", status: "pending" },
            options: [
              { optionId: "allow", name: "Allow once", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
        });
      }
      if (message.id === "permission-1" && message.result) {
        this.decision = message.result.outcome?.optionId ?? "";
        this.send({ method: methods.client.session.update, params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } } });
        this.send({ id: 3, result: { stopReason: "end_turn" } });
      }
    }
  }

  private send(message: unknown): void {
    const line = `${JSON.stringify({ jsonrpc: "2.0", ...(message as Record<string, unknown>) })}\n`;
    this.stdout += line;
    queueMicrotask(() => this.listener?.stdout?.(line));
  }
}

describe("ACP sessions", () => {
  it("streams text, requests permission, and returns the final transcript", async () => {
    const runner = new AcpRunner();
    const session = createAcpSession({
      provider: "codex",
      runner,
      executable: "codex-acp",
      args: [],
      task: { role: "implementer", prompt: "work", cwd: process.cwd() },
      env: { CODEX_PATH: "codex" },
      supportsSteering: true,
    });
    expect(session).toBeDefined();
    const events: string[] = [];
    const pump = (async () => {
      for await (const event of session!.events) {
        events.push(event.kind);
        if (event.kind === "interaction_requested") await session!.respond(event.request.id, { kind: "allow_once" });
      }
    })();
    const result = await session!.result;
    await pump;
    expect(runner.requests[0]).toMatchObject({ executable: "codex-acp", args: [] });
    expect(runner.decision).toBe("allow");
    expect(events).toContain("interaction_requested");
    expect(result.output).toBe("Hello world");
    expect(result.transcript.at(-1)).toEqual({ kind: "assistant_message", text: "Hello world" });
  });
});
