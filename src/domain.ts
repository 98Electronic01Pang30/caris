import { z } from "zod";

export const providerNameSchema = z.enum(["codex", "claude", "gemini", "antigravity"]);
export type ProviderName = z.infer<typeof providerNameSchema>;

export const roleNameSchema = z.enum([
  "planner",
  "implementer",
  "debugger",
  "verifier",
  "reviewer",
]);
export type RoleName = z.infer<typeof roleNameSchema>;

export const providerStatusSchema = z.enum([
  "READY",
  "INSTALLED",
  "NOT_INSTALLED",
  "NOT_AUTHENTICATED",
  "POLICY_BLOCKED",
  "UNAVAILABLE",
]);
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const roleConfigSchema = z.object({
  provider: z.union([providerNameSchema, z.literal("auto")]),
  fallback: z.array(providerNameSchema).default([]),
});

export const providerRuntimeConfigSchema = z.object({
  executable: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
});
export type ProviderRuntimeConfig = z.infer<typeof providerRuntimeConfigSchema>;

const emptyProviderConfig = (): ProviderRuntimeConfig => ({});

export const carisConfigSchema = z.object({
  version: z.literal(1),
  agents: z.object({
    planner: roleConfigSchema,
    implementer: roleConfigSchema,
    debugger: roleConfigSchema,
    verifier: roleConfigSchema.default({ provider: "auto", fallback: [] }),
    reviewer: roleConfigSchema,
  }),
  providers: z
    .object({
      codex: providerRuntimeConfigSchema.default(emptyProviderConfig),
      claude: providerRuntimeConfigSchema.default(emptyProviderConfig),
      gemini: providerRuntimeConfigSchema.omit({ effort: true }).default(emptyProviderConfig),
      antigravity: providerRuntimeConfigSchema.omit({ effort: true }).default(emptyProviderConfig),
    })
    .default(() => ({ codex: {}, claude: {}, gemini: {}, antigravity: {} })),
  budgets: z.object({
    maxAgentCalls: z.number().int().positive().default(8),
    maxWallTimeMinutes: z.number().int().positive().default(30),
    maxContextCharsPerCall: z.number().int().positive().default(60_000),
    maxRetriesPerStep: z.number().int().nonnegative().default(2),
  }),
  verification: z.object({
    commands: z.array(z.string().min(1)).default([]),
  }),
});
export type CarisConfig = z.infer<typeof carisConfigSchema>;

export const taskPlanSchema = z.object({
  summary: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  files: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  verification: z.array(z.string()).default([]),
});
export type TaskPlan = z.infer<typeof taskPlanSchema>;

export const runStageSchema = z.enum([
  "RECEIVED",
  "PLANNING",
  "PLANNED",
  "IMPLEMENTING",
  "IMPLEMENTED",
  "VERIFYING",
  "DEBUGGING",
  "REVIEWING",
  "DONE",
  "FAILED",
  "CANCELLED",
]);
export type RunStage = z.infer<typeof runStageSchema>;

export const runStatusSchema = z.enum([
  "running",
  "idle",
  "awaiting_input",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const workspaceContextSchema = z.object({
  kind: z.enum(["git", "directory"]),
  root: z.string().min(1),
  canDiff: z.boolean(),
});
export type WorkspaceContext = z.infer<typeof workspaceContextSchema>;

export const executionModeSchema = z.enum(["manual", "pipeline"]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export const manualStepSchema = z.enum(["PLAN", "IMPLEMENT", "DEBUG", "VERIFY", "REVIEW"]);
export type ManualStep = z.infer<typeof manualStepSchema>;

export const stepExecutionSchema = z.object({
  index: z.number().int().positive(),
  step: manualStepSchema,
  role: roleNameSchema,
  instruction: z.string(),
  provider: providerNameSchema.optional(),
  status: z.enum(["running", "succeeded", "failed"]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  artifacts: z.array(z.string()).default([]),
  error: z.string().optional(),
});
export type StepExecution = z.infer<typeof stepExecutionSchema>;

export const checkpointStepSchema = z.enum(["PLAN", "IMPLEMENT", "VERIFY", "DEBUG", "REVIEW"]);
export type CheckpointStep = z.infer<typeof checkpointStepSchema>;
export const workflowActionSchema = z.enum(["IMPLEMENT", "VERIFY", "DEBUG", "REVIEW", "COMPLETE"]);
export type WorkflowAction = z.infer<typeof workflowActionSchema>;

export const feedbackEntrySchema = z.object({
  step: checkpointStepSchema,
  message: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const runCheckpointSchema = z.object({
  completedStep: checkpointStepSchema,
  nextAction: workflowActionSchema,
  message: z.string(),
  verificationFailed: z.boolean().default(false),
});
export type RunCheckpoint = z.infer<typeof runCheckpointSchema>;

export const verificationResultSchema = z.object({
  command: z.string(),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative(),
});
export type VerificationResult = z.infer<typeof verificationResultSchema>;

export const runStateSchema = z.object({
  id: z.string().uuid(),
  request: z.string().min(1),
  cwd: z.string().min(1),
  workspaceContext: workspaceContextSchema.optional(),
  stage: runStageSchema,
  executionMode: executionModeSchema.default("pipeline"),
  stepHistory: z.array(stepExecutionSchema).default([]),
  status: runStatusSchema.default("running"),
  checkpoint: runCheckpointSchema.optional(),
  feedback: z.array(feedbackEntrySchema).default([]),
  debugAttempts: z.number().int().nonnegative().default(0),
  failedStage: runStageSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  activeTimeMs: z.number().nonnegative().default(0),
  activeSince: z.string().datetime().optional(),
  agentCalls: z.number().int().nonnegative(),
  planOnly: z.boolean().default(false),
  mentionedFiles: z.array(z.string()).default([]),
  plan: taskPlanSchema.optional(),
  verification: z.array(verificationResultSchema).default([]),
  error: z.string().optional(),
});
export type RunState = z.infer<typeof runStateSchema>;

export type WorkflowResponse =
  | { kind: "approve" }
  | { kind: "pause" }
  | { kind: "feedback"; message: string };

export interface ProviderHealth {
  provider: ProviderName;
  status: ProviderStatus;
  executable: string;
  version?: string;
  detail?: string;
  candidates?: string[];
}

export interface AgentTask {
  role: RoleName;
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  model?: string;
  effort?: string;
  workspaceContext?: WorkspaceContext;
  diagnosticLogPath?: string;
}

export interface UsageRecord {
  provider: ProviderName;
  role: RoleName;
  startedAt: string;
  durationMs: number;
  inputChars: number;
  outputChars: number;
  exitCode: number;
}

export interface AgentResult {
  provider: ProviderName;
  exitCode: number;
  output: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  rawEvents: unknown[];
  transcript: AgentTranscriptItem[];
}

export type AgentTranscriptItem =
  | { kind: "assistant_message"; text: string }
  | { kind: "tool_call"; tool: string; text: string }
  | { kind: "tool_result"; text: string; exitCode?: number }
  | { kind: "file_change"; text: string; path?: string; change?: string }
  | { kind: "diagnostic"; text: string }
  | { kind: "usage"; text: string; usage?: Record<string, number> };
