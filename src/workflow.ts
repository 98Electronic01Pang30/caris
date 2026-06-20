import YAML from "yaml";
import { ArtifactStore } from "./artifacts.js";
import type { AdapterRegistry } from "./adapters/registry.js";
import type { AgentAdapter } from "./adapters/agent-adapter.js";
import type {
  AgentResult,
  CarisConfig,
  ProviderHealth,
  ProviderName,
  RoleName,
  RunStage,
  RunState,
  TaskPlan,
} from "./domain.js";
import { taskPlanSchema } from "./domain.js";
import {
  debuggerPrompt,
  implementerPrompt,
  plannerPrompt,
  reviewerPrompt,
} from "./prompts.js";
import type { ProcessRunner } from "./process-runner.js";
import { captureWorkspaceDiff, summarizeRepository } from "./repository.js";
import { formatRequestedFiles, readRequestedFiles } from "./requested-files.js";
import { VerificationRunner } from "./verifier.js";
import { classifyProviderFailure, summarizeAgentFailure } from "./provider-health.js";

export interface WorkflowEvent {
  runId: string;
  stage: RunStage;
  message: string;
}

export interface WorkflowOptions {
  onEvent?: (event: WorkflowEvent) => void;
  signal?: AbortSignal;
  mentionedFiles?: string[];
}

export class WorkflowEngine {
  private readonly verifier: VerificationRunner;
  private readonly health = new Map<ProviderName, ProviderHealth>();

  constructor(
    private readonly config: CarisConfig,
    private readonly adapters: AdapterRegistry,
    private readonly runner: ProcessRunner,
    private readonly store: ArtifactStore,
  ) {
    this.verifier = new VerificationRunner(runner);
  }

  async start(request: string, planOnly = false, options: WorkflowOptions = {}): Promise<RunState> {
    if (!request.trim()) throw new Error("Request cannot be empty");
    const state = await this.store.createRun(
      request.trim(),
      planOnly,
      options.mentionedFiles ?? [],
    );
    await this.store.writeText(state.id, "config.snapshot.yaml", YAML.stringify(this.config));
    return this.execute(state, options);
  }

  async resume(id: string, options: WorkflowOptions = {}): Promise<RunState> {
    const state = await this.store.loadState(id);
    if (["DONE", "CANCELLED"].includes(state.stage)) return state;
    state.stage = resumableStage(state.failedStage ?? state.stage, state.plan !== undefined);
    delete state.failedStage;
    delete state.error;
    await this.store.saveState(state);
    return this.execute(state, options);
  }

  private async execute(state: RunState, options: WorkflowOptions): Promise<RunState> {
    try {
      this.checkCancelled(options.signal);
      if (!state.plan) await this.plan(state, options);
      if (state.planOnly) return this.finish(state, options, "Planning completed");

      if (["PLANNED", "IMPLEMENTING"].includes(state.stage)) {
        await this.implement(state, options);
      }
      if (["IMPLEMENTED", "VERIFYING", "DEBUGGING"].includes(state.stage)) {
        await this.verifyAndDebug(state, options);
      }
      if (state.stage === "REVIEWING") {
        await this.review(state, options);
      } else if (state.stage === "IMPLEMENTED") {
        await this.review(state, options);
      }
      return this.finish(state, options, "Workflow completed");
    } catch (error) {
      const cancelled = options.signal?.aborted ?? false;
      state.failedStage = state.stage;
      state.stage = cancelled ? "CANCELLED" : "FAILED";
      state.error = error instanceof Error ? error.message : String(error);
      await this.store.saveState(state);
      await this.emit(state, options, state.error);
      return state;
    }
  }

  private async plan(state: RunState, options: WorkflowOptions): Promise<void> {
    await this.setStage(state, "PLANNING", options, "Creating implementation plan");
    const repository = await summarizeRepository(state.cwd);
    await this.store.writeText(state.id, "repo-summary.md", `${repository}\n`);
    const requestedFiles = await readRequestedFiles(
      state.request,
      state.cwd,
      Math.floor(this.config.budgets.maxContextCharsPerCall * 0.6),
      state.mentionedFiles,
    );
    const requestedContext = formatRequestedFiles(requestedFiles);
    if (requestedContext) {
      await this.store.writeText(state.id, "requested-files.md", `${requestedContext}\n`);
    }
    const result = await this.callRole(
      state,
      "planner",
      plannerPrompt(state.request, repository, requestedContext),
      options,
    );
    state.plan = parsePlan(result.output, state.request);
    await this.store.writeText(state.id, "plan.json", `${JSON.stringify(state.plan, null, 2)}\n`);
    await this.setStage(state, "PLANNED", options, "Plan created");
  }

