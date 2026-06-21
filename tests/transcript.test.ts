import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/process-runner.js";
import { formatAgentTranscript, truncateToolResult } from "../src/transcript-format.js";
import { formatWorkflowEvent } from "../src/workflow-event-format.js";

class NeverRunner implements ProcessRunner {
  run(_request: ProcessRequest): Promise<ProcessResult> { throw new Error("not used"); }
}

describe("provider transcript parsing", () => {
  it("parses Codex chat, command, result, file change, and usage in order", () => {
    const source = [
      { type: "item.completed", item: { type: "agent_message", text: "Checking files" } },
      { type: "item.completed", item: { type: "command_execution", command: "rg TODO", aggregated_output: "src/a.ts:1", exit_code: 0 } },
      { type: "item.completed", item: { type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }] } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } },
    ].map((value) => JSON.stringify(value)).join("\n");
    expect(new CodexAdapter(new NeverRunner()).parseTranscript(source, "").map((item) => item.kind))
      .toEqual(["assistant_message", "tool_call", "tool_result", "file_change", "usage"]);
  });

  it("parses Claude tool blocks and removes duplicate final text", () => {
    const source = [
      { type: "assistant", message: { content: [{ type: "text", text: "Done" }, { type: "tool_use", name: "Edit", input: { file: "a.ts" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "updated" }] } },
      { type: "result", result: "Done", usage: { output_tokens: 2 } },
    ].map((value) => JSON.stringify(value)).join("\n");
    const items = new ClaudeAdapter(new NeverRunner()).parseTranscript(source, "");
    expect(items.map((item) => item.kind)).toEqual(["assistant_message", "tool_call", "tool_result", "usage"]);
  });

  it("parses Gemini chat and tool events", () => {
    const source = [
      { type: "message", role: "assistant", content: "Working" },
      { type: "tool_call", name: "write_file", arguments: { path: "a.ts" } },
      { type: "tool_result", output: "ok", exit_code: 0 },
    ].map((value) => JSON.stringify(value)).join("\n");
    expect(new GeminiAdapter(new NeverRunner()).parseTranscript(source, "").map((item) => item.kind))
      .toEqual(["assistant_message", "tool_call", "tool_result"]);
  });
});

describe("transcript formatting", () => {
  it("keeps all assistant text and truncates only long tool results", () => {
    const assistant = "한글".repeat(3_000);
    const formatted = formatAgentTranscript("implementer", "codex", [{ kind: "assistant_message", text: assistant }], { truncateToolResult: true });
    expect(formatted).toContain(assistant);
    const truncated = truncateToolResult("x".repeat(5_000));
    expect(truncated).toContain("1000 characters omitted");
    expect(truncated.length).toBeGreaterThan(4_000);
  });

  it("renders an agent event with role and provider identity", () => {
    const text = formatWorkflowEvent({
      runId: "run",
      stage: "IMPLEMENTING",
      kind: "agent_transcript",
      role: "implementer",
      provider: "codex",
      transcriptItem: { kind: "tool_call", tool: "shell", text: "pnpm test" },
      message: "ignored",
    });
    expect(text).toContain("Implementer · Codex");
    expect(text).toContain("Tool · shell");
  });
});
