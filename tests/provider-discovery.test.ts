import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProviderExecutable, providerDescriptors } from "../src/provider-discovery.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("provider discovery", () => {
  it("prefers an explicit executable override", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-discovery-"));
    temporaryDirectories.push(root);
    const override = path.join(root, "custom-codex.exe");
    const descriptor = providerDescriptors.find((item) => item.id === "codex")!;
    const result = discoverProviderExecutable(descriptor, override, { PATH: "" });
    expect(result.selected).toBe(override);
  });

  it("searches PATH before standard npm directories and reports duplicates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-discovery-"));
    temporaryDirectories.push(root);
    const pathBin = path.join(root, "path-bin");
    const appData = path.join(root, "appdata");
    const npmBin = path.join(appData, "npm");
    await Promise.all([mkdir(pathBin), mkdir(npmBin, { recursive: true })]);
    const filename = process.platform === "win32" ? "codex.cmd" : "codex";
    await Promise.all([
      writeFile(path.join(pathBin, filename), "", "utf8"),
      writeFile(path.join(npmBin, filename), "", "utf8"),
    ]);
    const descriptor = providerDescriptors.find((item) => item.id === "codex")!;
    const result = discoverProviderExecutable(descriptor, undefined, {
      PATH: pathBin,
      APPDATA: appData,
      USERPROFILE: root,
    });
    expect(result.selected).toBe(path.join(pathBin, filename));
    expect(result.candidates).toHaveLength(2);
  });

  it("finds Antigravity in its LocalAppData bin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caris-discovery-"));
    temporaryDirectories.push(root);
    const bin = path.join(root, "agy", "bin");
    await mkdir(bin, { recursive: true });
    const filename = process.platform === "win32" ? "agy.exe" : "agy";
    await writeFile(path.join(bin, filename), "", "utf8");
    const descriptor = providerDescriptors.find((item) => item.id === "antigravity")!;
    const result = discoverProviderExecutable(descriptor, undefined, { PATH: "", LOCALAPPDATA: root, USERPROFILE: root });
    expect(result.selected).toBe(path.join(bin, filename));
  });
});