  private async implement(state: RunState, options: WorkflowOptions): Promise<void> {
    const plan = requirePlan(state);
    await this.setStage(state, "IMPLEMENTING", options, "Implementing changes");
    const result = await this.callRole(
      state,
      "implementer",
      implementerPrompt(state.request, plan),
      options,
    );
    await this.store.writeText(state.id, "implementation.md", `${result.output}\n`);
    const diff = await captureWorkspaceDiff(state.cwd, this.runner);
    await this.store.writeText(state.id, "changes.patch", diff);
    await this.setStage(state, "IMPLEMENTED", options, "Implementation completed");
  }

  private async verifyAndDebug(state: RunState, options: WorkflowOptions): Promise<void> {
    const plan = requirePlan(state);
    let attempt = 0;
    while (true) {
      await this.setStage(state, "VERIFYING", options, "Running configured verification");
      state.verification = await this.verifier.run(this.config.verification.commands, state.cwd);
      await this.store.writeText(
        state.id,
        "verification.json",
        `${JSON.stringify(state.verification, null, 2)}\n`,
      );
      await this.store.saveState(state);
      const failed = state.verification.some((result) => result.exitCode !== 0);
      if (!failed) {
        state.stage = "IMPLEMENTED";
        await this.store.saveState(state);
        return;
      }
      if (attempt >= this.config.budgets.maxRetriesPerStep) {
        throw new Error(`Verification failed after ${attempt + 1} attempt(s)`);
      }
      attempt += 1;
      await this.setStage(state, "DEBUGGING", options, `Debugging verification failure (${attempt})`);
      const result = await this.callRole(
        state,
        "debugger",
        debuggerPrompt(state.request, plan, state.verification),
        options,
      );
      await this.store.writeText(state.id, `debug-${attempt}.md`, `${result.output}\n`);
      await this.store.writeText(
        state.id,
        "changes.patch",
        await captureWorkspaceDiff(state.cwd, this.runner),
      );
    }
  }

  private async review(state: RunState, options: WorkflowOptions): Promise<void> {
    const plan = requirePlan(state);
    await this.setStage(state, "REVIEWING", options, "Reviewing changes");
    const diff = await captureWorkspaceDiff(state.cwd, this.runner);
    const result = await this.callRole(
      state,
      "reviewer",
      reviewerPrompt(state.request, plan, diff),
      options,
    );
    await this.store.writeText(state.id, "review.md", `${result.output}\n`);
  }

