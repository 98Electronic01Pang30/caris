import type { AgentResult, AgentTask, AgentTranscriptItem } from "../domain.js";
import type { ProcessRunner } from "../process-runner.js";
import { addTranscriptItem, CliAgentAdapter, findLastString, parseJsonLines, stringifyTranscriptValue } from "./cli-adapter.js";

export class ClaudeAdapter extends CliAgentAdapter {
  readonly provider = "claude" as const;

  constructor(runner?: ProcessRunner, executable = "claude", candidates: string[] = []) {
    super(runner, executable, candidates);
  }

  protected buildArgs(task: AgentTask): string[] {
    return [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      task.role === "planner" || task.role === "verifier" || task.role === "reviewer" ? "plan" : "acceptEdits",
      ...(task.model ? ["--model", task.model] : []),
      ...(task.effort ? ["--effort", task.effort] : []),
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
      findLastString(rawEvents, new Set(["result", "text", "message"])) ??
      stdout.trim();
    return { output, rawEvents };
  }

  parseTranscript(stdout: string, _stderr: string): AgentTranscriptItem[] {
    const items: AgentTranscriptItem[] = [];
    for (const event of parseJsonLines(stdout)) {
      if (!isRecord(event)) continue;
      const message = isRecord(event.message) ? event.message : undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") addTranscriptItem(items, { kind: "assistant_message", text: block.text });
        if (block.type === "tool_use") items.push({ kind: "tool_call", tool: typeof block.name === "string" ? block.name : "tool", text: stringifyTranscriptValue(block.input ?? {}) });
        if (block.type === "tool_result") items.push({ kind: "tool_result", text: stringifyTranscriptValue(block.content ?? ""), ...(block.is_error === true ? { exitCode: 1 } : {}) });
      }
      if (event.type === "result" && typeof event.result === "string") addTranscriptItem(items, { kind: "assistant_message", text: event.result });
      const usage = isRecord(event.usage) ? event.usage : isRecord(message?.usage) ? message.usage : undefined;
      if (usage) items.push({ kind: "usage", text: stringifyTranscriptValue(usage), usage: numericRecord(usage) });
    }
    return items;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numericRecord(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}
