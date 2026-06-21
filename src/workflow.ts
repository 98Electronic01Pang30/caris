import YAML from "yaml";
import { ArtifactStore } from "./artifacts.js";
import type { AdapterRegistry } from "./adapters/registry.js";
import type { AgentAdapter } from "./adapters/agent-adapter.js";
import type {
  AgentResult,
  AgentTranscriptItem,
  CarisConfig,
  ProviderHealth,
  ProviderName,
  RoleName,
  ManualStep,
  StepExecution,
  RunCheckpoint,
  RunStage,
  RunState,
  TaskPlan,
  WorkflowAction,
  WorkflowResponse,
} from "./domain.js";
import { taskPlanSchema } from "./domain.js";
import {
  debuggerPrompt,
  implementerPrompt,
  plannerPrompt,
  reviewerPrompt,
  verifierPrompt,
} from "./prompts.js";
import type { ProcessRunner } from "./process-runner.js";
import { captureWorkspaceDiff, detectWorkspaceContext, summarizeRepository } from "./repository.js";
import { formatRequestedFiles, readRequestedFiles } from "./requested-files.js";
import { VerificationRunner } from "./verifier.js";
import { classifyProviderFailure, summarizeAgentFailure } from "./provider-health.js";
import { formatAgentTranscript, formatTranscriptItem } from "./transcript-format.js";

export interface WorkflowEvent {
  runId: string;
  stage: RunStage;
  message: string;
  kind?: "status" | "agent_transcript" | "workspace_diff" | "provider_error";
  provider?: ProviderName;
  role?: RoleName;
  transcriptItem?: AgentTranscriptItem;
  agentCallId?: number;
}

