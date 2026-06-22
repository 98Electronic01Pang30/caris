import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CarisConfig, ProviderCapabilities, ProviderName } from "./domain.js";
import type { ProcessRunner } from "./process-runner.js";
import type { AgentAdapter } from "./adapters/agent-adapter.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { GeminiAdapter } from "./adapters/gemini.js";
import { AntigravityAdapter } from "./adapters/antigravity.js";

export interface ProviderDescriptor {
  id: ProviderName;
  commands: string[];
  standardDirectories: (env: NodeJS.ProcessEnv) => string[];
  capabilities: ProviderCapabilities;
  create: (runner: ProcessRunner | undefined, executable: string, candidates: string[]) => AgentAdapter;
}

export interface DiscoveredExecutable {
  selected: string;
  candidates: string[];
}

const commonDirectories = (env: NodeJS.ProcessEnv): string[] => [
  env.APPDATA ? path.join(env.APPDATA, "npm") : "",
  env.PNPM_HOME ?? "",
  path.join(env.USERPROFILE ?? os.homedir(), ".local", "bin"),
].filter(Boolean);

export const providerDescriptors: ProviderDescriptor[] = [
  {
    id: "codex",
    commands: ["codex"],
    capabilities: { streaming: true, approvals: true, questions: true, steering: true, resume: false },
    standardDirectories: commonDirectories,
    create: (runner, executable, candidates) => new CodexAdapter(runner, executable, candidates),
  },
  {
    id: "claude",
    commands: ["claude"],
    capabilities: { streaming: true, approvals: true, questions: true, steering: true, resume: false },
    standardDirectories: (env) => [
      ...commonDirectories(env),
      path.join(env.USERPROFILE ?? os.homedir(), ".claude", "local"),
    ],
    create: (runner, executable, candidates) => new ClaudeAdapter(runner, executable, candidates),
  },
  {
    id: "gemini",
    commands: ["gemini"],
    capabilities: { streaming: true, approvals: true, questions: false, steering: false, resume: false },
    standardDirectories: commonDirectories,
    create: (runner, executable, candidates) => new GeminiAdapter(runner, executable, candidates),
  },
  {
    id: "antigravity",
    commands: ["agy"],
    capabilities: { streaming: false, approvals: false, questions: false, steering: false, resume: false },
    standardDirectories: (env) => [
      ...commonDirectories(env),
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "agy", "bin") : "",
    ].filter(Boolean),
    create: (runner, executable, candidates) => new AntigravityAdapter(runner, executable, candidates),
  },
];

export function discoverProviderExecutable(
  descriptor: ProviderDescriptor,
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): DiscoveredExecutable {
  const candidates: string[] = [];
  if (override) candidates.push(override);
  const pathDirectories = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const directories = [...pathDirectories, ...descriptor.standardDirectories(env)];
  const extensions = process.platform === "win32"
    ? [".exe", ".cmd", "", ".bat", ".com", ".ps1"]
    : [""];
  for (const directory of directories) {
    for (const command of descriptor.commands) {
      const commandExtensions = path.extname(command) ? [""] : extensions;
      for (const extension of commandExtensions) {
        const candidate = path.join(directory, `${command}${extension}`);
        if (existsSync(candidate)) candidates.push(candidate);
      }
    }
  }
  const unique = deduplicate(candidates);
  return { selected: unique[0] ?? override ?? descriptor.commands[0]!, candidates: unique };
}

export function discoverAdapters(
  runner?: ProcessRunner,
  configs?: CarisConfig["providers"],
): Map<ProviderName, AgentAdapter> {
  return new Map(providerDescriptors.map((descriptor) => {
    const discovery = discoverProviderExecutable(descriptor, configs?.[descriptor.id].executable);
    return [descriptor.id, descriptor.create(runner, discovery.selected, discovery.candidates)];
  }));
}

function deduplicate(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    let canonical = path.resolve(value);
    try { canonical = realpathSync.native(value); } catch { /* Keep unresolved overrides for diagnostics. */ }
    if (process.platform === "win32") canonical = canonical.toLowerCase();
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}
