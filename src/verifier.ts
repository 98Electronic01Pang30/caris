import type { VerificationResult } from "./domain.js";
import type { ProcessRunner } from "./process-runner.js";

export class VerificationRunner {
  constructor(private readonly runner: ProcessRunner) {}

  async run(commands: string[], cwd: string): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];
    for (const command of commands) {
      const invocation = shellInvocation(command);
      const result = await this.runner.run({ ...invocation, cwd });
      results.push({
        command,
        exitCode: result.exitCode,
        stdout: truncate(result.stdout),
        stderr: truncate(result.stderr),
        durationMs: result.durationMs,
      });
      if (result.exitCode !== 0) break;
    }
    return results;
  }
}

function shellInvocation(command: string): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      executable: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    };
  }
  return { executable: "/bin/sh", args: ["-lc", command] };
}

function truncate(value: string, limit = 20_000): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n... truncated ${value.length - limit} characters`;
}
