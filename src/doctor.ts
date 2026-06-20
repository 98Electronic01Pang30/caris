import type { AdapterRegistry } from "./adapters/registry.js";
import type { CarisConfig, ProviderHealth } from "./domain.js";
import type { ProcessRunner } from "./process-runner.js";
import { classifyProviderFailure, summarizeAgentFailure } from "./provider-health.js";

export interface DoctorReport {
  node: { status: "READY" | "UNAVAILABLE"; version: string };
  git: { status: "READY" | "UNAVAILABLE"; version: string };
  providers: ProviderHealth[];
}

export async function runDoctor(
  cwd: string,
  adapters: AdapterRegistry,
  runner: ProcessRunner,
  live = false,
  providerConfigs?: CarisConfig["providers"],
): Promise<DoctorReport> {
  const [git, detectedProviders] = await Promise.all([
    runner.run({ executable: "git", args: ["--version"], cwd, timeoutMs: 10_000 }),
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
    providers,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const rows = [
    ["Node", report.node.status, report.node.version],
    ["Git", report.git.status, report.git.version],
    ...report.providers.map((provider) => [
      provider.provider,
      provider.status,
      [provider.version, provider.detail].filter(Boolean).join("; "),
    ]),
  ];
  const widths = [0, 1, 2].map((index) =>
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
