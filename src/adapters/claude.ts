import type { AgentResult, AgentSession, AgentTask, AgentTranscriptItem, ProviderCapabilities } from "../domain.js";
import type { ProcessRunner } from "../process-runner.js";
import { addTranscriptItem, CliAgentAdapter, findLastString, parseJsonLines, stringifyTranscriptValue } from "./cli-adapter.js";
import { createClaudeSdkSession } from "./claude-sdk-session.js";
import { createBufferedSession, createFailedSession, createProtocolFallbackSession, isUnsupportedProtocolFailure } from "../agent-session.js";
import { createAcpSession } from "./acp-session.js";
import { selectAcpCommand } from "./acp-command.js";

export class ClaudeAdapter extends CliAgentAdapter {
  readonly provider = "claude" as const;
  override readonly capabilities: ProviderCapabilities = {
    streaming: true,
    approvals: true,
    questions: true,
    steering: true,
    resume: false,
    transport: "auto",
    fallbackTransports: ["native", "buffered"],
    acp: "unknown",
    acpCommand: "npx -y @agentclientprotocol/claude-agent-acp",
  };

  override createSession(task: AgentTask): AgentSession {
    const transport = task.transport ?? "auto";
    if (transport === "buffered") return createBufferedSession(() => this.execute(task));
    if (transport === "native") return this.createNativeSession(task);
    const acp = this.createAcpTransportSession(task);
    if (transport === "acp") return acp ?? this.missingAcpSession("Claude ACP requires ProcessRunner.spawn support");
    return acp
      ? createProtocolFallbackSession(acp, () => this.createNativeSession(task), isUnsupportedProtocolFailure)
      : this.createNativeSession(task);
  }

  constructor(runner?: ProcessRunner, executable = "claude", candidates: string[] = []) {
    super(runner, executable, candidates);
  }

  private createNativeSession(task: AgentTask): AgentSession {
    return createProtocolFallbackSession(
      createClaudeSdkSession(this.executable, task),
      () => super.createSession(task),
      isUnsupportedProtocolFailure,
    );
  }

  private createAcpTransportSession(task: AgentTask): AgentSession | undefined {
    const readOnly = task.role === "planner" || task.role === "verifier" || task.role === "reviewer";
    const command = selectAcpCommand({
      overrideEnv: "CARIS_CLAUDE_ACP_EXECUTABLE",
      globalCommand: "claude-agent-acp",
      packageName: "@agentclientprotocol/claude-agent-acp",
    });
    return createAcpSession({
      provider: "claude",
      runner: this.runner,
      executable: command.executable,
      args: command.args,
      task,
      env: {
        ...process.env,
        CLAUDE_CODE_EXECUTABLE: this.executable,
        ...(task.model ? { ANTHROPIC_MODEL: task.model, CLAUDE_MODEL: task.model } : {}),
        ...(task.effort ? { CLAUDE_CODE_EFFORT: task.effort } : {}),
        CLAUDE_CODE_PERMISSION_MODE: readOnly ? "plan" : "acceptEdits",
      },
      supportsSteering: true,
    });
  }

  private missingAcpSession(message: string): AgentSession {
    return createFailedSession({
      provider: "claude",
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
