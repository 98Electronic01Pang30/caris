import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter } from "../src/adapters/agent-adapter.js";
import type { AdapterRegistry } from "../src/adapters/registry.js";
import { ArtifactStore } from "../src/artifacts.js";
import { defaultConfig } from "../src/config.js";
import type {
  AgentResult,
  AgentTask,
  CarisConfig,
  ProviderName,
  RoleName,
} from "../src/domain.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/process-runner.js";
import { WorkflowEngine } from "../src/workflow.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

class FakeAdapter implements AgentAdapter {
  readonly executable: string;
  readonly calls: AgentTask[] = [];

  constructor(
    readonly provider: ProviderName,
    private readonly responses: Partial<Record<RoleName, string>>,
    private readonly installed = true,
  ) {
    this.executable = provider;
  }

  async detect() {
    return {
      provider: this.provider,
      status: this.installed ? ("INSTALLED" as const) : ("NOT_INSTALLED" as const),
      executable: this.executable,
      version: "test",
    };
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    this.calls.push(task);
    const output = this.responses[task.role] ?? `${task.role} complete`;
    return {
      provider: this.provider,
      exitCode: 0,
      output,
      stdout: output,
      stderr: "",
      durationMs: 1,
      rawEvents: [],
    };
  }

  parseOutput(stdout: string) {
    return { output: stdout, rawEvents: [] };
  }
}

class FakeProcessRunner implements ProcessRunner {
  verificationExitCodes: number[] = [];

  async run(request: ProcessRequest): Promise<ProcessResult> {
    let exitCode = 0;
    let stdout = "";
    if (request.executable === "git" && request.args[0] === "status") stdout = " M src/example.ts\n";
    if (request.executable === "git" && request.args[0] === "diff") stdout = "diff --git a/a b/a\n";
    if (request.executable.includes("powershell") || request.executable === "/bin/sh") {
      exitCode = this.verificationExitCodes.shift() ?? 0;
    }
    return {
      exitCode,
      stdout,
      stderr: exitCode === 0 ? "" : "test failed",
      durationMs: 1,
      failed: exitCode !== 0,
      timedOut: false,
      cancelled: false,
    };
  }
}

async function fixture(): Promise<{
  root: string;
  config: CarisConfig;
  runner: FakeProcessRunner;
  store: ArtifactStore;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "caris-workflow-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src"));
  const config = structuredClone(defaultConfig);
  for (const role of Object.keys(config.agents) as RoleName[]) {
    config.agents[role] = { provider: "codex", fallback: [] };
  }
  config.verification.commands = ["test-command"];
  const runner = new FakeProcessRunner();
  return { root, config, runner, store: new ArtifactStore(root) };
}

const plan = JSON.stringify({
  summary: "Implement feature",
  steps: ["Change code", "Run tests"],
  files: ["src/example.ts"],
  risks: [],
  verification: ["test-command"],
});

describe("WorkflowEngine", () => {
  it("runs plan, implementation, verification, and review end to end", async () => {
    const { root, config, runner, store } = await fixture();
    const codex = new FakeAdapter("codex", { planner: plan, reviewer: "No findings" });
    const registry: AdapterRegistry = new Map([["codex", codex]]);
    const state = await new WorkflowEngine(config, registry, runner, store).start("Build it");

    expect(state.stage).toBe("DONE");
    expect(state.agentCalls).toBe(3);
    expect(codex.calls.map((call) => call.role)).toEqual(["planner", "implementer", "reviewer"]);
    await expect(readFile(path.join(store.runDir(state.id), "review.md"), "utf8")).resolves.toContain(
      "No findings",
    );
  });

  it("falls back from an unavailable preferred provider", async () => {
    const { config, runner, store } = await fixture();
    config.agents.planner = { provider: "gemini", fallback: ["codex"] };
    const gemini = new FakeAdapter("gemini", {}, false);
    const codex = new FakeAdapter("codex", { planner: plan });
    const registry: AdapterRegistry = new Map([
      ["gemini", gemini],
      ["codex", codex],
    ]);

    const state = await new WorkflowEngine(config, registry, runner, store).start("Build it", true);
    expect(state.stage).toBe("DONE");
    expect(codex.calls).toHaveLength(1);
    expect(gemini.calls).toHaveLength(0);
  });

  it("debugs a failed verification and retries it", async () => {
    const { config, runner, store } = await fixture();
    runner.verificationExitCodes = [1, 0];
    const codex = new FakeAdapter("codex", { planner: plan, debugger: "Fixed", reviewer: "OK" });
    const registry: AdapterRegistry = new Map([["codex", codex]]);

    const state = await new WorkflowEngine(config, registry, runner, store).start("Build it");
    expect(state.stage).toBe("DONE");
    expect(codex.calls.map((call) => call.role)).toEqual([
      "planner",
      "implementer",
      "debugger",
      "reviewer",
    ]);
    expect(state.verification[0]?.exitCode).toBe(0);
  });
});
