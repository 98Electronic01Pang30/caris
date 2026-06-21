import type { AgentTranscriptItem, ProviderName, RoleName } from "./domain.js";

export function formatTranscriptItem(
  item: AgentTranscriptItem,
  options: { truncateToolResult?: boolean } = {},
): string {
  if (item.kind === "assistant_message") return item.text;
  if (item.kind === "tool_call") return `Tool · ${item.tool}\n${item.text}`;
  if (item.kind === "tool_result") {
    const text = options.truncateToolResult ? truncateToolResult(item.text) : item.text;
    return `Tool Result${item.exitCode === undefined ? "" : ` · exit ${item.exitCode}`}\n${text}`;
  }
  if (item.kind === "file_change") return `File Changes${item.path ? ` · ${item.path}` : ""}\n${item.text}`;
  if (item.kind === "usage") return `Usage\n${item.text}`;
  return `Diagnostic\n${item.text}`;
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
