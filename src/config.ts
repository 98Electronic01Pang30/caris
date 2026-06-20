import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { carisConfigSchema, type CarisConfig } from "./domain.js";

export const CONFIG_FILENAME = "caris.config.yaml";

export const defaultConfig: CarisConfig = {
  version: 1,
  agents: {
    planner: { provider: "gemini", fallback: ["codex", "claude"] },
    implementer: { provider: "codex", fallback: ["claude"] },
    debugger: { provider: "claude", fallback: ["codex"] },
    reviewer: { provider: "gemini", fallback: ["claude", "codex"] },
  },
  budgets: {
    maxAgentCalls: 8,
    maxWallTimeMinutes: 30,
    maxContextCharsPerCall: 60_000,
    maxRetriesPerStep: 2,
  },
  verification: { commands: [] },
};

export async function configExists(cwd: string): Promise<boolean> {
  try {
    await access(path.join(cwd, CONFIG_FILENAME));
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(cwd: string): Promise<CarisConfig> {
  const filename = path.join(cwd, CONFIG_FILENAME);
  if (!(await configExists(cwd))) {
    return structuredClone(defaultConfig);
  }
  const source = await readFile(filename, "utf8");
  return carisConfigSchema.parse(YAML.parse(source));
}

export async function writeDefaultConfig(cwd: string): Promise<string> {
  const filename = path.join(cwd, CONFIG_FILENAME);
  if (await configExists(cwd)) {
    throw new Error(`${CONFIG_FILENAME} already exists`);
  }
  await writeFile(filename, YAML.stringify(defaultConfig), "utf8");
  return filename;
}
