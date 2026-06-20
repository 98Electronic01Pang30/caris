import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("ArtifactStore", () => {
  it("creates, checkpoints, and lists runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-artifacts-"));
    temporaryDirectories.push(root);
    const store = new ArtifactStore(root);
    const state = await store.createRun("test request", false);
    state.stage = "PLANNED";
    await store.saveState(state);

    await expect(store.loadState(state.id)).resolves.toMatchObject({ stage: "PLANNED" });
    await expect(store.listRuns()).resolves.toHaveLength(1);
    await expect(readFile(path.join(store.runDir(state.id), "request.md"), "utf8")).resolves.toBe(
      "test request\n",
    );
  });

  it("rejects path traversal in run ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-artifacts-"));
    temporaryDirectories.push(root);
    const store = new ArtifactStore(root);
    await expect(store.loadState("../outside")).rejects.toThrow("Invalid run id");
  });
});
