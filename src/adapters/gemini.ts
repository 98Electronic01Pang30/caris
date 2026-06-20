import type { AgentResult, AgentTask } from "../domain.js";
import { CliAgentAdapter, findLastString, parseJsonLines } from "./cli-adapter.js";

export class GeminiAdapter extends CliAgentAdapter {
  readonly provider = "gemini" as const;
  readonly executable = "gemini";

  protected buildArgs(task: AgentTask): string[] {
    const readOnly = task.role === "planner" || task.role === "reviewer";
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
}
