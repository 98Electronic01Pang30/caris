import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/process-runner.js";

class NeverRunner implements ProcessRunner {
  run(_request: ProcessRequest): Promise<ProcessResult> {
    throw new Error("not used");
  }
}

describe("provider output parsers", () => {
  it.each([
    ["codex", new CodexAdapter(new NeverRunner()), "Codex final answer"],
    ["claude", new ClaudeAdapter(new NeverRunner()), "Claude final answer"],
    ["gemini", new GeminiAdapter(new NeverRunner()), "Gemini final answer"],
  ] as const)("parses %s JSONL fixtures", async (name, adapter, expected) => {
    const fixture = await readFile(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8");
    const result = adapter.parseOutput(fixture, "");
    expect(result.output).toBe(expected);
    expect(result.rawEvents).toHaveLength(3);
  });
});

describe("provider detection", () => {
  it("uses ENOENT instead of localized stderr to detect a missing CLI", async () => {
    const runner: ProcessRunner = {
      async run() {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "localized error",
          durationMs: 1,
          failed: true,
          timedOut: false,
          cancelled: false,
          errorCode: "ENOENT",
        };
      },
    };
    await expect(new ClaudeAdapter(runner).detect(process.cwd())).resolves.toMatchObject({
      status: "NOT_INSTALLED",
    });
  });
});

describe("Codex invocation contract", () => {
  it("sends planner prompts over stdin with isolated structured-output flags", async () => {
    let captured: ProcessRequest | undefined;
    const runner: ProcessRunner = {
      async run(request) {
        captured = request;
        return {
          exitCode: 0,
          stdout:
            '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}\n',
          stderr: "",
          durationMs: 1,
          failed: false,
          timedOut: false,
          cancelled: false,
        };
      },
    };
    await new CodexAdapter(runner).execute({
      role: "planner",
      prompt: "structured plan please",
      cwd: process.cwd(),
    });

    expect(captured?.input).toBe("structured plan please");
    expect(captured?.args).toEqual(
      expect.arrayContaining([
        "--ask-for-approval",
        "never",
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--output-schema",
        "-",
      ]),
    );
    expect(captured?.args.at(-1)).toBe("-");
  });
});
