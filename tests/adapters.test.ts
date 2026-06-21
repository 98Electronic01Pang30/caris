import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { AntigravityAdapter } from "../src/adapters/antigravity.js";
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
  it("uses Antigravity sandbox for read-only roles and auto approval for modifying roles", async () => {
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = {
      async run(request) {
        requests.push(request);
        return successResult("ok\n");
      },
    };
    const adapter = new AntigravityAdapter(runner, "agy.exe");
    await adapter.execute({ role: "planner", prompt: "plan", cwd: process.cwd(), model: "gemini-test" });
    await adapter.execute({ role: "debugger", prompt: "fix", cwd: process.cwd() });
    await adapter.execute({ role: "verifier", prompt: "verify", cwd: process.cwd() });
    expect(requests[0]?.args).toEqual(["--sandbox", "--model", "gemini-test", "--print", "plan"]);
    expect(requests[1]?.args).toEqual(["--dangerously-skip-permissions", "--print", "fix"]);
    expect(requests[2]?.args).toEqual(["--sandbox", "--print", "verify"]);
  });

  it("skips the Git repository check only in directory mode", async () => {
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = {
      async run(request) {
        requests.push(request);
        return successResult('{}');
      },
    };
    const adapter = new CodexAdapter(runner);
    await adapter.execute({
      role: "planner",
      prompt: "plan",
      cwd: process.cwd(),
      workspaceContext: { kind: "directory", root: process.cwd(), canDiff: false },
    });
    await adapter.execute({
      role: "planner",
      prompt: "plan",
      cwd: process.cwd(),
      workspaceContext: { kind: "git", root: process.cwd(), canDiff: true },
    });
    expect(requests[0]?.args).toContain("--skip-git-repo-check");
    expect(requests[1]?.args).not.toContain("--skip-git-repo-check");
  });

  it("treats an empty Antigravity headless response as a provider failure", async () => {
    const runner: ProcessRunner = { async run() { return successResult(""); } };
    const result = await new AntigravityAdapter(runner).execute({ role: "planner", prompt: "plan", cwd: process.cwd() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("empty response");
  });

  it("allows an Antigravity modifying role to succeed without textual output", async () => {
    const runner: ProcessRunner = { async run() { return successResult(""); } };
    const result = await new AntigravityAdapter(runner).execute({ role: "debugger", prompt: "fix", cwd: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("without a textual response");
  });

  it("turns the Windows headless transcript path log into an actionable diagnostic", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-agy-log-"));
    const log = path.join(root, "provider-logs", "agy.log");
    const runner: ProcessRunner = {
      async run(request) {
        const index = request.args.indexOf("--log-file");
        const filename = request.args[index + 1];
        if (index >= 0 && filename) {
          await writeFile(filename, "failed to write /Users/LKW/.gemini/antigravity-cli/brain/id/transcript.jsonl", "utf8");
        }
        return { ...successResult(""), exitCode: 1, failed: true };
      },
    };
    try {
      const result = await new AntigravityAdapter(runner).execute({
        role: "planner",
        prompt: "plan",
        cwd: root,
        diagnosticLogPath: log,
      });
      expect(result.stderr).toContain("headless transcript path failure");
      expect(result.transcript).toContainEqual(expect.objectContaining({ kind: "diagnostic" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("explains an empty Antigravity failure when no diagnostic log is produced", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-agy-empty-"));
    try {
      const runner: ProcessRunner = {
        async run() {
          return { ...successResult(""), exitCode: 1, failed: true };
        },
      };
      const result = await new AntigravityAdapter(runner).execute({
        role: "planner",
        prompt: "plan",
        cwd: root,
        diagnosticLogPath: path.join(root, "provider-logs", "agy.log"),
      });
      expect(result.stderr).toContain("did not create a diagnostic log");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
