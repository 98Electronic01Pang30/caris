import type { AgentResult, AgentTask } from "../domain.js";
import { CliAgentAdapter, findLastString, parseJsonLines } from "./cli-adapter.js";

export class ClaudeAdapter extends CliAgentAdapter {
  readonly provider = "claude" as const;
  readonly executable = "claude";

  protected buildArgs(task: AgentTask): string[] {
    return [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      task.prompt,
    ];
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
