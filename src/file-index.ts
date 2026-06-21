import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import Fuse from "fuse.js";
import ignore from "ignore";
import type { ProcessRunner } from "./process-runner.js";

export interface FileIndexEntry {
  path: string;
  kind: "file" | "directory";
}

export type FileIndexSource = "git" | "filesystem";

export interface FileIndexOptions {
  maxFiles?: number;
}

export class FileIndex {
  private readonly fuse: Fuse<FileIndexEntry>;

  constructor(
    readonly entries: FileIndexEntry[],
    readonly source: FileIndexSource = "git",
    readonly truncated = false,
    readonly diagnostic?: string,
  ) {
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

export async function buildFileIndex(
  cwd: string,
  runner: ProcessRunner,
  options: FileIndexOptions = {},
): Promise<FileIndex> {
  const result = await runner.run({
    executable: "git",
    args: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    cwd,
    timeoutMs: 30_000,
  });
  if (result.exitCode === 0) {
    const files = result.stdout.split("\0").filter(Boolean).map(normalizePath);
    return createFileIndex(files, "git", false, files.length === 0 ? "No project files found." : undefined);
  }

  const maxFiles = options.maxFiles ?? 20_000;
  const scanned = await scanDirectory(cwd, maxFiles);
  const diagnostic = scanned.truncated
    ? `Filesystem index limited to ${maxFiles.toLocaleString()} files.`
    : scanned.files.length === 0
      ? "No project files found in this directory."
      : "Git index unavailable; using filesystem files.";
  return createFileIndex(scanned.files, "filesystem", scanned.truncated, diagnostic);
}

function createFileIndex(
  files: string[],
  source: FileIndexSource,
  truncated: boolean,
  diagnostic?: string,
): FileIndex {
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
  ], source, truncated, diagnostic);
}

const excludedDirectories = new Set([
  ".git",
  ".caris",
  "node_modules",
  "dist",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".gradle",
]);

async function scanDirectory(cwd: string, maxFiles: number): Promise<{ files: string[]; truncated: boolean }> {
  const matcher = ignore();
  try {
    matcher.add(await readFile(path.join(cwd, ".gitignore"), "utf8"));
  } catch {
    // A .gitignore is optional in directory workspaces.
  }
  const files: string[] = [];
  let truncated = false;
  const visit = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      const relative = normalizePath(path.relative(cwd, absolute));
      if (entry.isDirectory()) {
        if (excludedDirectories.has(entry.name) || matcher.ignores(`${relative}/`)) continue;
        await visit(absolute);
        if (truncated) return;
      } else if (entry.isFile() && !matcher.ignores(relative)) {
        files.push(relative);
      }
    }
  };
  await visit(cwd);
  return { files, truncated };
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

export async function resolveSubmittedMentions(
  cwd: string,
  input: string,
  selectedAttachments: string[],
): Promise<{ files: string[]; invalid: string[] }> {
  const seen = new Set<string>();
  const files = [...selectedAttachments, ...extractMentionPaths(input)].filter((file) => {
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const invalid = await invalidMentionPaths(cwd, files);
  const invalidKeys = new Set(invalid.map((file) => process.platform === "win32" ? file.toLowerCase() : file));
  return {
    files: files.filter((file) => !invalidKeys.has(process.platform === "win32" ? file.toLowerCase() : file)),
    invalid,
  };
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
