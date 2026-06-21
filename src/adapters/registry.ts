import type { ProviderName } from "../domain.js";
import type { ProcessRunner } from "../process-runner.js";
import type { AgentAdapter } from "./agent-adapter.js";
import type { CarisConfig } from "../domain.js";
import { discoverAdapters } from "../provider-discovery.js";

export type AdapterRegistry = Map<ProviderName, AgentAdapter>;

export function createAdapterRegistry(
  runner?: ProcessRunner,
  configs?: CarisConfig["providers"],
): AdapterRegistry {
  return discoverAdapters(runner, configs);
}
