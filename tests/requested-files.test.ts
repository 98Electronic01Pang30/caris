import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatRequestedFiles, readRequestedFiles } from "../src/requested-files.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("requested file context", () => {
  it("reads a file explicitly quoted in the request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-requested-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "app.log"), "first error\nsecond error\n", "utf8");

    const files = await readRequestedFiles("Read 'app.log' and plan a fix", root, 10_000);
    expect(files).toHaveLength(1);
    expect(files[0]?.content).toContain("second error");
    expect(formatRequestedFiles(files)).toContain(path.join(root, "app.log"));
  });

  it("samples the beginning and end of a large log", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-requested-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "large.log"), `START\n${"x".repeat(30_000)}\nEND`, "utf8");

    const [file] = await readRequestedFiles("Read `large.log`", root, 1_000);
    expect(file?.truncated).toBe(true);
    expect(file?.content).toContain("START");
    expect(file?.content).toContain("END");
    expect(file?.content).toContain("omitted");
  });

  it("ignores quoted prose that is not a file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-requested-"));
    temporaryDirectories.push(root);
    await expect(readRequestedFiles("Plan 'a normal feature'", root, 1_000)).resolves.toEqual([]);
  });
});
