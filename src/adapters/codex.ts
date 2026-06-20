import type { AgentResult, AgentTask } from "../domain.js";
import { CliAgentAdapter, findLastString, parseJsonLines } from "./cli-adapter.js";

const taskPlanSchemaPath = new URL("../../schemas/task-plan.schema.json", import.meta.url).pathname.replace(
  /^\/(?:[A-Za-z]:)/,
  (value) => value.slice(1),
);

export class CodexAdapter extends CliAgentAdapter {
  readonly provider = "codex" as const;
  readonly executable = "codex";

  protected buildArgs(task: AgentTask): string[] {
    return [
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "workspace-write",
      ...(task.role === "planner" ? ["--output-schema", taskPlanSchemaPath] : []),
      "-",
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
      findLastString(rawEvents, new Set(["text", "message", "output_text"])) ??
      stdout.trim();
    return { output, rawEvents };
  }
}
