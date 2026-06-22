import { readdir } from "node:fs/promises";
import type { ArtifactStore } from "./artifacts.js";
import { providerNameSchema, roleNameSchema, type AgentTranscriptItem } from "./domain.js";
import { normalizeRoleTranscript } from "./role-presentation.js";
import { formatAgentTranscript } from "./transcript-format.js";

export async function renderStoredTranscript(store: ArtifactStore, runId: string): Promise<string> {
  const names = (await readdir(store.runDir(runId)))
    .filter((name) => /^agent-transcript-\d+\.json$/i.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const blocks: string[] = [];
  for (const name of names) {
    try {
      const payload: unknown = JSON.parse(await store.readText(runId, name));
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
      const record = payload as Record<string, unknown>;
      const provider = providerNameSchema.safeParse(record.provider);
      const role = roleNameSchema.safeParse(record.role);
      if (!provider.success || !role.success || !Array.isArray(record.items)) continue;
      const items = record.items.filter(isTranscriptItem);
      const finalOutput = items
        .filter((item): item is Extract<AgentTranscriptItem, { kind: "assistant_message" }> => item.kind === "assistant_message")
        .map((item) => item.text)
        .join("");
      const displayItems = normalizeRoleTranscript(role.data, items, finalOutput);
      const markdown = formatAgentTranscript(role.data, provider.data, displayItems);
      const workspaceDiff = typeof record.workspaceDiff === "string" ? record.workspaceDiff : undefined;
      blocks.push([
        markdown,
        ...(workspaceDiff ? [`Current workspace diff after ${role.data}\n\n\`\`\`diff\n${workspaceDiff}\n\`\`\``] : []),
      ].join("\n\n"));
    } catch {
      // Skip incomplete per-call artifacts and fall back when none are usable.
    }
  }
  if (blocks.length > 0) return `${blocks.join("\n\n")}\n`;
  return store.readText(runId, "transcript.md");
}

function isTranscriptItem(value: unknown): value is AgentTranscriptItem {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.kind !== "string" || typeof item.text !== "string") return false;
  if (item.kind === "assistant_message" || item.kind === "diagnostic") return true;
  if (item.kind === "tool_call") return typeof item.tool === "string";
  if (item.kind === "tool_result") return item.exitCode === undefined || typeof item.exitCode === "number";
  if (item.kind === "file_change") {
    return (item.path === undefined || typeof item.path === "string") &&
      (item.change === undefined || typeof item.change === "string");
  }
  if (item.kind === "usage") {
    return item.usage === undefined || (
      item.usage !== null && typeof item.usage === "object" && !Array.isArray(item.usage) &&
      Object.values(item.usage as Record<string, unknown>).every((entry) => typeof entry === "number")
    );
  }
  return false;
}
