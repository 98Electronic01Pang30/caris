#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { writeDefaultConfig } from "./config.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import type { RunState } from "./domain.js";
import { startRepl } from "./repl.js";
import { startTui } from "./tui.js";
import { createRuntime } from "./runtime.js";

const program = new Command();
program
  .name("caris")
  .description("Local-first orchestration harness for coding-agent CLIs")
  .version("0.1.0")
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
  .action(async (request: string, { cwd }: { cwd: string }) => {
    const runtime = await createRuntime(path.resolve(cwd));
    const state = await runWithCancellation((signal) =>
      runtime.engine.start(request, false, { signal, onEvent: printEvent }),
    );
    printFinal(state, runtime.store.runDir(state.id));
  });

program
  .command("plan")
  .description("Create a plan without implementing it")
  .argument("<request>", "coding task")
  .option("-C, --cwd <path>", "project directory", process.cwd())
  .action(async (request: string, { cwd }: { cwd: string }) => {
    const runtime = await createRuntime(path.resolve(cwd));
    const state = await runWithCancellation((signal) =>
      runtime.engine.start(request, true, { signal, onEvent: printEvent }),
    );
    console.log(JSON.stringify(state.plan, null, 2));
    printFinal(state, runtime.store.runDir(state.id));
  });

program
  .command("resume")
  .description("Resume a failed or interrupted run")
  .argument("<run-id>", "run identifier")
  .option("-C, --cwd <path>", "project directory", process.cwd())
  .action(async (runId: string, { cwd }: { cwd: string }) => {
    const runtime = await createRuntime(path.resolve(cwd), runId);
    const state = await runWithCancellation((signal) =>
      runtime.engine.resume(runId, { signal, onEvent: printEvent }),
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

function printEvent(event: { stage: string; message: string }): void {
  console.log(`[${event.stage}] ${event.message}`);
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
  return `${state.id}  ${state.stage.padEnd(11)}  calls=${state.agentCalls}  ${state.request}`;
}
