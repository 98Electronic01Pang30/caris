import { z } from "zod";

export const providerNameSchema = z.enum(["codex", "claude", "gemini"]);
export type ProviderName = z.infer<typeof providerNameSchema>;

export const roleNameSchema = z.enum([
  "planner",
  "implementer",
  "debugger",
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
    reviewer: roleConfigSchema,
  }),
  providers: z
    .object({
      codex: providerRuntimeConfigSchema.default(emptyProviderConfig),
      claude: providerRuntimeConfigSchema.default(emptyProviderConfig),
      gemini: providerRuntimeConfigSchema.omit({ effort: true }).default(emptyProviderConfig),
    })
    .default(() => ({ codex: {}, claude: {}, gemini: {} })),
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
  stage: runStageSchema,
  failedStage: runStageSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  agentCalls: z.number().int().nonnegative(),
  planOnly: z.boolean().default(false),
  mentionedFiles: z.array(z.string()).default([]),
  plan: taskPlanSchema.optional(),
  verification: z.array(verificationResultSchema).default([]),
  error: z.string().optional(),
});
export type RunState = z.infer<typeof runStateSchema>;

export interface ProviderHealth {
  provider: ProviderName;
  status: ProviderStatus;
  executable: string;
  version?: string;
  detail?: string;
}

export interface AgentTask {
  role: RoleName;
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  model?: string;
  effort?: string;
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
}
