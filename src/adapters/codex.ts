import type { AgentResult, AgentTask, AgentTranscriptItem } from "../domain.js";
import type { ProcessRunner } from "../process-runner.js";
import { addTranscriptItem, CliAgentAdapter, findLastString, parseJsonLines, stringifyTranscriptValue } from "./cli-adapter.js";

const taskPlanSchemaPath = new URL("../../schemas/task-plan.schema.json", import.meta.url).pathname.replace(
  /^\/(?:[A-Za-z]:)/,
  (value) => value.slice(1),
);

export class CodexAdapter extends CliAgentAdapter {
  readonly provider = "codex" as const;

  constructor(runner?: ProcessRunner, executable = "codex", candidates: string[] = []) {
    super(runner, executable, candidates);
  }

  protected buildArgs(task: AgentTask): string[] {
    return [
      "--ask-for-approval",
      "never",
      ...(task.model ? ["--model", task.model] : []),
      ...(task.effort ? ["--config", `model_reasoning_effort=${JSON.stringify(task.effort)}`] : []),
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      task.role === "planner" || task.role === "verifier" || task.role === "reviewer" ? "read-only" : "workspace-write",
      ...(task.role === "planner" ? ["--output-schema", taskPlanSchemaPath] : []),
      "-",
    ];
  }

  protected buildInput(task: AgentTask): string {
    return task.prompt;
  }

  parseOutput(
    stdout: string,
    _stderr: string,
  ): Pick<AgentResult, "output" | "rawEvents"> {
    const rawEvents = parseJsonLines(stdout);
    const output =
      findLastString(rawEvents, new Set(["text", "message", "output_text"])) ??
      stdout.trim();
    return { output, rawEvents };
  }

  parseTranscript(stdout: string, _stderr: string): AgentTranscriptItem[] {
    const items: AgentTranscriptItem[] = [];
    for (const event of parseJsonLines(stdout)) {
      if (!isRecord(event)) continue;
      const type = event.type;
      const payload = isRecord(event.item) ? event.item : event;
      const itemType = payload.type;
      if (type === "item.completed" && itemType === "agent_message" && typeof payload.text === "string") {
        addTranscriptItem(items, { kind: "assistant_message", text: payload.text });
      } else if (type === "item.completed" && (itemType === "command_execution" || itemType === "command")) {
        const command = stringifyTranscriptValue(payload.command ?? payload.commands ?? payload.input ?? "command");
        items.push({ kind: "tool_call", tool: "shell", text: command });
        const result = payload.aggregated_output ?? payload.output ?? payload.stdout;
        if (result !== undefined) items.push({ kind: "tool_result", text: stringifyTranscriptValue(result), ...numberField(payload.exit_code ?? payload.exitCode) });
      } else if (type === "item.completed" && (itemType === "file_change" || itemType === "file_changes")) {
        items.push({ kind: "file_change", text: stringifyTranscriptValue(payload.changes ?? payload) });
      } else if (type === "turn.completed" && isRecord(event.usage)) {
        items.push({ kind: "usage", text: stringifyTranscriptValue(event.usage), usage: numericRecord(event.usage) });
      }
    }
    return items;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberField(value: unknown): { exitCode?: number } {
  return typeof value === "number" ? { exitCode: value } : {};
}

function numericRecord(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}
