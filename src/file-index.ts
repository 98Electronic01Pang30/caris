import path from "node:path";
import { stat } from "node:fs/promises";
import Fuse from "fuse.js";
import type { ProcessRunner } from "./process-runner.js";

export interface FileIndexEntry {
  path: string;
  kind: "file" | "directory";
}

export class FileIndex {
  private readonly fuse: Fuse<FileIndexEntry>;

  constructor(readonly entries: FileIndexEntry[]) {
    this.fuse = new Fuse(entries, {
      keys: ["path"],
      threshold: 0.38,
      ignoreLocation: true,
      shouldSort: true,
    });
  }

  search(query: string, directory = "", limit = 8): FileIndexEntry[] {
    const normalizedDirectory = normalizeDirectory(directory);
    const pool = query.trim()
      ? this.fuse.search(`${normalizedDirectory}${query}`).map((result) => result.item)
      : this.entries;
    const seen = new Set<string>();
    const results: FileIndexEntry[] = [];
    for (const entry of pool) {
      if (normalizedDirectory && !entry.path.startsWith(normalizedDirectory)) continue;
      const relative = normalizedDirectory ? entry.path.slice(normalizedDirectory.length) : entry.path;
      if (!relative || relative.includes("/") && entry.kind === "file") continue;
      const immediate = relative.split("/")[0];
      if (!immediate) continue;
      const candidatePath = normalizedDirectory + immediate;
      const candidate = this.entries.find((item) => item.path === candidatePath) ?? entry;
      if (seen.has(candidate.path)) continue;
      seen.add(candidate.path);
      results.push(candidate);
      if (results.length >= limit) break;
    }
    return results;
  }
}

export async function buildFileIndex(cwd: string, runner: ProcessRunner): Promise<FileIndex> {
  const result = await runner.run({
    executable: "git",
    args: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    cwd,
    timeoutMs: 30_000,
  });
  const files = result.exitCode === 0
    ? result.stdout.split("\0").filter(Boolean).map(normalizePath)
    : [];
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return new FileIndex([
    ...[...directories].sort().map((directory) => ({ path: directory, kind: "directory" as const })),
    ...files.sort().map((file) => ({ path: file, kind: "file" as const })),
  ]);
}

export interface MentionToken {
  start: number;
  query: string;
}

export function activeMentionToken(input: string): MentionToken | undefined {
  const match = input.match(/(?:^|\s)@(?:"([^"]*)|([^\s]*))$/);
  if (!match) return undefined;
  const marker = input.lastIndexOf("@");
  return { start: marker, query: match[1] ?? match[2] ?? "" };
}

export function insertMention(input: string, token: MentionToken, filename: string): string {
  const rendered = /\s/.test(filename) ? `@"${filename}"` : `@${filename}`;
  return `${input.slice(0, token.start)}${rendered} `;
}

export function extractMentionPaths(input: string): string[] {
  return [...input.matchAll(/@(?:"([^"]+)"|([^\s]+))/g)]
    .map((match) => match[1] ?? match[2])
    .filter((value): value is string => Boolean(value));
}

export async function invalidMentionPaths(cwd: string, files: string[]): Promise<string[]> {
  const root = path.resolve(cwd);
  const invalid: string[] = [];
  for (const file of files) {
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      invalid.push(file);
      continue;
    }
    try {
      if (!(await stat(absolute)).isFile()) invalid.push(file);
    } catch {
      invalid.push(file);
    }
  }
  return invalid;
}

export function parentDirectory(directory: string): string {
  const normalized = normalizePath(directory).replace(/\/$/, "");
  const parent = path.posix.dirname(normalized);
  return parent === "." ? "" : parent;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeDirectory(value: string): string {
  const normalized = normalizePath(value).replace(/^\/+|\/+$/g, "");
  return normalized ? `${normalized}/` : "";
}
