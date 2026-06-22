import type { AgentTranscriptItem, RoleName, TaskPlan } from "./domain.js";
import { taskPlanSchema } from "./domain.js";

export function tryParseTaskPlanOutput(output: string): TaskPlan | undefined {
  const candidates = [output, extractCodeFence(output), extractJsonObject(output)].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of candidates) {
    try {
      return taskPlanSchema.parse(JSON.parse(candidate));
    } catch {
      // Try the next supported representation.
    }
  }
  return undefined;
}

export function parseTaskPlanOutput(output: string, request: string): TaskPlan {
  return tryParseTaskPlanOutput(output) ?? {
    summary: output.trim() || request,
    steps: ["Inspect the relevant code", "Implement the requested change", "Verify the result"],
    files: [],
    risks: ["Planner did not return structured JSON"],
    verification: [],
  };
}

export function formatTaskPlanForChat(plan: TaskPlan): string {
  return [
    plan.summary,
    section("Plan", plan.steps, true),
    section("Files", plan.files),
    section("Risks", plan.risks),
    section("Verification", plan.verification),
  ].filter(Boolean).join("\n\n");
}

export function normalizeRoleTranscript(
  role: RoleName,
  items: AgentTranscriptItem[],
  finalOutput = "",
): AgentTranscriptItem[] {
  const assistantItems = items.filter((item): item is Extract<AgentTranscriptItem, { kind: "assistant_message" }> => item.kind === "assistant_message");
  const combined = assistantItems.map((item) => item.text).join("");
  const canonical = findStructuredPresentation(role, [
    { source: "combined" as const, text: combined },
    { source: "final" as const, text: finalOutput },
  ]);
  if (canonical) {
    const lastAssistant = items.findLastIndex((item) => item.kind === "assistant_message");
    const normalized: AgentTranscriptItem[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (item.kind !== "assistant_message") normalized.push(item);
      else {
        const preserveProgress = canonical.source === "final" &&
          item.text.trim() !== finalOutput.trim() &&
          !looksLikeJsonFragment(item.text);
        if (preserveProgress) normalized.push(item);
        if (index === lastAssistant) normalized.push({ kind: "assistant_message", text: canonical.text });
      }
    }
    if (lastAssistant < 0) normalized.unshift({ kind: "assistant_message", text: canonical.text });
    return normalized;
  }
  return items.map((item) => {
    if (item.kind !== "assistant_message") return item;
    const text = formatRoleOutputForChat(role, item.text);
    return text === item.text ? item : { ...item, text };
  });
}

function findStructuredPresentation(
  role: RoleName,
  candidates: Array<{ source: "final" | "combined"; text: string }>,
): { source: "final" | "combined"; text: string } | undefined {
  for (const candidate of candidates) {
    if (!candidate.text.trim()) continue;
    const formatted = formatRoleOutputForChat(role, candidate.text);
    if (formatted !== candidate.text) return { source: candidate.source, text: formatted };
  }
  return undefined;
}

function looksLikeJsonFragment(source: string): boolean {
  const trimmed = source.trim();
  return ["{", "[", "}", "]", "\"", ",", ":"].some((token) => trimmed.startsWith(token)) ||
    ["}", "]", ","].some((token) => trimmed.endsWith(token));
}

export function formatRoleOutputForChat(role: RoleName, source: string): string {
  if (role === "planner") {
    const plan = tryParseTaskPlanOutput(source);
    if (plan) return formatTaskPlanForChat(plan);
    const record = parseWholeJsonRecord(source);
    if (record && ["summary", "steps", "files", "risks", "verification"].filter((key) => key in record).length >= 2) {
      return formatLoosePlannerReport(record);
    }
    return source;
  }
  const record = parseWholeJsonRecord(source);
  if (!record || !matchesRoleReport(role, record)) return source;
  return Object.entries(record)
    .map(([key, value]) => formatReportField(labelFor(key), value))
    .filter(Boolean)
    .join("\n\n");
}

function formatLoosePlannerReport(record: Record<string, unknown>): string {
  const order = ["summary", "steps", "files", "risks", "verification"];
  return order
    .filter((key) => key in record)
    .map((key) => {
      const value = record[key];
      if (key === "summary" && typeof value === "string") return value;
      if (key === "steps" && Array.isArray(value)) {
        return `**Plan**\n${value.map((item, index) => `${index + 1}. ${formatScalar(item)}`).join("\n")}`;
      }
      return formatReportField(labelFor(key), value);
    })
    .filter(Boolean)
    .join("\n\n");
}

const reportKeys: Record<Exclude<RoleName, "planner">, Set<string>> = {
  implementer: new Set(["summary", "changes", "files", "tests", "verification", "warnings", "remaining"]),
  debugger: new Set(["summary", "cause", "rootCause", "changes", "fixes", "tests", "verification", "risks"]),
  verifier: new Set(["status", "result", "summary", "checks", "commands", "failures", "missingCoverage", "evidence"]),
  reviewer: new Set(["summary", "findings", "risks", "tests", "missingTests", "conclusion", "status"]),
};

function matchesRoleReport(role: RoleName, value: Record<string, unknown>): boolean {
  if (role === "planner") return false;
  const keys = reportKeys[role];
  return Object.keys(value).filter((key) => keys.has(key)).length >= 2;
}

function parseWholeJsonRecord(source: string): Record<string, unknown> | undefined {
  const trimmed = source.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function section(title: string, values: string[], numbered = false): string {
  if (values.length === 0) return "";
  return `**${title}**\n${values.map((value, index) => numbered ? `${index + 1}. ${value}` : `- ${value}`).join("\n")}`;
}

function formatReportField(label: string, value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    return `**${label}**\n${value.map((item) => `- ${formatScalar(item)}`).join("\n")}`;
  }
  if (value !== null && typeof value === "object") {
    const rows = Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => `- ${labelFor(key)}: ${formatScalar(child)}`);
    return rows.length ? `**${label}**\n${rows.join("\n")}` : "";
  }
  return `**${label}**\n${formatScalar(value)}`;
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "None";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function labelFor(value: string): string {
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ");
  return spaced.length ? `${spaced[0]!.toUpperCase()}${spaced.slice(1)}` : value;
}

function extractCodeFence(value: string): string | undefined {
  return value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
}

function extractJsonObject(value: string): string | undefined {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start >= 0 && end > start ? value.slice(start, end + 1) : undefined;
}
