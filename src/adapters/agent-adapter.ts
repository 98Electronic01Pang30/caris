import type {
  AgentResult,
  AgentTranscriptItem,
  AgentTask,
  ProviderHealth,
  ProviderName,
} from "../domain.js";

export interface AgentAdapter {
  readonly provider: ProviderName;
  readonly executable: string;
  detect(cwd: string): Promise<ProviderHealth>;
  execute(task: AgentTask): Promise<AgentResult>;
  parseOutput(stdout: string, stderr: string): Pick<AgentResult, "output" | "rawEvents">;
  parseTranscript(stdout: string, stderr: string): AgentTranscriptItem[];
}
