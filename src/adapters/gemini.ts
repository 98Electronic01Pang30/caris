import type { AgentResult, AgentSession, AgentTask, AgentTranscriptItem, ProviderCapabilities } from "../domain.js";
import type { ProcessRunner } from "../process-runner.js";
import { addTranscriptItem, CliAgentAdapter, findLastString, parseJsonLines, stringifyTranscriptValue } from "./cli-adapter.js";
import { createBufferedSession, createFailedSession, createProtocolFallbackSession, isUnsupportedProtocolFailure } from "../agent-session.js";
import { createAcpSession } from "./acp-session.js";

export class GeminiAdapter extends CliAgentAdapter {
  readonly provider = "gemini" as const;
  override readonly capabilities: ProviderCapabilities = {
    streaming: true,
    approvals: true,
    questions: false,
    steering: false,
    resume: false,
    transport: "acp",
    acp: "unknown",
    acpCommand: "gemini --acp",
  };

  override createSession(task: AgentTask): AgentSession {
    const transport = task.transport ?? "acp";
    if (transport === "buffered" || transport === "native") return createBufferedSession(() => this.execute(task));
    const acp = this.createAcpTransportSession(task);
    if (transport === "acp") return acp ?? this.missingAcpSession("Gemini ACP requires ProcessRunner.spawn support");
    return acp
      ? createProtocolFallbackSession(acp, () => createBufferedSession(() => this.execute(task)), isUnsupportedProtocolFailure)
      : createBufferedSession(() => this.execute(task));
  }

  constructor(runner?: ProcessRunner, executable = "gemini", candidates: string[] = []) {
    super(runner, executable, candidates);
  }

  private createAcpTransportSession(task: AgentTask): AgentSession | undefined {
    const readOnly = task.role === "planner" || task.role === "verifier" || task.role === "reviewer";
    return createAcpSession({
      provider: "gemini",
      runner: this.runner,
      executable: this.executable,
      args: ["--acp", "--approval-mode", readOnly ? "plan" : "default", ...(task.model ? ["--model", task.model] : [])],
      task,
      supportsSteering: false,
    });
  }

  private missingAcpSession(message: string): AgentSession {
    return createFailedSession({
      provider: "gemini",
      exitCode: 1,
      output: "",
      stdout: "",
      stderr: message,
      durationMs: 0,
      rawEvents: [],
      transcript: [{ kind: "diagnostic", text: message }],
    });
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
