import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML, { isMap, YAMLMap } from "yaml";
import {
  carisConfigSchema,
  type CarisConfig,
  type ProviderName,
  type ProviderRuntimeConfig,
} from "./domain.js";

export const CONFIG_FILENAME = "caris.config.yaml";

export const defaultConfig: CarisConfig = {
  version: 1,
  agents: {
    planner: { provider: "gemini", fallback: ["codex", "claude"] },
    implementer: { provider: "codex", fallback: ["claude"] },
    debugger: { provider: "claude", fallback: ["codex"] },
    verifier: { provider: "auto", fallback: [] },
    reviewer: { provider: "gemini", fallback: ["claude", "codex"] },
  },
  providers: { codex: {}, claude: {}, gemini: {}, antigravity: {} },
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

export async function saveProviderConfig(
  cwd: string,
  provider: ProviderName,
  settings: ProviderRuntimeConfig,
): Promise<void> {
  const filename = path.join(cwd, CONFIG_FILENAME);
  const source = (await configExists(cwd))
    ? await readFile(filename, "utf8")
    : YAML.stringify(defaultConfig);
  const document = YAML.parseDocument(source);
  const existingProviders = document.get("providers", true);
  const providers = (isMap(existingProviders) ? existingProviders : new YAMLMap()) as YAMLMap;
  if (!isMap(existingProviders)) document.set("providers", providers);
  const existingProvider = providers.get(provider, true);
  const providerNode = (isMap(existingProvider) ? existingProvider : new YAMLMap()) as YAMLMap;
  if (!isMap(existingProvider)) providers.set(provider, providerNode);
  setOptionalYamlValue(providerNode, "executable", settings.executable);
  setOptionalYamlValue(providerNode, "model", settings.model);
  setOptionalYamlValue(
    providerNode,
    "effort",
    provider === "gemini" || provider === "antigravity" ? undefined : settings.effort,
  );
  const temporary = `${filename}.tmp`;
  await writeFile(temporary, document.toString(), "utf8");
  await rename(temporary, filename);
}

function setOptionalYamlValue(map: YAMLMap, key: string, value: string | undefined): void {
  if (value) map.set(key, value);
  else map.delete(key);
}
