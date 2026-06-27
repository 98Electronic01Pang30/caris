import type { AgentResult, AgentTask, AgentTranscriptItem } from "../domain.js";
import type { ProcessRunner } from "../process-runner.js";
import type { ProviderCapabilities } from "../domain.js";
import { BUFFERED_CAPABILITIES, createBufferedSession, createFailedSession, createProtocolFallbackSession, isUnsupportedProtocolFailure } from "../agent-session.js";
import { CliAgentAdapter } from "./cli-adapter.js";
import { createAcpSession } from "./acp-session.js";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export class AntigravityAdapter extends CliAgentAdapter {
  readonly provider = "antigravity" as const;
  override readonly capabilities: ProviderCapabilities = {
    ...BUFFERED_CAPABILITIES,
    transport: "auto",
    fallbackTransports: ["buffered"],
    acp: "unknown",
    acpCommand: "agy --acp",
  };

  override createSession(task: AgentTask) {
    const transport = task.transport ?? "auto";
    if (transport === "buffered" || transport === "native") return createBufferedSession(() => this.execute(task));
    const acp = createAcpSession({
      provider: "antigravity",
      runner: this.runner,
      executable: this.executable,
      args: ["--acp"],
      task,
      supportsSteering: false,
    });
    if (transport === "acp") return acp ?? this.missingAcpSession("Antigravity ACP requires ProcessRunner.spawn support");
    const buffered = () => {
      const message = "Antigravity ACP is not available; using buffered agy --print.";
      return createBufferedSession(async () => {
        const result = await this.execute(task);
        return {
          ...result,
          transcript: [{ kind: "diagnostic" as const, text: message }, ...result.transcript],
        };
      });
    };
    return acp
      ? createProtocolFallbackSession(acp, buffered, isUnsupportedProtocolFailure)
      : buffered();
  }

  constructor(runner?: ProcessRunner, executable = "agy", candidates: string[] = []) {
    super(runner, executable, candidates);
  }

  private missingAcpSession(message: string) {
    return createFailedSession({
      provider: "antigravity",
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
      ...(readOnly ? ["--sandbox"] : ["--dangerously-skip-permissions"]),
      ...(task.model ? ["--model", task.model] : []),
      ...(task.diagnosticLogPath ? ["--log-file", task.diagnosticLogPath] : []),
      "--print",
      task.prompt,
    ];
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    if (task.diagnosticLogPath) await mkdir(path.dirname(task.diagnosticLogPath), { recursive: true });
    const result = await super.execute(task);
    if (result.exitCode !== 0 && !result.stdout.trim() && !result.stderr.trim() && task.diagnosticLogPath) {
      const diagnostic = await diagnoseLog(task.diagnosticLogPath) ??
        "Antigravity failed without terminal output and did not create a diagnostic log.";
      return {
        ...result,
        stderr: diagnostic,
        transcript: [...result.transcript, { kind: "diagnostic", text: diagnostic }],
      };
    }
    if (result.exitCode === 0 && !result.output.trim()) {
      const requiresText = task.role === "planner" || task.role === "verifier" || task.role === "reviewer";
      if (requiresText) {
        return { ...result, exitCode: 1, stderr: result.stderr || "Antigravity returned an empty response" };
      }
      const text = "Antigravity completed without a textual response.";
      return { ...result, output: text, transcript: [{ kind: "assistant_message", text }] };
    }
    return result;
  }

  parseOutput(stdout: string, _stderr: string): Pick<AgentResult, "output" | "rawEvents"> {
    return { output: stdout.trim(), rawEvents: [] };
  }

  parseTranscript(stdout: string, _stderr: string): AgentTranscriptItem[] {
    const items: AgentTranscriptItem[] = [];
    if (stdout.trim()) items.push({ kind: "assistant_message", text: stdout.trim() });
    return items;
  }
}

async function diagnoseLog(filename: string): Promise<string | undefined> {
  try {
    const source = await readFile(filename, "utf8");
    if (/[/\\]Users[/\\].*[/\\]\.gemini[/\\]antigravity-cli[/\\]brain/i.test(source)) {
      return "Antigravity headless transcript path failure detected on Windows; see provider log.";
    }
    if (/auth(?:entication)?[^\r\n]*(?:fail|error|denied)|unauthorized/i.test(source)) {
      return "Antigravity authentication failed; see provider log.";
    }
    if (/permission[^\r\n]*(?:fail|error|denied)/i.test(source)) {
      return "Antigravity permission failure; see provider log.";
    }
    return source.trim() ? "Antigravity failed without terminal output; see provider log." : undefined;
  } catch {
    return undefined;
  }
}
