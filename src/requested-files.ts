import { open, stat } from "node:fs/promises";
import path from "node:path";

export interface RequestedFileContext {
  path: string;
  content: string;
  truncated: boolean;
}

export async function readRequestedFiles(
  request: string,
  cwd: string,
  totalLimit: number,
  mentionedFiles: string[] = [],
): Promise<RequestedFileContext[]> {
  const candidates = [...mentionedFiles, ...extractQuotedValues(request)];
  const contexts: RequestedFileContext[] = [];
  const seen = new Set<string>();
  let remaining = totalLimit;

  for (const candidate of candidates) {
    if (remaining <= 0) break;
    const absolute = path.resolve(cwd, candidate);
    if (mentionedFiles.includes(candidate) && !isInside(cwd, absolute)) continue;
    const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const metadata = await stat(absolute);
      if (!metadata.isFile()) continue;
      const fileLimit = Math.min(remaining, 24_000);
      const { content, truncated } = await readTextSample(absolute, metadata.size, fileLimit);
      contexts.push({ path: absolute, content, truncated });
      remaining -= content.length;
    } catch {
      // Quoted prose and paths that do not exist are not file context.
    }
  }
  return contexts;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function formatRequestedFiles(files: RequestedFileContext[]): string {
  if (files.length === 0) return "";
  return files
    .map(
      (file) =>
        `### ${file.path}${file.truncated ? " (truncated: first and last sections)" : ""}\n\n` +
        "```text\n" +
        `${file.content}\n` +
        "```",
    )
    .join("\n\n");
}

function extractQuotedValues(request: string): string[] {
  return [...request.matchAll(/(["'`])([^"'`\r\n]+)\1/g)]
    .map((match) => match[2]?.trim())
    .filter((value): value is string => Boolean(value));
}

async function readTextSample(
  filename: string,
  size: number,
  limit: number,
): Promise<{ content: string; truncated: boolean }> {
  const handle = await open(filename, "r");
  try {
    if (size <= limit) {
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      return { content: decodeText(buffer), truncated: false };
    }

    const half = Math.floor(limit / 2);
    const first = Buffer.alloc(half);
    const last = Buffer.alloc(limit - half);
    await handle.read(first, 0, first.length, 0);
    await handle.read(last, 0, last.length, Math.max(0, size - last.length));
    return {
      content: `${decodeText(first)}\n\n... omitted ${size - limit} bytes ...\n\n${decodeText(last)}`,
      truncated: true,
    };
  } finally {
    await handle.close();
  }
}

function decodeText(buffer: Buffer): string {
  if (buffer.includes(0)) return "[binary file omitted]";
  return buffer.toString("utf8");
}
