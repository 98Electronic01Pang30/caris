import type { AdapterRegistry } from "./adapters/registry.js";
import type { CarisConfig, ProviderHealth, WorkspaceContext } from "./domain.js";
import type { ProcessRunner } from "./process-runner.js";
import { classifyProviderFailure, summarizeAgentFailure } from "./provider-health.js";
import { detectWorkspaceContext } from "./repository.js";

export interface DoctorReport {
  node: { status: "READY" | "UNAVAILABLE"; version: string };
  git: { status: "READY" | "UNAVAILABLE"; version: string };
  workspace: WorkspaceContext;
  providers: ProviderHealth[];
}

export async function runDoctor(
  cwd: string,
  adapters: AdapterRegistry,
  runner: ProcessRunner,
  live = false,
  providerConfigs?: CarisConfig["providers"],
): Promise<DoctorReport> {
  const [git, workspace, detectedProviders] = await Promise.all([
    runner.run({ executable: "git", args: ["--version"], cwd, timeoutMs: 10_000 }),
    detectWorkspaceContext(cwd, runner),
    Promise.all([...adapters.values()].map((adapter) => adapter.detect(cwd))),
  ]);
  const providers = live
    ? await Promise.all(
        detectedProviders.map(async (health) => {
          if (health.status !== "INSTALLED" && health.status !== "READY") return health;
          const adapter = adapters.get(health.provider);
          if (!adapter) return health;
          const providerConfig = providerConfigs?.[health.provider];
          const model = providerConfig?.model;
          const effort = providerConfig && "effort" in providerConfig
            ? providerConfig.effort
            : undefined;
          const result = await adapter.execute({
            role: "planner",
            prompt: "Respond with only OK. Do not use tools.",
            cwd,
            timeoutMs: 60_000,
            workspaceContext: workspace,
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
          });
          if (result.exitCode === 0) {
            return { ...health, status: "READY" as const, detail: "Live authentication probe passed" };
          }
          return {
            ...health,
            status: classifyProviderFailure(result),
            detail: `Live probe failed: ${summarizeAgentFailure(result, 180)}`,
          };
        }),
      )
    : detectedProviders;
  return {
    node: { status: "READY", version: process.version },
    git: {
      status: git.exitCode === 0 ? "READY" : "UNAVAILABLE",
      version: (git.stdout || git.stderr).trim(),
    },
    workspace,
    providers,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const rows = [
    ["Node", report.node.status, report.node.version],
    ["Git", report.git.status, report.git.version],
    [
      "Workspace",
      report.workspace.kind === "git" ? "READY" : "DIRECTORY",
      report.workspace.kind === "git"
        ? `Git root: ${report.workspace.root}`
        : "Git diff/recovery unavailable; run git init and create a baseline commit to enable them",
    ],
    ...report.providers.map((provider) => [
      provider.provider,
      provider.status,
      [provider.version, provider.detail].filter(Boolean).join("; "),
      provider.candidates && provider.candidates.length > 1
        ? `selected=${provider.executable}; alternatives=${provider.candidates.filter((item) => item !== provider.executable).join(", ")}`
        : `executable=${provider.executable}`,
    ]),
  ];
  const widths = [0, 1, 2, 3].map((index) =>
    Math.max(...rows.map((row) => row[index]?.length ?? 0)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
