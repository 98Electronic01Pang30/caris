import type { WorkflowEvent } from "./workflow.js";
import { formatTranscriptItem } from "./transcript-format.js";

export function formatWorkflowEvent(
  event: WorkflowEvent,
  options: { truncateToolResult?: boolean } = {},
): string {
  if (event.kind === "agent_transcript" && event.provider && event.role && event.transcriptItem) {
    return `${capitalize(event.role)} · ${capitalize(event.provider)}\n\n${formatTranscriptItem(event.transcriptItem, options)}`;
  }
  if (event.kind === "provider_error") return `Provider Error\n${event.message}`;
  return event.kind === "status" || event.kind === undefined ? `[${event.stage}] ${event.message}` : event.message;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
