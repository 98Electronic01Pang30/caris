import type { AgentResult, AgentTask, AgentTranscriptItem } from "../domain.js";
import type { ProcessRunner } from "../process-runner.js";
import { addTranscriptItem, CliAgentAdapter, findLastString, parseJsonLines, stringifyTranscriptValue } from "./cli-adapter.js";

export class GeminiAdapter extends CliAgentAdapter {
  readonly provider = "gemini" as const;

  constructor(runner?: ProcessRunner, executable = "gemini", candidates: string[] = []) {
    super(runner, executable, candidates);
  }

  protected buildArgs(task: AgentTask): string[] {
    const readOnly = task.role === "planner" || task.role === "verifier" || task.role === "reviewer";
    return [
      "--prompt",
      "Complete the task provided on stdin.",
      "--output-format",
      "stream-json",
      "--skip-trust",
      "--approval-mode",
      readOnly ? "plan" : "auto_edit",
      ...(task.model ? ["--model", task.model] : []),
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
      findLastString(rawEvents, new Set(["text", "content", "message", "result"])) ??
      stdout.trim();
    return { output, rawEvents };
  }

  parseTranscript(stdout: string, _stderr: string): AgentTranscriptItem[] {
    const items: AgentTranscriptItem[] = [];
    for (const event of parseJsonLines(stdout)) {
      if (!isRecord(event)) continue;
      if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") addTranscriptItem(items, { kind: "assistant_message", text: event.content });
      if (event.type === "tool_call") items.push({ kind: "tool_call", tool: typeof event.name === "string" ? event.name : "tool", text: stringifyTranscriptValue(event.arguments ?? event.args ?? {}) });
      if (event.type === "tool_result") items.push({ kind: "tool_result", text: stringifyTranscriptValue(event.output ?? event.result ?? ""), ...numberField(event.exit_code ?? event.exitCode) });
      if (event.type === "file_change") items.push({ kind: "file_change", text: stringifyTranscriptValue(event), ...(typeof event.path === "string" ? { path: event.path } : {}) });
      if (isRecord(event.usage)) items.push({ kind: "usage", text: stringifyTranscriptValue(event.usage), usage: numericRecord(event.usage) });
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
