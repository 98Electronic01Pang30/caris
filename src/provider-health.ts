import type { AgentResult, ProviderHealth } from "./domain.js";

export function classifyProviderFailure(result: AgentResult): ProviderHealth["status"] {
  const text = `${result.stderr}\n${result.stdout}`;
  if (/auth|login|credential|unauthorized|sign in|ineligible.?tier/i.test(text)) {
    return "NOT_AUTHENTICATED";
  }
  if (/policy|organization|administrator|forbidden|permission denied/i.test(text)) {
    return "POLICY_BLOCKED";
  }
  return "UNAVAILABLE";
}

export function summarizeAgentFailure(result: AgentResult, limit = 300): string {
  const text = (result.stderr || result.stdout || `exit ${result.exitCode}`)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
