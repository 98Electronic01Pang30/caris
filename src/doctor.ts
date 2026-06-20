import type { AdapterRegistry } from "./adapters/registry.js";
import type { ProviderHealth } from "./domain.js";
import type { ProcessRunner } from "./process-runner.js";

export interface DoctorReport {
  node: { status: "READY" | "UNAVAILABLE"; version: string };
  git: { status: "READY" | "UNAVAILABLE"; version: string };
  providers: ProviderHealth[];
}

export async function runDoctor(
  cwd: string,
  adapters: AdapterRegistry,
  runner: ProcessRunner,
): Promise<DoctorReport> {
  const [git, providers] = await Promise.all([
    runner.run({ executable: "git", args: ["--version"], cwd, timeoutMs: 10_000 }),
    Promise.all([...adapters.values()].map((adapter) => adapter.detect(cwd))),
  ]);
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
      provider.version ?? provider.detail ?? "",
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
