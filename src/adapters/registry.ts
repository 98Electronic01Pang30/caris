import type { ProviderName } from "../domain.js";
import type { ProcessRunner } from "../process-runner.js";
import type { AgentAdapter } from "./agent-adapter.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { GeminiAdapter } from "./gemini.js";

export type AdapterRegistry = Map<ProviderName, AgentAdapter>;

export function createAdapterRegistry(runner?: ProcessRunner): AdapterRegistry {
  const adapters: AgentAdapter[] = [
    new CodexAdapter(runner),
    new ClaudeAdapter(runner),
    new GeminiAdapter(runner),
  ];
  return new Map(adapters.map((adapter) => [adapter.provider, adapter]));
}
