#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { writeDefaultConfig } from "./config.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import type { ManualStep, RunState } from "./domain.js";
import { startRepl } from "./repl.js";
import { startTui } from "./tui.js";
import { createRuntime } from "./runtime.js";
import { formatWorkflowEvent } from "./workflow-event-format.js";
import type { WorkflowEvent } from "./workflow.js";
import { CARIS_VERSION } from "./version.js";
import { resolveSubmittedMentions } from "./file-index.js";
import { renderStoredTranscript } from "./stored-transcript.js";

const program = new Command();
program
  .name("caris")
  .description("Local-first orchestration harness for coding-agent CLIs")
  .version(CARIS_VERSION)
  .option("--plain", "use the plain line-oriented interface")
  .showHelpAfterError()
  .action(async ({ plain }: { plain?: boolean }) => {
    const useTui = !plain && process.stdin.isTTY && process.stdout.isTTY;
    if (useTui) await startTui(process.cwd());
    else await startRepl(process.cwd());
  });

program
  .command("init")
  .description("Create the default project configuration")
  .option("-C, --cwd <path>", "project directory", process.cwd())
  .action(async ({ cwd }: { cwd: string }) => {
    const filename = await writeDefaultConfig(path.resolve(cwd));
    console.log(`Created ${filename}`);
  });

