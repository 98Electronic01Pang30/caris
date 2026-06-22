import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/process-runner.js";
import { formatAgentTranscript, truncateToolResult } from "../src/transcript-format.js";
import { formatWorkflowEvent } from "../src/workflow-event-format.js";
import { formatRoleOutputForChat, formatTaskPlanForChat, normalizeRoleTranscript } from "../src/role-presentation.js";
import { debuggerPrompt, implementerPrompt, reviewerPrompt, verifierPrompt } from "../src/prompts.js";
import { ArtifactStore } from "../src/artifacts.js";
import { renderStoredTranscript } from "../src/stored-transcript.js";

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
  const plan = { summary: "Improve it", steps: ["Inspect", "Change"], files: ["src/a.ts"], risks: ["Regression"], verification: ["pnpm test"] };

  it("renders structured planner output as conversational Markdown", () => {
    const text = formatRoleOutputForChat("planner", JSON.stringify(plan));
    expect(text).toBe(formatTaskPlanForChat(plan));
    expect(text).toContain("**Plan**");
    expect(text).toContain("1. Inspect");
    expect(text).not.toContain('{"summary"');
  });

  it("combines chunked planner JSON using the canonical final output", () => {
    const json = JSON.stringify(plan);
    const split = Math.floor(json.length / 2);
    const items = normalizeRoleTranscript("planner", [
      { kind: "assistant_message", text: json.slice(0, split) },
      { kind: "assistant_message", text: json.slice(split) },
    ], json);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind === "assistant_message" ? items[0].text : "").toContain("**Plan**");
    expect(items[0]?.kind === "assistant_message" ? items[0].text : "").not.toContain('{"summary"');
  });

  it("preserves natural progress before a structured final report", () => {
    const json = JSON.stringify({ summary: "Done", changes: ["a.ts"], tests: ["passed"] });
    const items = normalizeRoleTranscript("implementer", [
      { kind: "assistant_message", text: "파일을 확인하겠습니다." },
      { kind: "assistant_message", text: json },
    ], json);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "assistant_message", text: "파일을 확인하겠습니다." });
    expect(items[1]?.kind === "assistant_message" ? items[1].text : "").toContain("**Changes**");
  });

  it("formats incomplete planner report JSON instead of exposing it", () => {
    const source = JSON.stringify({ summary: "Plan it", steps: ["Inspect", "Fix"] });
    const text = formatRoleOutputForChat("planner", source);
    expect(text).toContain("**Plan**");
    expect(text).not.toContain('{"summary"');
  });

  it.each([
    ["implementer", { summary: "Implemented", changes: ["Updated a.ts"], tests: ["passed"] }],
    ["debugger", { cause: "Race", changes: ["Serialized writes"], verification: ["passed"] }],
    ["verifier", { status: "PASS", checks: ["pnpm test"], evidence: ["60 tests"] }],
    ["reviewer", { findings: ["No findings"], conclusion: "Approved" }],
  ] as const)("renders a known %s report object as Markdown", (role, report) => {
    const text = normalizeRoleTranscript(role, [{ kind: "assistant_message", text: JSON.stringify(report) }]);
    expect(text[0]?.kind === "assistant_message" ? text[0].text : "").toContain("**");
    expect(text[0]?.kind === "assistant_message" ? text[0].text : "").not.toContain(JSON.stringify(report));
  });

  it("preserves an arbitrary JSON answer that is not a role report", () => {
    const source = '{"theme":"dark","enabled":true}';
    expect(formatRoleOutputForChat("implementer", source)).toBe(source);
    const ambiguous = '{"summary":"user data","custom":true}';
    expect(formatRoleOutputForChat("implementer", ambiguous)).toBe(ambiguous);
  });

  it("formats usage and structured tool arguments without raw JSON blocks", () => {
    expect(formatAgentTranscript("implementer", "codex", [{
      kind: "usage",
      text: '{"input_tokens":23160,"output_tokens":1324,"cached_input_tokens":0}',
      usage: { input_tokens: 23160, output_tokens: 1324, cached_input_tokens: 0 },
    }])).toContain("Tokens · input 23,160 · output 1,324 · cached 0");
    const tool = formatAgentTranscript("implementer", "claude", [{ kind: "tool_call", tool: "Edit", text: '{"file":"a.ts","replace":"new"}' }]);
    expect(tool).toContain("file: a.ts");
    expect(tool).not.toContain('{"file"');
  });

  it("requires conversational Markdown final responses from every non-planner role", () => {
    const prompts = [
      implementerPrompt("request", plan),
      debuggerPrompt("request", plan, []),
      verifierPrompt("request", "scope", "change", "diff", []),
      reviewerPrompt("request", plan, "diff"),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain("Markdown");
      expect(prompt).toContain("not JSON");
    }
  });

  it("re-renders stored raw transcript JSON with the current formatter", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-stored-transcript-"));
    const store = new ArtifactStore(root);
    try {
      const run = await store.createRun("plan", true);
      const json = JSON.stringify(plan);
      await store.writeText(run.id, "agent-transcript-01.json", `${JSON.stringify({
        provider: "codex",
        role: "planner",
        items: [{ kind: "assistant_message", text: json }],
      })}\n`);
      await store.writeText(run.id, "transcript.md", `Planner · Codex\n\n${json}\n`);
      const rendered = await renderStoredTranscript(store, run.id);
      expect(rendered).toContain("**Plan**");
      expect(rendered).not.toContain('{"summary"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
