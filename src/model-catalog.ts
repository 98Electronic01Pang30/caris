import type { ProviderName } from "./domain.js";
import type { ProcessRunner } from "./process-runner.js";

export interface ModelOption {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort?: string;
}

export class ModelCatalogService {
  constructor(private readonly runner: ProcessRunner) {}

  async list(provider: ProviderName, cwd: string): Promise<ModelOption[]> {
    if (provider === "codex") return this.codexModels(cwd);
    if (provider === "claude") {
      return ["default", "best", "fable", "sonnet", "opus", "haiku", "sonnet[1m]", "opus[1m]"].map(
        (id) => ({ id, label: id, efforts: ["low", "medium", "high", "xhigh", "max"] }),
      );
    }
    if (provider === "antigravity") return [];
    return [{ id: "auto", label: "Auto", efforts: [] }];
  }

  private async codexModels(cwd: string): Promise<ModelOption[]> {
    const result = await this.runner.run({
      executable: "codex",
      args: ["debug", "models", "--bundled"],
      cwd,
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) return [];
    try {
      const catalog = JSON.parse(result.stdout) as { models?: CodexModel[] };
      return (catalog.models ?? [])
        .filter((model) => model.visibility === "list")
        .map((model) => ({
          id: model.slug,
          label: model.display_name || model.slug,
          efforts: (model.supported_reasoning_levels ?? []).map((level) => level.effort),
          ...(model.default_reasoning_level
            ? { defaultEffort: model.default_reasoning_level }
            : {}),
        }));
    } catch {
      return [];
    }
  }
}

interface CodexModel {
  slug: string;
  display_name?: string;
  visibility?: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{ effort: string }>;
}
