import type { AgentResult, AgentTask, AgentTranscriptItem } from "../domain.js";
import type { ProcessRunner } from "../process-runner.js";
import { CliAgentAdapter } from "./cli-adapter.js";

export class AntigravityAdapter extends CliAgentAdapter {
  readonly provider = "antigravity" as const;

  constructor(runner?: ProcessRunner, executable = "agy", candidates: string[] = []) {
    super(runner, executable, candidates);
  }

  protected buildArgs(task: AgentTask): string[] {
    const readOnly = task.role === "planner" || task.role === "verifier" || task.role === "reviewer";
    return [
      ...(readOnly ? ["--sandbox"] : ["--dangerously-skip-permissions"]),
      ...(task.model ? ["--model", task.model] : []),
      "--print",
      task.prompt,
    ];
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const result = await super.execute(task);
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
