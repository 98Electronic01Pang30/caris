import type { ProviderName, RunState } from "./domain.js";

export type ComposerMode = "run" | "plan" | "implement" | "debug" | "verify" | "review";

export interface TranscriptEntry {
  id: number;
  kind: "user" | "system" | "event" | "error";
  text: string;
}

export interface TuiSessionState {
  mode: ComposerMode;
  currentRun?: RunState;
  attachments: string[];
  running: boolean;
  transcript: TranscriptEntry[];
  selectedProvider?: ProviderName;
}
