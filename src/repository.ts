import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ProcessRunner } from "./process-runner.js";

const excluded = new Set([".git", ".caris", "node_modules", "dist", "coverage"]);

export async function summarizeRepository(cwd: string): Promise<string> {
  const files: string[] = [];
  await walk(cwd, cwd, files);
  const visible = files.slice(0, 300);
  return [
    `Project root: ${cwd}`,
    `Visible files: ${files.length}`,
    "Files:",
    ...visible.map((file) => `- ${file}`),
    ...(files.length > visible.length ? [`- ... ${files.length - visible.length} more`] : []),
  ].join("\n");
}

async function walk(root: string, current: string, output: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (excluded.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, output);
    } else if (entry.isFile()) {
      output.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
}

export async function captureWorkspaceDiff(
  cwd: string,
  runner: ProcessRunner,
): Promise<string> {
  const status = await runner.run({ executable: "git", args: ["status", "--short"], cwd });
  const diff = await runner.run({ executable: "git", args: ["diff", "--no-ext-diff"], cwd });
  return [`## Status`, status.stdout.trim(), "", "## Diff", diff.stdout.trim(), ""].join("\n");
}
