import type {
  AgentResult,
  AgentTranscriptItem,
  AgentTask,
  AgentSession,
  ProviderCapabilities,
  ProviderHealth,
  ProviderName,
} from "../domain.js";

export interface AgentAdapter {
  readonly provider: ProviderName;
  readonly executable: string;
  readonly capabilities?: ProviderCapabilities;
  detect(cwd: string): Promise<ProviderHealth>;
  execute(task: AgentTask): Promise<AgentResult>;
  createSession?(task: AgentTask): AgentSession;
  parseOutput(stdout: string, stderr: string): Pick<AgentResult, "output" | "rawEvents">;
  parseTranscript(stdout: string, stderr: string): AgentTranscriptItem[];
}
