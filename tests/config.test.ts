import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, saveProviderConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const legacyConfig = `# project comment
version: 1
agents:
  planner: { provider: codex, fallback: [] }
  implementer: { provider: codex, fallback: [] }
  debugger: { provider: claude, fallback: [codex] }
  reviewer: { provider: gemini, fallback: [codex] }
budgets:
  maxAgentCalls: 8
  maxWallTimeMinutes: 30
  maxContextCharsPerCall: 60000
  maxRetriesPerStep: 2
verification:
  commands: []
`;

describe("provider config", () => {
  it("loads legacy version 1 config with provider defaults", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-config-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "caris.config.yaml"), legacyConfig, "utf8");
    await expect(loadConfig(root)).resolves.toMatchObject({
      agents: { verifier: { provider: "auto", fallback: [] } },
      providers: { codex: {}, claude: {}, gemini: {}, antigravity: {} },
    });
  });

  it("saves one provider atomically without removing comments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-config-"));
    temporaryDirectories.push(root);
    const filename = path.join(root, "caris.config.yaml");
    await writeFile(filename, legacyConfig, "utf8");
    await saveProviderConfig(root, "codex", { model: "gpt-test", effort: "high" });
    const source = await readFile(filename, "utf8");
    expect(source).toContain("# project comment");
    await expect(loadConfig(root)).resolves.toMatchObject({
      providers: { codex: { model: "gpt-test", effort: "high" } },
    });
  });

  it("loads and saves provider transport overrides", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-config-"));
    temporaryDirectories.push(root);
    const filename = path.join(root, "caris.config.yaml");
    await writeFile(filename, legacyConfig, "utf8");
    await saveProviderConfig(root, "codex", { model: "gpt-test", transport: "acp" });
    await expect(loadConfig(root)).resolves.toMatchObject({
      providers: { codex: { model: "gpt-test", transport: "acp" } },
    });
  });

  it("saves Claude model and effort into a YAML collection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-config-"));
    temporaryDirectories.push(root);
    const filename = path.join(root, "caris.config.yaml");
    await writeFile(filename, `${legacyConfig}providers:\n  claude: {} # keep claude comment\n`, "utf8");
    await saveProviderConfig(root, "claude", { model: "sonnet", effort: "high" });
    const source = await readFile(filename, "utf8");
    expect(source).toContain("# keep claude comment");
    await expect(loadConfig(root)).resolves.toMatchObject({ providers: { claude: { model: "sonnet", effort: "high" } } });
  });

  it("repairs scalar provider nodes and removes default overrides", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-config-"));
    temporaryDirectories.push(root);
    const filename = path.join(root, "caris.config.yaml");
    await writeFile(filename, `${legacyConfig}providers:\n  claude: broken\n`, "utf8");
    await saveProviderConfig(root, "claude", { model: "sonnet", effort: "medium" });
    await saveProviderConfig(root, "claude", {});
    await expect(loadConfig(root)).resolves.toMatchObject({ providers: { claude: {} } });
  });
});
