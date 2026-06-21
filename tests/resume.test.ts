import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter } from "../src/adapters/agent-adapter.js";
import type { AdapterRegistry } from "../src/adapters/registry.js";
import { ArtifactStore } from "../src/artifacts.js";
import { defaultConfig } from "../src/config.js";
import type { AgentResult, AgentTask, RoleName } from "../src/domain.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/process-runner.js";
import { WorkflowEngine } from "../src/workflow.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

class Runner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    return {
      exitCode: 0,
      stdout: request.executable === "git" ? "" : "ok",
      stderr: "",
      durationMs: 1,
      failed: false,
      timedOut: false,
      cancelled: false,
    };
  }
}

class FailingImplementer implements AgentAdapter {
  readonly provider = "codex" as const;
  readonly executable = "codex";
  failImplementation = true;
  roles: RoleName[] = [];

  async detect() {
    return { provider: this.provider, status: "INSTALLED" as const, executable: this.executable };
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    this.roles.push(task.role);
    const failed = task.role === "implementer" && this.failImplementation;
    const output =
      task.role === "planner"
        ? '{"summary":"x","steps":["x"],"files":[],"risks":[],"verification":[]}'
        : "ok";
    return {
      provider: this.provider,
      exitCode: failed ? 1 : 0,
      output,
      stdout: output,
      stderr: failed ? "temporary failure" : "",
      durationMs: 1,
      rawEvents: [],
    };
  }

  parseOutput(stdout: string) {
    return { output: stdout, rawEvents: [] };
  }
}

describe("workflow resume", () => {
  it("retries implementation when the failed stage was IMPLEMENTING", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-resume-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src"));
    const config = structuredClone(defaultConfig);
    for (const role of Object.keys(config.agents) as RoleName[]) {
      config.agents[role] = { provider: "codex", fallback: [] };
    }
    config.verification.commands = [];
    const adapter = new FailingImplementer();
    const registry: AdapterRegistry = new Map([["codex", adapter]]);
    const runner = new Runner();
    const store = new ArtifactStore(root);
    const engine = new WorkflowEngine(config, registry, runner, store);

    const planned = await engine.start("request");
    const failed = await engine.respond(planned.id, { kind: "approve" });
    expect(failed.stage).toBe("FAILED");
    expect(failed.failedStage).toBe("IMPLEMENTING");

    adapter.failImplementation = false;
    const resumed = await new WorkflowEngine(config, registry, runner, store).resume(failed.id);
    expect(resumed.status).toBe("awaiting_input");
    expect(resumed.checkpoint).toMatchObject({ completedStep: "IMPLEMENT", nextAction: "VERIFY" });
    expect(adapter.roles.filter((role) => role === "implementer")).toHaveLength(2);
  });
});
