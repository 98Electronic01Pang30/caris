import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    private readonly exitCode = 0,
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
      exitCode: this.exitCode,
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
  it("requires approval between plan, implementation, verification, review, and completion", async () => {
    const { root, config, runner, store } = await fixture();
    const codex = new FakeAdapter("codex", { planner: plan, reviewer: "No findings" });
    config.providers.codex = { model: "gpt-test", effort: "high" };
    const registry: AdapterRegistry = new Map([["codex", codex]]);
    const engine = new WorkflowEngine(config, registry, runner, store);
    let state = await engine.start("Build it");

    expect(state.checkpoint).toMatchObject({ completedStep: "PLAN", nextAction: "IMPLEMENT" });
    state = await engine.respond(state.id, { kind: "approve" });
    expect(state.checkpoint).toMatchObject({ completedStep: "IMPLEMENT", nextAction: "VERIFY" });
    state = await engine.respond(state.id, { kind: "approve" });
    expect(state.checkpoint).toMatchObject({ completedStep: "VERIFY", nextAction: "REVIEW" });
    state = await engine.respond(state.id, { kind: "approve" });
    expect(state.checkpoint).toMatchObject({ completedStep: "REVIEW", nextAction: "COMPLETE" });
    state = await engine.respond(state.id, { kind: "approve" });
    expect(state.stage).toBe("DONE");
    expect(state.status).toBe("completed");
    expect(state.agentCalls).toBe(3);
    expect(codex.calls.map((call) => call.role)).toEqual(["planner", "implementer", "reviewer"]);
    expect(codex.calls.every((call) => call.model === "gpt-test" && call.effort === "high")).toBe(true);
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

    const messages: string[] = [];
    const state = await new WorkflowEngine(config, registry, runner, store).start("Build it", true, {
      onEvent: (event) => messages.push(event.message),
    });
    expect(state.status).toBe("awaiting_input");
    expect(state.checkpoint?.nextAction).toBe("COMPLETE");
    expect(codex.calls).toHaveLength(1);
    expect(gemini.calls).toHaveLength(0);
    expect(messages).toContain("planner skipped gemini: NOT_INSTALLED");
  });

  it("debugs a failed verification and retries it", async () => {
    const { config, runner, store } = await fixture();
    runner.verificationExitCodes = [1, 0];
    const codex = new FakeAdapter("codex", { planner: plan, debugger: "Fixed", reviewer: "OK" });
    const registry: AdapterRegistry = new Map([["codex", codex]]);

    const engine = new WorkflowEngine(config, registry, runner, store);
    let state = await engine.start("Build it");
    state = await engine.respond(state.id, { kind: "approve" });
    state = await engine.respond(state.id, { kind: "approve" });
    expect(state.checkpoint).toMatchObject({ completedStep: "VERIFY", nextAction: "DEBUG", verificationFailed: true });
    state = await engine.respond(state.id, { kind: "approve" });
    expect(state.checkpoint).toMatchObject({ completedStep: "DEBUG", nextAction: "VERIFY" });
    state = await engine.respond(state.id, { kind: "approve" });
    state = await engine.respond(state.id, { kind: "approve" });
    state = await engine.respond(state.id, { kind: "approve" });
    expect(state.stage).toBe("DONE");
    expect(codex.calls.map((call) => call.role)).toEqual([
      "planner",
      "implementer",
      "debugger",
      "reviewer",
    ]);
    expect(state.verification[0]?.exitCode).toBe(0);
  });

  it("records a live provider failure before falling back", async () => {
    const { config, runner, store } = await fixture();
    config.agents.planner = { provider: "gemini", fallback: ["codex"] };
    const gemini = new FakeAdapter("gemini", { planner: "auth failed" }, true, 1);
    const codex = new FakeAdapter("codex", { planner: plan });
    config.providers.gemini = { model: "auto" };
    config.providers.codex = { model: "gpt-fallback", effort: "medium" };
    const registry: AdapterRegistry = new Map([
      ["gemini", gemini],
      ["codex", codex],
    ]);
    const messages: string[] = [];

    const state = await new WorkflowEngine(config, registry, runner, store).start("Build it", true, {
      onEvent: (event) => messages.push(event.message),
    });

    expect(state.status).toBe("awaiting_input");
    expect(messages.some((message) => message.includes("gemini failed with exit 1"))).toBe(true);
    expect(codex.calls).toHaveLength(1);
    expect(gemini.calls[0]).toMatchObject({ model: "auto" });
    expect(codex.calls[0]).toMatchObject({ model: "gpt-fallback", effort: "medium" });
  });

  it("attaches structured file mentions to the planner prompt and run state", async () => {
    const { root, config, runner, store } = await fixture();
    await writeFile(path.join(root, "src", "mentioned.log"), "important failure detail", "utf8");
    const codex = new FakeAdapter("codex", { planner: plan });
    const registry: AdapterRegistry = new Map([["codex", codex]]);

    const state = await new WorkflowEngine(config, registry, runner, store).start("Inspect the log", true, {
      mentionedFiles: ["src/mentioned.log"],
    });

    expect(state.mentionedFiles).toEqual(["src/mentioned.log"]);
    expect(codex.calls[0]?.prompt).toContain("important failure detail");
    await expect(readFile(path.join(store.runDir(state.id), "requested-files.md"), "utf8")).resolves.toContain(
      "mentioned.log",
    );
  });

  it("pauses and restores an approval checkpoint", async () => {
    const { config, runner, store } = await fixture();
    const codex = new FakeAdapter("codex", { planner: plan });
    const engine = new WorkflowEngine(config, new Map([["codex", codex]]), runner, store);
    let state = await engine.start("Build it");
    state = await engine.respond(state.id, { kind: "pause" });
    expect(state.status).toBe("paused");
    state = await new WorkflowEngine(config, new Map([["codex", codex]]), runner, store).resume(state.id);
    expect(state.status).toBe("awaiting_input");
    expect(state.checkpoint?.nextAction).toBe("IMPLEMENT");
  });

  it("uses custom feedback to revise the completed step", async () => {
    const { config, runner, store } = await fixture();
    const codex = new FakeAdapter("codex", { planner: plan });
    const engine = new WorkflowEngine(config, new Map([["codex", codex]]), runner, store);
    let state = await engine.start("Build it");
    state = await engine.respond(state.id, { kind: "feedback", message: "Include migration risks" });
    expect(codex.calls.map((call) => call.role)).toEqual(["planner", "planner"]);
    expect(codex.calls[1]?.prompt).toContain("Include migration risks");
    expect(state.feedback).toHaveLength(1);
    expect(state.checkpoint?.completedStep).toBe("PLAN");
  });

  it("routes verification feedback through implementation and verifies again", async () => {
    const { config, runner, store } = await fixture();
    const codex = new FakeAdapter("codex", { planner: plan });
    const engine = new WorkflowEngine(config, new Map([["codex", codex]]), runner, store);
    let state = await engine.start("Build it");
    state = await engine.respond(state.id, { kind: "approve" });
    state = await engine.respond(state.id, { kind: "approve" });
    state = await engine.respond(state.id, { kind: "feedback", message: "Add an edge-case check" });
    expect(codex.calls.filter((call) => call.role === "implementer")).toHaveLength(2);
    expect(codex.calls.at(-1)?.prompt).toContain("Add an edge-case check");
    expect(state.checkpoint).toMatchObject({ completedStep: "VERIFY", nextAction: "REVIEW" });
  });

  it("runs manual roles independently while sharing the current run context", async () => {
    const { config, runner, store } = await fixture();
    const codex = new FakeAdapter("codex", { planner: plan, verifier: "PASS" });
    const engine = new WorkflowEngine(config, new Map([["codex", codex]]), runner, store);
    let state = await engine.startManual("PLAN", "Build it");
    expect(state.executionMode).toBe("manual");
    expect(state.status).toBe("idle");
    expect(codex.calls.map((call) => call.role)).toEqual(["planner"]);

    state = await engine.executeManual(state.id, "IMPLEMENT", "Implement the plan");
    expect(codex.calls.map((call) => call.role)).toEqual(["planner", "implementer"]);
    expect(codex.calls[1]?.prompt).toContain("Implement feature");

    state = await engine.executeManual(state.id, "VERIFY", "Verify the implemented behavior");
    expect(codex.calls.map((call) => call.role)).toEqual(["planner", "implementer", "verifier"]);
    expect(codex.calls.some((call) => call.role === "debugger")).toBe(false);
    expect(codex.calls[2]?.prompt).toContain("Implement the plan");
    expect(state.stepHistory.map((item) => item.step)).toEqual(["PLAN", "IMPLEMENT", "VERIFY"]);
    await expect(readFile(path.join(store.runDir(state.id), "verification-report-3.md"), "utf8")).resolves.toContain("PASS");
  });

  it("warns but proceeds when a manual step has no prerequisite artifact", async () => {
    const { config, runner, store } = await fixture();
    const codex = new FakeAdapter("codex", {});
    const messages: string[] = [];
    const state = await new WorkflowEngine(config, new Map([["codex", codex]]), runner, store)
      .startManual("DEBUG", "Investigate directly", { onEvent: (event) => messages.push(event.message) });
    expect(state.status).toBe("idle");
    expect(codex.calls.map((call) => call.role)).toEqual(["debugger"]);
    expect(messages).toContain("Warning: debugging without verification results");
  });

  it("resumes a manual run as context without executing another role", async () => {
    const { config, runner, store } = await fixture();
    const codex = new FakeAdapter("codex", { planner: plan });
    const engine = new WorkflowEngine(config, new Map([["codex", codex]]), runner, store);
    const state = await engine.startManual("PLAN", "Build it");
    const resumed = await new WorkflowEngine(config, new Map([["codex", codex]]), runner, store).resume(state.id);
    expect(resumed.id).toBe(state.id);
    expect(codex.calls).toHaveLength(1);
  });
});
