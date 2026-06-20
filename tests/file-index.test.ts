import { describe, expect, it } from "vitest";
import {
  activeMentionToken,
  buildFileIndex,
  extractMentionPaths,
  insertMention,
  invalidMentionPaths,
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
});
