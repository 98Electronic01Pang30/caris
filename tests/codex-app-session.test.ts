import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { ProcessHandle, ProcessListener, ProcessRequest, ProcessResult, ProcessRunner } from "../src/process-runner.js";

class AppServerRunner implements ProcessRunner {
  decision = "";
  private listener?: ProcessListener;
  private stdout = "";
  private resolveCompleted?: (result: ProcessResult) => void;

  async run(): Promise<ProcessResult> { throw new Error("not used"); }

  spawn(_request: ProcessRequest, listener: ProcessListener): ProcessHandle {
    this.listener = listener;
    queueMicrotask(() => listener.stderr?.('{"level":"WARN","fields":{"message":"snapshot unavailable"}}\n{"level":"WARN","fields":{"message":"snapshot unavailable"}}\n'));
    const completed = new Promise<ProcessResult>((resolve) => { this.resolveCompleted = resolve; });
    return {
      completed,
      write: (chunk) => this.receive(chunk),
      endInput: () => this.resolveCompleted?.({ exitCode: 0, stdout: this.stdout, stderr: "", durationMs: 1, failed: false, timedOut: false, cancelled: false }),
      cancel: () => undefined,
    };
  }

  private receive(chunk: string): void {
    for (const line of chunk.trim().split(/\r?\n/)) {
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number | string; method?: string; result?: { decision?: string } };
      if (message.method === "initialize") this.send({ id: message.id, result: {} });
      if (message.method === "thread/start") this.send({ id: message.id, result: { thread: { id: "thread-1" } } });
      if (message.method === "turn/start") {
        this.send({ id: message.id, result: { turn: { id: "turn-1" } } });
        this.send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "pnpm test", reason: "Run tests" } });
      }
      if (message.id === "approval-1" && message.result) {
        this.decision = message.result.decision ?? "";
        this.send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "answer-1", delta: "OK" } });
        this.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text: "OK" } } });
        this.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
      }
    }
  }

  private send(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`;
    this.stdout += line;
    queueMicrotask(() => this.listener?.stdout?.(line));
  }
}

describe("Codex app-server session", () => {
  it("streams deltas and resumes the same turn after approval", async () => {
    const runner = new AppServerRunner();
    const session = new CodexAdapter(runner).createSession({ role: "implementer", prompt: "work", cwd: process.cwd() });
    const kinds: string[] = [];
    const diagnostics: string[] = [];
    const pump = (async () => {
      for await (const event of session.events) {
        kinds.push(event.kind);
        if (event.kind === "diagnostic") diagnostics.push(event.message);
        if (event.kind === "interaction_requested") await session.respond(event.request.id, { kind: "allow_once" });
      }
    })();
    const result = await session.result;
    await pump;
    expect(runner.decision).toBe("accept");
    expect(kinds).toContain("interaction_requested");
    expect(kinds).toContain("transcript");
    expect(result.output).toBe("OK");
    expect(diagnostics).toEqual(["WARN: snapshot unavailable"]);
  });
});
