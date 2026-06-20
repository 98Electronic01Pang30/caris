import { describe, expect, it } from "vitest";
import { ModelCatalogService } from "../src/model-catalog.js";
import type { ProcessRunner } from "../src/process-runner.js";

describe("ModelCatalogService", () => {
  it("parses visible Codex models and reasoning efforts", async () => {
    const runner: ProcessRunner = {
      async run() {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            models: [
              {
                slug: "gpt-test",
                display_name: "GPT Test",
                visibility: "list",
                default_reasoning_level: "medium",
                supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
              },
              { slug: "hidden", visibility: "hide" },
            ],
          }),
          stderr: "",
          durationMs: 1,
          failed: false,
          timedOut: false,
          cancelled: false,
        };
      },
    };
    await expect(new ModelCatalogService(runner).list("codex", process.cwd())).resolves.toEqual([
      {
        id: "gpt-test",
        label: "GPT Test",
        efforts: ["low", "medium"],
        defaultEffort: "medium",
      },
    ]);
  });

  it("exposes provider aliases without hard-coding model versions", async () => {
    const service = new ModelCatalogService({ run: async () => { throw new Error("not used"); } });
    expect((await service.list("claude", process.cwd())).map((item) => item.id)).toContain("sonnet");
    expect(await service.list("gemini", process.cwd())).toEqual([
      { id: "auto", label: "Auto", efforts: [] },
    ]);
  });
});