  private async callRole(
    state: RunState,
    role: RoleName,
    prompt: string,
    options: WorkflowOptions,
  ): Promise<AgentResult> {
    this.checkBudget(state, prompt);
    const candidates = this.providerCandidates(role);
    const failures: string[] = [];
    for (const provider of candidates) {
      const adapter = this.adapters.get(provider);
      if (!adapter) continue;
      const health = await this.getHealth(adapter, state.cwd);
      if (!isUsable(health)) {
        failures.push(`${provider}: ${health.status}`);
        await this.emit(
          state,
          options,
          `${role} skipped ${provider}: ${health.status}${health.detail ? ` (${health.detail})` : ""}`,
        );
        continue;
      }

      state.agentCalls += 1;
      await this.store.saveState(state);
      await this.emit(state, options, `${role} -> ${provider}`);
      const startedAt = new Date().toISOString();
      const result = await adapter.execute({
        role,
        prompt,
        cwd: state.cwd,
        timeoutMs: this.remainingTimeMs(state),
        ...(this.config.providers[provider].model
          ? { model: this.config.providers[provider].model }
          : {}),
        ...(provider !== "gemini" && this.config.providers[provider].effort
          ? { effort: this.config.providers[provider].effort }
          : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      await this.store.appendUsage(state.id, {
        provider,
        role,
        startedAt,
        durationMs: result.durationMs,
        inputChars: prompt.length,
        outputChars: result.stdout.length + result.stderr.length,
        exitCode: result.exitCode,
      });
      await this.store.writeText(
        state.id,
        `${String(state.agentCalls).padStart(2, "0")}-${role}-${provider}.json`,
        `${JSON.stringify(result, null, 2)}\n`,
      );
      if (result.exitCode === 0) return result;
      const failure = summarizeAgentFailure(result);
      failures.push(`${provider}: ${failure}`);
      await this.emit(
        state,
        options,
        `${role} provider ${provider} failed with exit ${result.exitCode}: ${failure}`,
      );
      this.health.set(provider, {
        ...health,
        status: classifyProviderFailure(result),
        detail: summarizeAgentFailure(result),
      });
      this.checkBudget(state, prompt);
    }
    throw new Error(`No provider completed role ${role}. ${failures.join("; ")}`);
  }

  private providerCandidates(role: RoleName): ProviderName[] {
    const roleConfig = this.config.agents[role];
    const preferred: ProviderName[] =
      roleConfig.provider === "auto"
        ? ["codex", "claude", "gemini"]
        : [roleConfig.provider];
    return [...new Set([...preferred, ...roleConfig.fallback])];
  }

  private async getHealth(adapter: AgentAdapter, cwd: string): Promise<ProviderHealth> {
    const cached = this.health.get(adapter.provider);
    if (cached) return cached;
    const health = await adapter.detect(cwd);
    this.health.set(adapter.provider, health);
    return health;
  }

  private checkBudget(state: RunState, prompt: string): void {
    if (state.agentCalls >= this.config.budgets.maxAgentCalls) {
      throw new Error(`Agent call budget exhausted (${state.agentCalls})`);
    }
    if (prompt.length > this.config.budgets.maxContextCharsPerCall) {
      throw new Error(
        `Context budget exceeded (${prompt.length}/${this.config.budgets.maxContextCharsPerCall} chars)`,
      );
    }
    const elapsed = Date.now() - Date.parse(state.createdAt);
    if (elapsed > this.config.budgets.maxWallTimeMinutes * 60_000) {
      throw new Error("Wall-time budget exhausted");
    }
  }

  private checkCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("Run cancelled");
  }

  private remainingTimeMs(state: RunState): number {
    const budgetMs = this.config.budgets.maxWallTimeMinutes * 60_000;
    return Math.max(1, budgetMs - (Date.now() - Date.parse(state.createdAt)));
  }

  private async setStage(
    state: RunState,
    stage: RunStage,
    options: WorkflowOptions,
    message: string,
  ): Promise<void> {
    this.checkCancelled(options.signal);
    state.stage = stage;
    await this.store.saveState(state);
    await this.emit(state, options, message);
  }

  private async finish(
    state: RunState,
    options: WorkflowOptions,
    message: string,
  ): Promise<RunState> {
    state.stage = "DONE";
    await this.store.saveState(state);
    await this.emit(state, options, message);
    return state;
  }

  private async emit(
    state: RunState,
    options: WorkflowOptions,
    message: string,
  ): Promise<void> {
    const event = { runId: state.id, stage: state.stage, message };
    await this.store.appendEvent(state.id, event);
    options.onEvent?.(event);
  }
}

function requirePlan(state: RunState): TaskPlan {
  if (!state.plan) throw new Error("Run has no plan");
  return state.plan;
}

function parsePlan(output: string, request: string): TaskPlan {
  const candidates = [output, extractCodeFence(output), extractJsonObject(output)].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of candidates) {
    try {
      return taskPlanSchema.parse(JSON.parse(candidate));
    } catch {
      // Try the next representation before creating a conservative fallback.
    }
  }
  return {
    summary: output.trim() || request,
    steps: ["Inspect the relevant code", "Implement the requested change", "Verify the result"],
    files: [],
    risks: ["Planner did not return structured JSON"],
    verification: [],
  };
}

function extractCodeFence(value: string): string | undefined {
  return value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
}

function extractJsonObject(value: string): string | undefined {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start >= 0 && end > start ? value.slice(start, end + 1) : undefined;
}

function isUsable(health: ProviderHealth): boolean {
  return health.status === "INSTALLED" || health.status === "READY";
}

function resumableStage(stage: RunStage, hasPlan: boolean): RunStage {
  if (!hasPlan || stage === "PLANNING" || stage === "RECEIVED") return "RECEIVED";
  if (["IMPLEMENTING", "PLANNED"].includes(stage)) return "PLANNED";
  return "IMPLEMENTED";
}
