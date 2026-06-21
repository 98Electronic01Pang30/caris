import type {
  AgentResult,
  AgentTranscriptItem,
  AgentTask,
  ProviderHealth,
  ProviderName,
} from "../domain.js";
import {
  ExecaProcessRunner,
  resolveExecutable,
  type ProcessRunner,
} from "../process-runner.js";
import type { AgentAdapter } from "./agent-adapter.js";

export abstract class CliAgentAdapter implements AgentAdapter {
  abstract readonly provider: ProviderName;

  constructor(
    protected readonly runner: ProcessRunner = new ExecaProcessRunner(),
    readonly executable: string,
    private readonly executableCandidates: string[] = [],
  ) {}

  protected abstract buildArgs(task: AgentTask): string[];

  protected buildInput(_task: AgentTask): string | undefined {
    return undefined;
  }

  abstract parseOutput(
    stdout: string,
    stderr: string,
  ): Pick<AgentResult, "output" | "rawEvents">;

  abstract parseTranscript(stdout: string, stderr: string): AgentTranscriptItem[];

  async detect(cwd: string): Promise<ProviderHealth> {
    const resolved = await resolveExecutable(this.executable);
    if (!resolved) {
      return {
        provider: this.provider,
        status: "NOT_INSTALLED",
        executable: this.executable,
        detail: "Executable was not found in configured or discovered locations",
        candidates: this.executableCandidates,
      };
    }
    const result = await this.runner.run({
      executable: this.executable,
      args: ["--version"],
      cwd,
      timeoutMs: 30_000,
    });
    if (result.exitCode === 0) {
      return {
        provider: this.provider,
        status: "INSTALLED",
        executable: resolved,
        version: result.stdout.trim() || result.stderr.trim(),
        detail: "Authentication is checked on the first live invocation.",
        candidates: this.executableCandidates,
      };
    }

    const missing =
      result.errorCode === "ENOENT" ||
      /ENOENT|not recognized|not found|cannot find/i.test(result.stderr);
    return {
      provider: this.provider,
      status: missing ? "NOT_INSTALLED" : "UNAVAILABLE",
      executable: this.executable,
      detail: result.stderr.trim() || "Version probe failed",
      candidates: this.executableCandidates,
    };
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const input = this.buildInput(task);
    const result = await this.runner.run({
      executable: this.executable,
      args: this.buildArgs(task),
      cwd: task.cwd,
      ...(input !== undefined ? { input } : {}),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
    });
    const parsed = this.parseOutput(result.stdout, result.stderr);
    const transcript = this.parseTranscript(result.stdout, result.stderr);
    if (parsed.output.trim()) addTranscriptItem(transcript, { kind: "assistant_message", text: parsed.output });
    return {
      provider: this.provider,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      ...parsed,
      transcript,
    };
  }
}

export function addTranscriptItem(
  items: AgentTranscriptItem[],
  item: AgentTranscriptItem,
): void {
  if (item.kind === "assistant_message") {
    if (!item.text.trim()) return;
    const duplicate = items.some(
      (existing) => existing.kind === "assistant_message" && existing.text.trim() === item.text.trim(),
    );
    if (duplicate) return;
  }
  items.push(item);
}

export function stringifyTranscriptValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function parseJsonLines(source: string): unknown[] {
  const events: unknown[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Provider progress streams may contain non-JSON diagnostic lines.
    }
  }
  return events;
}

export function findLastString(
  value: unknown,
  keys: ReadonlySet<string>,
): string | undefined {
  let found: string | undefined;
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (current === null || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      if (keys.has(key) && typeof child === "string" && child.trim()) {
        found = child;
      }
      visit(child);
    }
  };
  visit(value);
  return found;
}