export interface WorkflowOptions {
  onEvent?: (event: WorkflowEvent) => void;
  signal?: AbortSignal;
  mentionedFiles?: string[];
  allowNonGitWrite?: boolean;
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
    const workspaceContext = await detectWorkspaceContext(this.store.projectRoot, this.runner);
    const state = await this.store.createRun(
      request.trim(),
      planOnly,
      options.mentionedFiles ?? [],
      "pipeline",
      workspaceContext,
    );
    await this.emitWorkspaceMode(state, options);
    await this.store.writeText(state.id, "config.snapshot.yaml", YAML.stringify(this.config));
    return this.runSafely(state, options, async () => {
      await this.plan(state, options);
      await this.waitForInput(state, options, {
        completedStep: "PLAN",
        nextAction: planOnly ? "COMPLETE" : "IMPLEMENT",
        message: planOnly ? "Approve the plan to complete this run" : "Approve the plan to begin implementation",
        verificationFailed: false,
      });
    });
  }

  async startManual(step: ManualStep, instruction: string, options: WorkflowOptions = {}): Promise<RunState> {
    const request = instruction.trim() || `${step.toLowerCase()} the current workspace`;
    const workspaceContext = await detectWorkspaceContext(this.store.projectRoot, this.runner);
    const state = await this.store.createRun(request, false, options.mentionedFiles ?? [], "manual", workspaceContext);
    await this.emitWorkspaceMode(state, options);
    await this.store.writeText(state.id, "config.snapshot.yaml", YAML.stringify(this.config));
    return this.executeManualState(state, step, instruction.trim(), options);
  }

  async executeManual(id: string, step: ManualStep, instruction: string, options: WorkflowOptions = {}): Promise<RunState> {
    const state = await this.store.loadState(id);
    await this.ensureWorkspaceContext(state);
    if (state.executionMode !== "manual") throw new Error(`Run ${id} is not a manual run`);
    return this.executeManualState(state, step, instruction.trim(), options);
  }

  async resume(id: string, options: WorkflowOptions = {}): Promise<RunState> {
    const state = await this.store.loadState(id);
    await this.ensureWorkspaceContext(state);
    if (state.executionMode === "manual") return state;
    if (["completed", "cancelled"].includes(state.status)) return state;
    if (state.status === "paused" && state.checkpoint) {
      state.status = "awaiting_input";
      await this.store.saveState(state);
      await this.emit(state, options, state.checkpoint.message);
      return state;
    }
    if (state.status === "awaiting_input") return state;
    if (!state.plan) {
      return this.runSafely(state, options, async () => {
        this.beginActive(state);
        await this.plan(state, options);
        await this.waitForInput(state, options, { completedStep: "PLAN", nextAction: state.planOnly ? "COMPLETE" : "IMPLEMENT", message: "Approve the recovered plan to continue", verificationFailed: false });
      });
    }
    if (state.failedStage === "PLANNING") {
      return this.runSafely(state, options, async () => {
        this.beginActive(state);
        await this.plan(state, options);
        await this.waitForInput(state, options, { completedStep: "PLAN", nextAction: state.planOnly ? "COMPLETE" : "IMPLEMENT", message: "Approve the recovered plan to continue", verificationFailed: false });
      });
    }
    const action: WorkflowAction = state.checkpoint?.nextAction ?? actionForStage(state.failedStage ?? state.stage);
    return this.performAction(state, action, options);
  }

  async respond(id: string, response: WorkflowResponse, options: WorkflowOptions = {}): Promise<RunState> {
    const state = await this.store.loadState(id);
    await this.ensureWorkspaceContext(state);
    if (!state.checkpoint || !["awaiting_input", "paused"].includes(state.status)) {
      throw new Error(`Run ${id} is not waiting for input`);
    }
    if (response.kind === "pause") {
      state.status = "paused";
      await this.store.saveState(state);
      await this.emit(state, options, "Run paused; use resume to continue from this checkpoint");
      return state;
    }
    if (response.kind === "feedback") {
      const message = response.message.trim();
      if (!message) throw new Error("Feedback cannot be empty");
      state.feedback.push({ step: state.checkpoint.completedStep, message, createdAt: new Date().toISOString() });
      await this.store.saveState(state);
      return this.rework(state, state.checkpoint.completedStep, message, options);
    }
    return this.performAction(state, state.checkpoint.nextAction, options);
  }

  private async performAction(state: RunState, action: WorkflowAction, options: WorkflowOptions): Promise<RunState> {
    return this.runSafely(state, options, async () => {
      this.beginActive(state);
      state.status = "running";
      delete state.checkpoint;
      delete state.error;
      delete state.failedStage;
      await this.store.saveState(state);
      if (action === "IMPLEMENT") {
        await this.implement(state, options);
        await this.waitForInput(state, options, { completedStep: "IMPLEMENT", nextAction: "VERIFY", message: "Approve the implementation to run verification", verificationFailed: false });
      } else if (action === "VERIFY") {
        await this.verify(state, options);
      } else if (action === "DEBUG") {
        await this.debug(state, options);
      } else if (action === "REVIEW") {
        await this.review(state, options);
        await this.waitForInput(state, options, { completedStep: "REVIEW", nextAction: "COMPLETE", message: "Approve the review to complete this run", verificationFailed: false });
      } else {
        await this.finish(state, options, "Workflow completed");
      }
    });
  }

  private async rework(state: RunState, step: RunCheckpoint["completedStep"], feedback: string, options: WorkflowOptions): Promise<RunState> {
    return this.runSafely(state, options, async () => {
      this.beginActive(state);
      state.status = "running";
      delete state.checkpoint;
      await this.store.saveState(state);
      if (step === "PLAN") {
        await this.plan(state, options, feedback);
        await this.waitForInput(state, options, { completedStep: "PLAN", nextAction: state.planOnly ? "COMPLETE" : "IMPLEMENT", message: "Review the revised plan", verificationFailed: false });
      } else if (step === "IMPLEMENT" || step === "VERIFY") {
        await this.implement(state, options, feedback);
        if (step === "VERIFY") await this.verify(state, options);
        else await this.waitForInput(state, options, { completedStep: "IMPLEMENT", nextAction: "VERIFY", message: "Review the revised implementation", verificationFailed: false });
      } else if (step === "DEBUG") {
        await this.debug(state, options, feedback);
      } else {
        await this.review(state, options, feedback);
        await this.waitForInput(state, options, { completedStep: "REVIEW", nextAction: "COMPLETE", message: "Review the revised review", verificationFailed: false });
      }
    });
  }

  private async runSafely(state: RunState, options: WorkflowOptions, work: () => Promise<void>): Promise<RunState> {
    try {
      await work();
      return state;
    } catch (error) {
      this.settleActive(state);
      const cancelled = options.signal?.aborted ?? false;
      state.failedStage = state.stage;
      state.stage = cancelled ? "CANCELLED" : "FAILED";
      state.status = cancelled ? "cancelled" : "failed";
      state.error = error instanceof Error ? error.message : String(error);
      await this.store.saveState(state);
      await this.emit(state, options, state.error);
      return state;
    }
  }

  private async executeManualState(state: RunState, step: ManualStep, instruction: string, options: WorkflowOptions): Promise<RunState> {
    const index = state.stepHistory.length + 1;
    const role = manualRole(step);
    const execution: StepExecution = {
      index,
      step,
      role,
      instruction,
      status: "running" as const,
      startedAt: new Date().toISOString(),
      artifacts: [] as string[],
    };
    state.stepHistory.push(execution);
    state.status = "running";
    delete state.error;
    this.beginActive(state);
    await this.store.saveState(state);
    await this.emit(state, options, `${step.toLowerCase()} manual step started`);
    try {
      let result: AgentResult;
      if (step === "PLAN") {
        result = await this.plan(state, options, instruction || undefined);
        const name = `plan-${index}.json`;
        await this.store.writeText(state.id, name, `${JSON.stringify(state.plan, null, 2)}\n`);
        execution.artifacts.push(name, "plan.json");
      } else if (step === "IMPLEMENT") {
        if (!state.plan) await this.emit(state, options, "Warning: implementing without a plan");
        result = await this.manualImplement(state, instruction, options);
        execution.artifacts.push(`implementation-${index}.md`, `changes-${index}.patch`, "implementation.md", "changes.patch");
        await this.store.writeText(state.id, `implementation-${index}.md`, `${result.output}\n`);
        await this.store.writeText(state.id, `changes-${index}.patch`, await captureWorkspaceDiff(state.cwd, this.runner, state.workspaceContext));
      } else if (step === "DEBUG") {
        if (state.verification.length === 0) await this.emit(state, options, "Warning: debugging without verification results");
        result = await this.manualDebug(state, instruction, options);
        execution.artifacts.push(`debug-${index}.md`, `changes-${index}.patch`, "changes.patch");
        await this.store.writeText(state.id, `debug-${index}.md`, `${result.output}\n`);
        await this.store.writeText(state.id, `changes-${index}.patch`, await captureWorkspaceDiff(state.cwd, this.runner, state.workspaceContext));
      } else if (step === "VERIFY") {
        result = await this.manualVerify(state, instruction, options);
        execution.artifacts.push(`verification-${index}.json`, `verification-report-${index}.md`, "verification.json", "verification-report.md");
        await this.store.writeText(state.id, `verification-${index}.json`, `${JSON.stringify(state.verification, null, 2)}\n`);
        await this.store.writeText(state.id, `verification-report-${index}.md`, `${result.output}\n`);
      } else {
        if (!state.plan) await this.emit(state, options, "Warning: reviewing without a plan");
        result = await this.manualReview(state, instruction, options);
        execution.artifacts.push(`review-${index}.md`, "review.md");
        await this.store.writeText(state.id, `review-${index}.md`, `${result.output}\n`);
      }
      execution.provider = result.provider;
      execution.status = "succeeded";
      execution.finishedAt = new Date().toISOString();
      this.settleActive(state);
      state.status = "idle";
      await this.store.saveState(state);
      await this.emit(state, options, `${step.toLowerCase()} manual step completed`);
      return state;
    } catch (error) {
      execution.status = "failed";
      execution.finishedAt = new Date().toISOString();
      execution.error = error instanceof Error ? error.message : String(error);
      this.settleActive(state);
      state.status = "idle";
      state.error = execution.error;
      await this.store.saveState(state);
      await this.emit(state, options, execution.error);
      return state;
    }
  }

  private async plan(state: RunState, options: WorkflowOptions, feedback?: string): Promise<AgentResult> {
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
      withFeedback(plannerPrompt(state.request, repository, requestedContext), feedback, state.plan),
      options,
    );
    state.plan = parsePlan(result.output, state.request);
    await this.store.writeText(state.id, "plan.json", `${JSON.stringify(state.plan, null, 2)}\n`);
    await this.setStage(state, "PLANNED", options, "Plan created");
    return result;
  }

  private async implement(state: RunState, options: WorkflowOptions, feedback?: string): Promise<AgentResult> {
    const plan = requirePlan(state);
    await this.setStage(state, "IMPLEMENTING", options, "Implementing changes");
    const result = await this.callRole(
      state,
      "implementer",
      withFeedback(implementerPrompt(state.request, plan), feedback),
      options,
    );
    await this.store.writeText(state.id, "implementation.md", `${result.output}\n`);
    const diff = await captureWorkspaceDiff(state.cwd, this.runner, state.workspaceContext);
    await this.store.writeText(state.id, "changes.patch", diff);
    await this.setStage(state, "IMPLEMENTED", options, "Implementation completed");
    return result;
  }

  private async manualImplement(state: RunState, instruction: string, options: WorkflowOptions): Promise<AgentResult> {
    const plan = state.plan ?? { summary: state.request, steps: [instruction || state.request], files: [], risks: [], verification: [] };
    await this.setStage(state, "IMPLEMENTING", options, "Running implementer role");
    const result = await this.callRole(state, "implementer", withFeedback(implementerPrompt(state.request, plan), instruction || undefined), options);
    await this.store.writeText(state.id, "implementation.md", `${result.output}\n`);
    await this.store.writeText(state.id, "changes.patch", await captureWorkspaceDiff(state.cwd, this.runner, state.workspaceContext));
    await this.setStage(state, "IMPLEMENTED", options, "Implementation role completed");
    return result;
  }

  private async manualDebug(state: RunState, instruction: string, options: WorkflowOptions): Promise<AgentResult> {
    const plan = state.plan ?? { summary: state.request, steps: [instruction || state.request], files: [], risks: [], verification: [] };
    await this.setStage(state, "DEBUGGING", options, "Running debugger role");
    const result = await this.callRole(state, "debugger", withFeedback(debuggerPrompt(state.request, plan, state.verification), instruction || undefined), options);
    await this.store.writeText(state.id, "debug.md", `${result.output}\n`);
    await this.store.writeText(state.id, "changes.patch", await captureWorkspaceDiff(state.cwd, this.runner, state.workspaceContext));
    return result;
  }

  private async manualVerify(state: RunState, instruction: string, options: WorkflowOptions): Promise<AgentResult> {
    await this.setStage(state, "VERIFYING", options, "Running configured verification for latest changes");
    state.verification = await this.verifier.run(this.config.verification.commands, state.cwd);
    await this.store.writeText(state.id, "verification.json", `${JSON.stringify(state.verification, null, 2)}\n`);
    const diff = await captureWorkspaceDiff(state.cwd, this.runner, state.workspaceContext);
    const changeInstruction = [...state.stepHistory].reverse().find((item) => item.step === "IMPLEMENT" || item.step === "DEBUG")?.instruction ?? "";
    const result = await this.callRole(state, "verifier", verifierPrompt(state.request, instruction, changeInstruction, diff, state.verification), options);
    await this.store.writeText(state.id, "verification-report.md", `${result.output}\n`);
    return result;
  }

  private async manualReview(state: RunState, instruction: string, options: WorkflowOptions): Promise<AgentResult> {
    const plan = state.plan ?? { summary: state.request, steps: [instruction || state.request], files: [], risks: [], verification: [] };
    await this.setStage(state, "REVIEWING", options, "Running reviewer role");
    const diff = await captureWorkspaceDiff(state.cwd, this.runner, state.workspaceContext);
    const result = await this.callRole(state, "reviewer", withFeedback(reviewerPrompt(state.request, plan, diff), instruction || undefined), options);
    await this.store.writeText(state.id, "review.md", `${result.output}\n`);
    return result;
  }

  private async verify(state: RunState, options: WorkflowOptions): Promise<void> {
    await this.setStage(state, "VERIFYING", options, "Running configured verification");
    state.verification = await this.verifier.run(this.config.verification.commands, state.cwd);
    await this.store.writeText(state.id, "verification.json", `${JSON.stringify(state.verification, null, 2)}\n`);
    const failed = state.verification.some((result) => result.exitCode !== 0);
    await this.waitForInput(state, options, {
      completedStep: "VERIFY",
      nextAction: failed ? "DEBUG" : "REVIEW",
      message: failed ? "Verification failed; approve to start debugging" : "Verification passed; approve to start review",
      verificationFailed: failed,
    });
  }

  private async debug(state: RunState, options: WorkflowOptions, feedback?: string): Promise<void> {
    if (state.debugAttempts >= this.config.budgets.maxRetriesPerStep) {
      throw new Error(`Verification retry budget exhausted (${state.debugAttempts})`);
    }
    state.debugAttempts += 1;
    await this.setStage(state, "DEBUGGING", options, `Debugging verification failure (${state.debugAttempts})`);
    const result = await this.callRole(state, "debugger", withFeedback(debuggerPrompt(state.request, requirePlan(state), state.verification), feedback), options);
    await this.store.writeText(state.id, `debug-${state.debugAttempts}.md`, `${result.output}\n`);
    await this.store.writeText(state.id, "changes.patch", await captureWorkspaceDiff(state.cwd, this.runner, state.workspaceContext));
    await this.waitForInput(state, options, { completedStep: "DEBUG", nextAction: "VERIFY", message: "Approve the debug changes to rerun verification", verificationFailed: true });
  }

  private async review(state: RunState, options: WorkflowOptions, feedback?: string): Promise<AgentResult> {
    const plan = requirePlan(state);
    await this.setStage(state, "REVIEWING", options, "Reviewing changes");
    const diff = await captureWorkspaceDiff(state.cwd, this.runner, state.workspaceContext);
    const result = await this.callRole(
      state,
      "reviewer",
      withFeedback(reviewerPrompt(state.request, plan, diff), feedback),
      options,
    );
    await this.store.writeText(state.id, "review.md", `${result.output}\n`);
    return result;
  }

  private async callRole(
    state: RunState,
    role: RoleName,
    prompt: string,
    options: WorkflowOptions,
  ): Promise<AgentResult> {
    await this.ensureWorkspaceContext(state);
    if (isModifyingRole(role) && state.workspaceContext?.kind === "directory" && !options.allowNonGitWrite) {
      throw new Error(
        "This is not a Git repository. Implementer and debugger can modify files without Git diff or recovery. " +
        "Confirm the session warning or use --allow-non-git-write for a non-interactive command.",
      );
    }
    this.checkBudget(state, prompt);
    const candidates = this.providerCandidates(role);
    const failures: string[] = [];
    for (const provider of candidates) {
      const adapter = this.adapters.get(provider);
      if (!adapter) continue;
      const health = await this.getHealth(adapter, state.cwd);
      if (!isUsable(health)) {
        failures.push(`${provider}: ${health.status}`);
        await this.emitDetailed(state, options, {
          kind: "provider_error",
          provider,
          role,
          message: `${role} skipped ${provider}: ${health.status}${health.detail ? ` (${health.detail})` : ""}`,
        });
        continue;
      }

      state.agentCalls += 1;
      await this.store.saveState(state);
      await this.emit(state, options, `${role} -> ${provider}`);
      const startedAt = new Date().toISOString();
      const beforeDiff = isModifyingRole(role) ? await captureWorkspaceDiff(state.cwd, this.runner, state.workspaceContext) : undefined;
      const providerConfig = this.config.providers[provider];
      const effort = "effort" in providerConfig && typeof providerConfig.effort === "string"
        ? providerConfig.effort
        : undefined;
      const result = await adapter.execute({
        role,
        prompt,
        cwd: state.cwd,
        timeoutMs: this.remainingTimeMs(state),
        ...(state.workspaceContext ? { workspaceContext: state.workspaceContext } : {}),
        ...(provider === "antigravity"
          ? { diagnosticLogPath: this.store.filePath(state.id, `provider-logs/agy-${String(state.agentCalls).padStart(2, "0")}.log`) }
          : {}),
        ...(providerConfig.model
          ? { model: providerConfig.model }
          : {}),
        ...(effort
          ? { effort }
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
      const afterDiff = isModifyingRole(role) ? await captureWorkspaceDiff(state.cwd, this.runner, state.workspaceContext) : undefined;
      const workspaceDiff = state.workspaceContext?.kind === "directory"
        ? afterDiff
        : beforeDiff !== undefined && afterDiff !== beforeDiff ? afterDiff : undefined;
      await this.recordAgentTranscript(state, role, result, workspaceDiff, options);
      if (result.exitCode === 0) return result;
      const failure = summarizeAgentFailure(result);
      failures.push(`${provider}: ${failure}`);
      await this.emitDetailed(state, options, {
        kind: "provider_error",
        provider,
        role,
        message: `${role} provider ${provider} failed with exit ${result.exitCode}: ${failure}`,
      });
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
        ? ["codex", "claude", "gemini", "antigravity"]
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
    const elapsed = this.activeElapsedMs(state);
    if (elapsed > this.config.budgets.maxWallTimeMinutes * 60_000) {
      throw new Error("Wall-time budget exhausted");
    }
  }

  private checkCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("Run cancelled");
  }

  private remainingTimeMs(state: RunState): number {
    const budgetMs = this.config.budgets.maxWallTimeMinutes * 60_000;
    return Math.max(1, budgetMs - this.activeElapsedMs(state));
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

  private async ensureWorkspaceContext(state: RunState): Promise<void> {
    if (state.workspaceContext) return;
    state.workspaceContext = await detectWorkspaceContext(state.cwd, this.runner);
    await this.store.saveState(state);
  }

  private async emitWorkspaceMode(state: RunState, options: WorkflowOptions): Promise<void> {
    const context = state.workspaceContext;
    if (!context) return;
    await this.emit(
      state,
      options,
      context.kind === "git"
        ? `Workspace: Git (${context.root})`
        : "Workspace: Directory mode. Git diff/recovery unavailable; run git init and create a baseline commit to enable them.",
    );
  }

  private async recordAgentTranscript(
    state: RunState,
    role: RoleName,
    result: AgentResult,
    workspaceDiff: string | undefined,
    options: WorkflowOptions,
  ): Promise<void> {
    const call = String(state.agentCalls).padStart(2, "0");
    const jsonName = `agent-transcript-${call}.json`;
    const markdownName = `agent-transcript-${call}.md`;
    const payload = { provider: result.provider, role, items: result.transcript, ...(workspaceDiff ? { workspaceDiff } : {}) };
    const markdown = [
      formatAgentTranscript(role, result.provider, result.transcript),
      ...(workspaceDiff ? [`Current workspace diff after ${role}\n\n\`\`\`diff\n${workspaceDiff}\n\`\`\``] : []),
    ].filter(Boolean).join("\n\n");
    await this.store.writeText(state.id, jsonName, `${JSON.stringify(payload, null, 2)}\n`);
    await this.store.writeText(state.id, markdownName, `${markdown}\n`);
    let cumulative = "";
    try { cumulative = await this.store.readText(state.id, "transcript.md"); } catch { /* First provider call. */ }
    await this.store.writeText(state.id, "transcript.md", `${cumulative}${cumulative ? "\n" : ""}${markdown}\n`);
    for (const item of result.transcript) {
      await this.emitDetailed(state, options, {
        kind: "agent_transcript",
        provider: result.provider,
        role,
        transcriptItem: item,
        agentCallId: state.agentCalls,
        message: formatTranscriptItem(item),
      });
    }
    if (workspaceDiff) {
      await this.emitDetailed(state, options, {
        kind: "workspace_diff",
        provider: result.provider,
        role,
        message: `Current workspace diff after ${role}\n${workspaceDiff}`,
        agentCallId: state.agentCalls,
      });
    }
  }

  private async waitForInput(
    state: RunState,
    options: WorkflowOptions,
    checkpoint: RunCheckpoint,
  ): Promise<void> {
    this.checkCancelled(options.signal);
    this.settleActive(state);
    state.checkpoint = checkpoint;
    state.status = "awaiting_input";
    await this.store.saveState(state);
    await this.emit(state, options, `${checkpoint.message} [Y/N/custom feedback]`);
  }

  private async finish(
    state: RunState,
    options: WorkflowOptions,
    message: string,
  ): Promise<RunState> {
    this.settleActive(state);
    state.stage = "DONE";
    state.status = "completed";
    delete state.checkpoint;
    await this.store.saveState(state);
    await this.emit(state, options, message);
    return state;
  }

  private beginActive(state: RunState): void {
    state.activeSince ??= new Date().toISOString();
  }

  private settleActive(state: RunState): void {
    if (!state.activeSince) return;
    state.activeTimeMs += Math.max(0, Date.now() - Date.parse(state.activeSince));
    delete state.activeSince;
  }

  private activeElapsedMs(state: RunState): number {
    return state.activeTimeMs + (state.activeSince ? Math.max(0, Date.now() - Date.parse(state.activeSince)) : 0);
  }

  private async emit(
    state: RunState,
    options: WorkflowOptions,
    message: string,
  ): Promise<void> {
    return this.emitDetailed(state, options, { kind: "status", message });
  }

  private async emitDetailed(
    state: RunState,
    options: WorkflowOptions,
    detail: Omit<WorkflowEvent, "runId" | "stage">,
  ): Promise<void> {
    const event: WorkflowEvent = { runId: state.id, stage: state.stage, ...detail };
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

function withFeedback(prompt: string, feedback?: string, previous?: unknown): string {
  if (!feedback) return prompt;
  return `${prompt}\n\nUser feedback for this revision:\n${feedback}${
    previous === undefined ? "" : `\n\nPrevious output:\n${JSON.stringify(previous, null, 2)}`
  }`;
}

function actionForStage(stage: RunStage): WorkflowAction {
  if (stage === "IMPLEMENTING" || stage === "PLANNED") return "IMPLEMENT";
  if (stage === "DEBUGGING") return "DEBUG";
  if (stage === "REVIEWING") return "REVIEW";
  return "VERIFY";
}

function manualRole(step: ManualStep): RoleName {
  if (step === "PLAN") return "planner";
  if (step === "IMPLEMENT") return "implementer";
  if (step === "DEBUG") return "debugger";
  if (step === "VERIFY") return "verifier";
  return "reviewer";
}

function isModifyingRole(role: RoleName): boolean {
  return role === "implementer" || role === "debugger";
}
