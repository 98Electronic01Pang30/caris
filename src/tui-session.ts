import type { ProviderName, RunState } from "./domain.js";

export type ComposerMode = "run" | "plan" | "implement" | "debug" | "verify" | "review";

export interface TranscriptEntry {
  id: number;
  kind: "user" | "system" | "event" | "agent" | "tool" | "diff" | "error";
  text: string;
  agentCallId?: number;
  role?: import("./domain.js").RoleName;
  provider?: ProviderName;
}

export interface TuiSessionState {
  mode: ComposerMode;
  currentRun?: RunState;
  attachments: string[];
  running: boolean;
  transcript: TranscriptEntry[];
  selectedProvider?: ProviderName;
}
