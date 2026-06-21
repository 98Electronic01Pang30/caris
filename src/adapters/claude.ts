import type { AgentResult, AgentTask } from "../domain.js";
import type { ProcessRunner } from "../process-runner.js";
import { CliAgentAdapter, findLastString, parseJsonLines } from "./cli-adapter.js";

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
}