program
  .command("doctor")
  .description("Inspect local tools and coding-agent providers")
  .option("-C, --cwd <path>", "project directory", process.cwd())
  .option("--json", "print JSON")
  .option("--live", "perform a minimal authenticated call to each installed provider")
  .action(async ({ cwd, json, live }: { cwd: string; json?: boolean; live?: boolean }) => {
    const root = path.resolve(cwd);
    const runtime = await createRuntime(root);
    const report = await runDoctor(
      root,
      runtime.adapters,
      runtime.runner,
      live ?? false,
      runtime.config.providers,
    );
    console.log(json ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
  });

program
  .command("run")
  .description("Run the default orchestration workflow")
  .argument("<request>", "coding task")
  .option("-C, --cwd <path>", "project directory", process.cwd())
  .option("--allow-non-git-write", "allow modifying roles without Git diff or recovery")
  .action(async (request: string, { cwd, allowNonGitWrite }: { cwd: string; allowNonGitWrite?: boolean }) => {
    const root = path.resolve(cwd);
    const mentions = await resolveCliMentions(root, request);
    const runtime = await createRuntime(root);
    const state = await runWithCancellation((signal) =>
      runtime.engine.start(request, false, { signal, onEvent: printEvent, mentionedFiles: mentions, ...(allowNonGitWrite !== undefined ? { allowNonGitWrite } : {}) }),
    );
    printFinal(state, runtime.store.runDir(state.id));
  });

program
  .command("plan")
  .description("Run only the configured planner role")
  .argument("<request>", "coding task")
  .option("-C, --cwd <path>", "project directory", process.cwd())
  .action(async (request: string, { cwd }: { cwd: string }) => {
    const root = path.resolve(cwd);
    const mentions = await resolveCliMentions(root, request);
    const runtime = await createRuntime(root);
    const state = await runWithCancellation((signal) => runtime.engine.startManual("PLAN", request, { signal, onEvent: printEvent, mentionedFiles: mentions }));
    printFinal(state, runtime.store.runDir(state.id));
  });

for (const definition of [
  { name: "implement", step: "IMPLEMENT", description: "Run only the configured implementer role" },
  { name: "debug", step: "DEBUG", description: "Run only the configured debugger role" },
  { name: "verify", step: "VERIFY", description: "Run verification commands and the verifier role" },
  { name: "review", step: "REVIEW", description: "Run only the configured reviewer role" },
] as const) {
  program
    .command(definition.name)
    .description(definition.description)
    .argument("[instruction]", "step instruction or scope", "")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .option("--run-id <id>", "continue an existing manual run")
    .option("--allow-non-git-write", "allow this modifying role without Git diff or recovery")
    .action(async (instruction: string, { cwd, runId, allowNonGitWrite }: { cwd: string; runId?: string; allowNonGitWrite?: boolean }) => {
      const root = path.resolve(cwd);
      const mentions = await resolveCliMentions(root, instruction);
      const runtime = await createRuntime(root, runId);
      const state = await runWithCancellation((signal) => runId
        ? runtime.engine.executeManual(runId, definition.step as ManualStep, instruction, { signal, onEvent: printEvent, mentionedFiles: mentions, ...(allowNonGitWrite !== undefined ? { allowNonGitWrite } : {}) })
        : runtime.engine.startManual(definition.step as ManualStep, instruction, { signal, onEvent: printEvent, mentionedFiles: mentions, ...(allowNonGitWrite !== undefined ? { allowNonGitWrite } : {}) }));
      printFinal(state, runtime.store.runDir(state.id));
    });
}

program
  .command("resume")
  .description("Resume or respond to a checkpointed run")
  .argument("<run-id>", "run identifier")
  .option("-C, --cwd <path>", "project directory", process.cwd())
  .option("--approve", "approve the current checkpoint")
  .option("--reject", "pause the current checkpoint")
  .option("--feedback <message>", "revise the completed step using feedback")
  .option("--allow-non-git-write", "allow a resumed modifying role without Git diff or recovery")
  .action(async (runId: string, { cwd, approve, reject, feedback, allowNonGitWrite }: { cwd: string; approve?: boolean; reject?: boolean; feedback?: string; allowNonGitWrite?: boolean }) => {
    const responses = [approve, reject, feedback !== undefined].filter(Boolean).length;
    if (responses > 1) throw new Error("Choose only one of --approve, --reject, or --feedback");
    const runtime = await createRuntime(path.resolve(cwd), runId);
    const state = await runWithCancellation((signal) =>
      approve
        ? runtime.engine.respond(runId, { kind: "approve" }, { signal, onEvent: printEvent, ...(allowNonGitWrite !== undefined ? { allowNonGitWrite } : {}) })
        : reject
          ? runtime.engine.respond(runId, { kind: "pause" }, { signal, onEvent: printEvent, ...(allowNonGitWrite !== undefined ? { allowNonGitWrite } : {}) })
          : feedback !== undefined
            ? runtime.engine.respond(runId, { kind: "feedback", message: feedback }, { signal, onEvent: printEvent, ...(allowNonGitWrite !== undefined ? { allowNonGitWrite } : {}) })
            : runtime.engine.resume(runId, { signal, onEvent: printEvent, ...(allowNonGitWrite !== undefined ? { allowNonGitWrite } : {}) }),
    );
    printFinal(state, runtime.store.runDir(state.id));
  });

program
  .command("inspect")
  .description("Inspect a run, or list recent runs")
  .argument("[run-id]", "run identifier")
  .option("-C, --cwd <path>", "project directory", process.cwd())
  .option("--json", "print JSON")
  .action(async (runId: string | undefined, { cwd, json }: { cwd: string; json?: boolean }) => {
    const runtime = await createRuntime(path.resolve(cwd));
    if (runId) {
      const state = await runtime.store.loadState(runId);
      console.log(json ? JSON.stringify(state, null, 2) : formatState(state));
      return;
    }
    const states = await runtime.store.listRuns();
    console.log(
      json
        ? JSON.stringify(states, null, 2)
        : states.map(formatState).join("\n") || "No runs found.",
    );
  });

program
  .command("transcript")
  .description("Show the human-readable transcript for a run")
  .argument("<run-id>", "run identifier")
  .option("-C, --cwd <path>", "project directory", process.cwd())
  .action(async (runId: string, { cwd }: { cwd: string }) => {
    const runtime = await createRuntime(path.resolve(cwd), runId);
    console.log(await renderStoredTranscript(runtime.store, runId));
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function runWithCancellation(
  operation: (signal: AbortSignal) => Promise<RunState>,
): Promise<RunState> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once("SIGINT", cancel);
  try {
    return await operation(controller.signal);
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

function printEvent(event: WorkflowEvent): void {
  console.log(formatWorkflowEvent(event));
}

function printFinal(state: RunState, artifactDirectory: string): void {
  console.log(formatState(state));
  console.log(`Artifacts: ${artifactDirectory}`);
  if (state.error) {
    console.error(state.error);
    process.exitCode = 1;
  }
}

function formatState(state: RunState): string {
  const checkpoint = state.checkpoint ? `  ${state.checkpoint.completedStep}->${state.checkpoint.nextAction}` : "";
  return `${state.id}  ${state.executionMode.padEnd(8)}  ${state.stage.padEnd(11)}  ${state.status.padEnd(14)}  calls=${state.agentCalls}${checkpoint}  ${state.request}`;
}

async function resolveCliMentions(cwd: string, input: string): Promise<string[]> {
  const resolved = await resolveSubmittedMentions(cwd, input, []);
  if (resolved.invalid.length > 0) {
    throw new Error(`Attachment is missing or outside the workspace: ${resolved.invalid.join(", ")}`);
  }
  return resolved.files;
}
