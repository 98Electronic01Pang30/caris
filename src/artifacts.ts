import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runStateSchema, type RunState, type UsageRecord } from "./domain.js";

export class ArtifactStore {
  readonly runsRoot: string;

  constructor(readonly projectRoot: string) {
    this.runsRoot = path.join(projectRoot, ".caris", "runs");
  }

  async createRun(
    request: string,
    planOnly: boolean,
    mentionedFiles: string[] = [],
    executionMode: RunState["executionMode"] = "pipeline",
  ): Promise<RunState> {
    const now = new Date().toISOString();
    const state: RunState = {
      id: randomUUID(),
      request,
      cwd: this.projectRoot,
      stage: "RECEIVED",
      executionMode,
      stepHistory: [],
      status: "running",
      feedback: [],
      debugAttempts: 0,
      createdAt: now,
      updatedAt: now,
      activeTimeMs: 0,
      activeSince: now,
      agentCalls: 0,
      planOnly,
      mentionedFiles,
      verification: [],
    };
    await mkdir(this.runDir(state.id), { recursive: true });
    await this.writeText(state.id, "request.md", `${request.trim()}\n`);
    await this.saveState(state);
    return state;
  }

  async saveState(state: RunState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    const validated = runStateSchema.parse(state);
    const target = this.file(state.id, "state.json");
    const temporary = `${target}.tmp`;
    await mkdir(this.runDir(state.id), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  async loadState(id: string): Promise<RunState> {
    this.assertRunId(id);
    const source = await readFile(this.file(id, "state.json"), "utf8");
    const raw = JSON.parse(source) as Record<string, unknown>;
    if (raw.status === undefined) {
      raw.status = raw.stage === "DONE" ? "completed"
        : raw.stage === "FAILED" ? "failed"
          : raw.stage === "CANCELLED" ? "cancelled"
            : "running";
    }
    return runStateSchema.parse(raw);
  }

  async writeText(id: string, name: string, content: string): Promise<void> {
    this.assertRunId(id);
    await mkdir(this.runDir(id), { recursive: true });
    await writeFile(this.file(id, name), content, "utf8");
  }

  async readText(id: string, name: string): Promise<string> {
    this.assertRunId(id);
    return readFile(this.file(id, name), "utf8");
  }

  async appendEvent(id: string, event: unknown): Promise<void> {
    this.assertRunId(id);
    await appendFile(
      this.file(id, "events.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), ...asRecord(event) })}\n`,
      "utf8",
    );
  }

  async appendUsage(id: string, usage: UsageRecord): Promise<void> {
    this.assertRunId(id);
    await appendFile(this.file(id, "usage.jsonl"), `${JSON.stringify(usage)}\n`, "utf8");
  }

  async listRuns(): Promise<RunState[]> {
    try {
      const entries = await readdir(this.runsRoot, { withFileTypes: true });
      const states: RunState[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          states.push(await this.loadState(entry.name));
        } catch {
          // Ignore incomplete directories; inspect by id still reports parse errors.
        }
      }
      return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  runDir(id: string): string {
    this.assertRunId(id);
    return path.join(this.runsRoot, id);
  }

  private file(id: string, name: string): string {
    if (path.basename(name) !== name) throw new Error(`Invalid artifact name: ${name}`);
    return path.join(this.runDir(id), name);
  }

  private assertRunId(id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error(`Invalid run id: ${id}`);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}
