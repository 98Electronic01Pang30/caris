import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecaProcessRunner } from "../src/process-runner.js";
import { captureWorkspaceDiff, detectWorkspaceContext, DIRECTORY_DIFF_UNAVAILABLE } from "../src/repository.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("captureWorkspaceDiff", () => {
  it("classifies a plain directory and reports diff as unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-directory-"));
    roots.push(root);
    const runner = new ExecaProcessRunner();
    const context = await detectWorkspaceContext(root, runner);
    expect(context).toEqual({ kind: "directory", root, canDiff: false });
    await expect(captureWorkspaceDiff(root, runner, context)).resolves.toBe(DIRECTORY_DIFF_UNAVAILABLE);
  });

  it("includes tracked, staged, untracked text, and binary changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-diff-"));
    roots.push(root);
    const runner = new ExecaProcessRunner();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "tracked.txt"), "before\n", "utf8");
    for (const args of [["init"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Test"], ["add", "."], ["commit", "-m", "base"]]) {
      expect((await runner.run({ executable: "git", args, cwd: root })).exitCode).toBe(0);
    }
    await writeFile(path.join(root, "src", "tracked.txt"), "after\n", "utf8");
    await writeFile(path.join(root, "staged.txt"), "staged\n", "utf8");
    await runner.run({ executable: "git", args: ["add", "staged.txt"], cwd: root });
    await writeFile(path.join(root, "new.txt"), "new\n", "utf8");
    await writeFile(path.join(root, "image.bin"), Buffer.from([0, 1, 2]));
    const diff = await captureWorkspaceDiff(root, runner);
    await expect(detectWorkspaceContext(root, runner)).resolves.toMatchObject({ kind: "git", canDiff: true });
    expect(diff).toContain("tracked.txt");
    expect(diff).toContain("staged.txt");
    expect(diff).toContain("+++ b/new.txt");
    expect(diff).toContain("Binary file added: image.bin");
  });
});
