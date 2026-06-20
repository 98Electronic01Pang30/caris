import YAML from "yaml";
import { createAdapterRegistry } from "./adapters/registry.js";
import { ArtifactStore } from "./artifacts.js";
import { loadConfig } from "./config.js";
import { carisConfigSchema, type CarisConfig } from "./domain.js";
import { ExecaProcessRunner } from "./process-runner.js";
import { WorkflowEngine } from "./workflow.js";

export async function createRuntime(
  cwd: string,
  runId?: string,
): Promise<{
  config: CarisConfig;
  store: ArtifactStore;
  runner: ExecaProcessRunner;
  adapters: ReturnType<typeof createAdapterRegistry>;
  engine: WorkflowEngine;
}> {
  const store = new ArtifactStore(cwd);
  let config = await loadConfig(cwd);
  if (runId) {
    try {
      config = carisConfigSchema.parse(YAML.parse(await store.readText(runId, "config.snapshot.yaml")));
    } catch {
      // Older or incomplete runs can still resume with the current project config.
    }
  }
  const runner = new ExecaProcessRunner();
  const adapters = createAdapterRegistry(runner);
  const engine = new WorkflowEngine(config, adapters, runner, store);
  return { config, store, runner, adapters, engine };
}
