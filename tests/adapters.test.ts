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
    const sandboxIndex = captured?.args.indexOf("--sandbox") ?? -1;
    expect(captured?.args[sandboxIndex + 1]).toBe("read-only");
  });

  it("uses workspace-write for implementation", async () => {
    let captured: ProcessRequest | undefined;
    const runner: ProcessRunner = {
      async run(request) {
        captured = request;
        return successResult("{}");
      },
    };
    await new CodexAdapter(runner).execute({
      role: "implementer",
      prompt: "implement",
      cwd: process.cwd(),
      model: "gpt-test",
      effort: "high",
    });
    const sandboxIndex = captured?.args.indexOf("--sandbox") ?? -1;
    expect(captured?.args[sandboxIndex + 1]).toBe("workspace-write");
    expect(captured?.args).toEqual(
      expect.arrayContaining(["--model", "gpt-test", "--config", 'model_reasoning_effort="high"']),
    );
  });
});

describe("headless provider permission contracts", () => {
  it("runs Gemini planners in trusted read-only plan mode", async () => {
    let captured: ProcessRequest | undefined;
    const runner: ProcessRunner = {
      async run(request) {
        captured = request;
        return successResult('{"type":"message","content":"ok"}\n');
      },
    };
    await new GeminiAdapter(runner).execute({ role: "planner", prompt: "plan", cwd: process.cwd() });
    expect(captured?.args).toEqual(expect.arrayContaining(["--skip-trust", "--approval-mode", "plan"]));
    expect(captured?.input).toBe("plan");
  });

  it("allows Gemini implementers to edit without interactive approval", async () => {
    let captured: ProcessRequest | undefined;
    const runner: ProcessRunner = {
      async run(request) {
        captured = request;
        return successResult('{"type":"message","content":"ok"}\n');
      },
    };
    await new GeminiAdapter(runner).execute({
      role: "implementer",
      prompt: "implement",
      cwd: process.cwd(),
    });
    expect(captured?.args).toEqual(expect.arrayContaining(["--approval-mode", "auto_edit"]));
  });

  it("uses Claude plan and edit permission modes by role", async () => {
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = {
      async run(request) {
        requests.push(request);
        return successResult('{"type":"result","result":"ok"}\n');
      },
    };
    const adapter = new ClaudeAdapter(runner);
    await adapter.execute({ role: "planner", prompt: "plan", cwd: process.cwd() });
    await adapter.execute({
      role: "debugger",
      prompt: "debug",
      cwd: process.cwd(),
      model: "sonnet",
      effort: "high",
    });
    expect(requests[0]?.args).toEqual(expect.arrayContaining(["--permission-mode", "plan"]));
    expect(requests[1]?.args).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits"]));
    expect(requests[0]?.input).toBe("plan");
    expect(requests[1]?.input).toBe("debug");
    expect(requests[1]?.args).toEqual(expect.arrayContaining(["--model", "sonnet", "--effort", "high"]));
  });
});

function successResult(stdout: string): ProcessResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
    failed: false,
    timedOut: false,
    cancelled: false,
  };
}
