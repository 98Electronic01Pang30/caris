import type { TaskPlan, VerificationResult } from "./domain.js";

export function plannerPrompt(
  request: string,
  repository: string,
  requestedFiles = "",
): string {
  return `You are the planner in a coding workflow. Do not edit files or use tools.
The repository summary below is your complete input. Do not acknowledge the task and do not send
progress updates. Your first and only response must be the final JSON object with this shape:
{"summary":"...","steps":["..."],"files":["..."],"risks":["..."],"verification":["..."]}

User request:
${request}

Repository summary:
${repository}
${requestedFiles ? `\nFiles explicitly requested by the user:\n${requestedFiles}` : ""}`;
}

export function implementerPrompt(request: string, plan: TaskPlan): string {
  return `You are the implementer. Modify the repository to satisfy the request.
Preserve existing user changes. Follow the plan, inspect relevant files, and run focused checks when useful.

Request:
${request}

Plan:
${JSON.stringify(plan, null, 2)}`;
}

export function debuggerPrompt(
  request: string,
  plan: TaskPlan,
  verification: VerificationResult[],
): string {
  return `You are the debugger. The implementation did not pass configured verification.
Inspect the current workspace and fix the failure without reverting unrelated changes.

Request:
${request}

Plan:
${JSON.stringify(plan, null, 2)}

Verification failures:
${JSON.stringify(verification, null, 2)}`;
}

export function reviewerPrompt(request: string, plan: TaskPlan, diff: string): string {
  return `You are the reviewer. Do not edit files. Review the changes for correctness, regressions,
security risks, and missing tests. Return concise findings ordered by severity. Say clearly if there
are no findings.

Request:
${request}

Plan:
${JSON.stringify(plan, null, 2)}

Workspace changes:
${diff}`;
}
