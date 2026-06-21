import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  activeMentionToken,
  buildFileIndex,
  extractMentionPaths,
  insertMention,
  invalidMentionPaths,
  resolveSubmittedMentions,
} from "../src/file-index.js";
import type { ProcessRunner } from "../src/process-runner.js";

const runner: ProcessRunner = {
  async run() {
    return {
      exitCode: 0,
      stdout: "src/index.ts\0src/core/run.ts\0README.md\0docs/My Guide.md\0",
      stderr: "",
      durationMs: 1,
      failed: false,
      timedOut: false,
      cancelled: false,
    };
  },
};

describe("file index and mentions", () => {
  it("indexes immediate files and navigable directories", async () => {
    const index = await buildFileIndex(process.cwd(), runner);
    expect(index.search("").map((item) => item.path)).toEqual(
      expect.arrayContaining(["src", "docs", "README.md"]),
    );
    expect(index.search("", "src").map((item) => item.path)).toEqual(
      expect.arrayContaining(["src/core", "src/index.ts"]),
    );
  });

  it("inserts and extracts paths containing spaces", () => {
    const token = activeMentionToken("Review @My");
    expect(token).toBeDefined();
    const value = insertMention("Review @My", token!, "docs/My Guide.md");
    expect(value).toBe('Review @"docs/My Guide.md" ');
    expect(extractMentionPaths(value)).toEqual(["docs/My Guide.md"]);
  });

  it("rejects missing files and workspace escapes", async () => {
    await expect(
      invalidMentionPaths(process.cwd(), ["missing.file", "../outside.file"]),
    ).resolves.toEqual(["missing.file", "../outside.file"]);
  });

  it("resolves directly typed mentions together with selected attachments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-mentions-"));
    try {
      await mkdir(path.join(root, "docs"));
      await writeFile(path.join(root, "a.ts"), "a", "utf8");
      await writeFile(path.join(root, "docs", "My Guide.md"), "guide", "utf8");
      const resolved = await resolveSubmittedMentions(root, 'Review @a.ts and @"docs/My Guide.md"', ["a.ts"]);
      expect(resolved.files).toEqual(["a.ts", "docs/My Guide.md"]);
      expect(resolved.invalid).toEqual([]);
      const invalid = await resolveSubmittedMentions(root, "Review @missing.ts", []);
      expect(invalid.invalid).toEqual(["missing.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to bounded filesystem indexing outside Git", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-files-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "caris-files-outside-"));
    const failedGit: ProcessRunner = {
      async run() {
        return { exitCode: 128, stdout: "", stderr: "not a git repository", durationMs: 1, failed: true, timedOut: false, cancelled: false };
      },
    };
    try {
      await mkdir(path.join(root, "src"));
      await mkdir(path.join(root, "node_modules"));
      await mkdir(path.join(root, "ignored"));
      await writeFile(path.join(root, "README.md"), "readme", "utf8");
      await writeFile(path.join(root, "src", "My File.ts"), "source", "utf8");
      await writeFile(path.join(root, "node_modules", "package.js"), "generated", "utf8");
      await writeFile(path.join(root, "ignored", "secret.txt"), "ignored", "utf8");
      await writeFile(path.join(root, ".gitignore"), "ignored/\n", "utf8");
      await writeFile(path.join(outside, "outside.txt"), "outside", "utf8");
      await symlink(outside, path.join(root, "linked-outside"), "junction");

      const index = await buildFileIndex(root, failedGit);
      expect(index.source).toBe("filesystem");
      expect(index.diagnostic).toContain("using filesystem");
      expect(index.search("").map((item) => item.path)).toEqual(expect.arrayContaining(["src", "README.md", ".gitignore"]));
      expect(index.search("", "src").map((item) => item.path)).toContain("src/My File.ts");
      expect(index.entries.map((item) => item.path)).not.toEqual(expect.arrayContaining(["node_modules", "ignored", "linked-outside"]));
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
    }
  });

  it("reports when filesystem indexing reaches its limit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-files-limit-"));
    const failedGit: ProcessRunner = {
      async run() {
        return { exitCode: 128, stdout: "", stderr: "not git", durationMs: 1, failed: true, timedOut: false, cancelled: false };
      },
    };
    try {
      await Promise.all(["a.txt", "b.txt", "c.txt"].map((name) => writeFile(path.join(root, name), name, "utf8")));
      const index = await buildFileIndex(root, failedGit, { maxFiles: 2 });
      expect(index.truncated).toBe(true);
      expect(index.diagnostic).toContain("2 files");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
