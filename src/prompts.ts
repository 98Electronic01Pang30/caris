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
Your final response must be conversational Markdown, not JSON. Summarize what you changed, the files involved,
checks you ran, their results, and any remaining caveats. Do not expose internal reasoning or protocol events.

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
Your final response must be conversational Markdown, not JSON. Explain the root cause, the fix, verification
results, and any remaining risk. Do not expose internal reasoning or protocol events.

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
Use conversational Markdown, not JSON. Include file locations where available, missing tests, and a final conclusion.

Request:
${request}

Plan:
${JSON.stringify(plan, null, 2)}

Workspace changes:
${diff}`;
}

export function verifierPrompt(
  request: string,
  scope: string,
  changeInstruction: string,
  diff: string,
  verification: VerificationResult[],
): string {
  return `You are the verifier. Do not edit files. Determine whether the most recently implemented
or debugged functionality works as requested. Analyze the configured command results and workspace
diff. Report failures, missing coverage, and a clear pass/fail conclusion.
Your final response must be conversational Markdown, not JSON. Lead with PASS or FAIL, then summarize commands,
evidence, failures, and missing coverage. Do not expose internal reasoning or protocol events.

Request:
${request}

Verification scope:
${scope || "Verify the latest implemented or debugged functionality."}

Latest change instruction:
${changeInstruction || "No implementation or debugging instruction is recorded."}

Workspace changes:
${diff}

Command results:
${JSON.stringify(verification, null, 2)}`;
}
