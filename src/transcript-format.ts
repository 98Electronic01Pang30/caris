import type { AgentTranscriptItem, ProviderName, RoleName } from "./domain.js";

export function formatTranscriptItem(
  item: AgentTranscriptItem,
  options: { truncateToolResult?: boolean } = {},
): string {
  if (item.kind === "assistant_message") return item.text;
  if (item.kind === "tool_call") return `Tool · ${item.tool}\n${formatToolArguments(item.text)}`;
  if (item.kind === "tool_result") {
    const text = options.truncateToolResult ? truncateToolResult(item.text) : item.text;
    return `Tool Result${item.exitCode === undefined ? "" : ` · exit ${item.exitCode}`}\n${text}`;
  }
  if (item.kind === "file_change") return `File Changes${item.path ? ` · ${item.path}` : ""}\n${item.text}`;
  if (item.kind === "usage") return formatUsage(item.usage, item.text);
  return `Diagnostic\n${item.text}`;
}

function formatUsage(usage: Record<string, number> | undefined, source: string): string {
  const values = usage ?? parseNumericRecord(source);
  if (!values) return `Tokens · ${source.trim()}`;
  const input = firstNumber(values, "input_tokens", "inputTokens", "input");
  const output = firstNumber(values, "output_tokens", "outputTokens", "output");
  const cached = firstNumber(values, "cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens", "cached");
  const reasoning = firstNumber(values, "reasoning_output_tokens", "reasoningOutputTokens", "reasoning_tokens");
  const parts = [
    input === undefined ? undefined : `input ${input.toLocaleString("en-US")}`,
    output === undefined ? undefined : `output ${output.toLocaleString("en-US")}`,
    cached === undefined ? undefined : `cached ${cached.toLocaleString("en-US")}`,
    reasoning === undefined ? undefined : `reasoning ${reasoning.toLocaleString("en-US")}`,
  ].filter((value): value is string => Boolean(value));
  if (parts.length === 0) {
    parts.push(...Object.entries(values).map(([key, value]) => `${key.replaceAll("_", " ")} ${value.toLocaleString("en-US")}`));
  }
  return `Tokens · ${parts.join(" · ")}`;
}

function formatToolArguments(source: string): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return source;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return source;
    return Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => `${key}: ${formatToolValue(child)}`)
      .join("\n");
  } catch {
    return source;
  }
}

function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "null";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function parseNumericRecord(source: string): Record<string, number> | undefined {
  try {
    const value: unknown = JSON.parse(source);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    );
  } catch {
    return undefined;
  }
}

function firstNumber(record: Record<string, number>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

export function formatAgentTranscript(
  role: RoleName,
  provider: ProviderName,
  items: AgentTranscriptItem[],
  options: { truncateToolResult?: boolean } = {},
): string {
  const title = `${capitalize(role)} · ${capitalize(provider)}`;
  return [title, ...items.map((item) => formatTranscriptItem(item, options))].join("\n\n");
}

export function truncateToolResult(value: string): string {
  if (value.length <= 4_000) return value;
  const omitted = value.length - 4_000;
  return `${value.slice(0, 3_000)}\n\n... ${omitted} characters omitted from screen; full output is in the run artifact ...\n\n${value.slice(-1_000)}`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
