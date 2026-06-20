import type { AgentResult, AgentTask } from "../domain.js";
import { CliAgentAdapter, findLastString, parseJsonLines } from "./cli-adapter.js";

export class GeminiAdapter extends CliAgentAdapter {
  readonly provider = "gemini" as const;
  readonly executable = "gemini";

  protected buildArgs(task: AgentTask): string[] {
    return ["--prompt", task.prompt, "--output-format", "stream-json"];
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
