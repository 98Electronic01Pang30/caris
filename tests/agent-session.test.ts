import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapters/codex.js";
import { CliAgentAdapter } from "../src/adapters/cli-adapter.js";
import type { ProcessHandle, ProcessListener, ProcessRequest, ProcessResult, ProcessRunner } from "../src/process-runner.js";

class StreamingRunner implements ProcessRunner {
  async run(): Promise<ProcessResult> { throw new Error("not used"); }
  spawn(_request: ProcessRequest, listener: ProcessListener): ProcessHandle {
    let input = "";
    const completed = new Promise<ProcessResult>((resolve) => {
      queueMicrotask(() => {
        const lines = [
          { type: "item.completed", item: { type: "command_execution", command: "pnpm test", aggregated_output: "ok", exit_code: 0 } },
          { type: "item.completed", item: { type: "agent_message", text: "Done" } },
        ].map((item) => JSON.stringify(item));
        listener.stdout?.(`${lines.join("\n")}\n`);
        resolve({ exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "", durationMs: 1, failed: false, timedOut: false, cancelled: false });
      });
    });
    return { completed, write: (chunk) => { input += chunk; }, endInput: () => undefined, cancel: () => undefined };
  }
}

describe("agent sessions", () => {
  it("emits provider transcript items before returning the final result", async () => {
    const adapter = new CodexAdapter(new StreamingRunner());
    // Exercise the generic streaming contract because app-server has its own protocol fixture coverage.
    const session = CliAgentAdapter.prototype.createSession.call(adapter, { role: "implementer", prompt: "work", cwd: process.cwd() });
    const seen: string[] = [];
    const pump = (async () => { for await (const event of session.events) if (event.kind === "transcript") seen.push(event.item.kind); })();
    const result = await session.result;
    await pump;
    expect(seen).toEqual(["tool_call", "tool_result", "assistant_message"]);
    expect(result.output).toBe("Done");
  });
});
