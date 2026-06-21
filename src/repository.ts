import { readFile, readdir, stat } from "node:fs/promises";
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
  const status = await runner.run({ executable: "git", args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd });
  let diff = await runner.run({ executable: "git", args: ["diff", "HEAD", "--no-ext-diff"], cwd });
  if (diff.exitCode !== 0) {
    const [unstaged, staged] = await Promise.all([
      runner.run({ executable: "git", args: ["diff", "--no-ext-diff"], cwd }),
      runner.run({ executable: "git", args: ["diff", "--cached", "--no-ext-diff"], cwd }),
    ]);
    diff = { ...unstaged, stdout: [staged.stdout, unstaged.stdout].filter(Boolean).join("\n") };
  }
  const entries = status.stdout.split("\0").filter(Boolean);
  const untracked = entries
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3));
  const untrackedPatches = await Promise.all(untracked.map((file) => untrackedPatch(cwd, file)));
  return [
    "## Status",
    entries.map((entry) => entry.replace(/^(.{2}) /, "$1 ")).join("\n"),
    "",
    "## Diff",
    diff.stdout.trim(),
    ...untrackedPatches.filter(Boolean),
    "",
  ].join("\n");
}

async function untrackedPatch(cwd: string, relative: string): Promise<string> {
  const absolute = path.resolve(cwd, relative);
  if (!absolute.startsWith(`${path.resolve(cwd)}${path.sep}`)) return "";
  try {
    const metadata = await stat(absolute);
    if (!metadata.isFile()) return "";
    const buffer = await readFile(absolute);
    if (buffer.subarray(0, 8_192).includes(0)) return `\nBinary file added: ${relative}`;
    const source = buffer.toString("utf8");
    return [
      "",
      `diff --git a/${relative} b/${relative}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${relative}`,
      `@@ -0,0 +1,${source.split(/\r?\n/).length} @@`,
      ...source.split(/\r?\n/).map((line) => `+${line}`),
    ].join("\n");
  } catch {
    return "";
  }
}
