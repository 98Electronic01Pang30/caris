import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { COMMANDS, parseCommand, type CommandName } from "./command-registry.js";
import { saveProviderConfig } from "./config.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import type {
  ProviderName,
  ProviderRuntimeConfig,
  RoleName,
  RunState,
  ManualStep,
} from "./domain.js";
import { extractMentionPaths } from "./file-index.js";
import { createRuntime } from "./runtime.js";
import type { ComposerMode } from "./tui-session.js";
import { formatWorkflowEvent } from "./workflow-event-format.js";
import type { WorkflowEvent } from "./workflow.js";

type Runtime = Awaited<ReturnType<typeof createRuntime>>;

export async function startRepl(cwd: string): Promise<void> {
  const runtime = await createRuntime(cwd);
  const rl = createInterface({ input, output });
  let current: RunState | undefined;
  let mode: ComposerMode = "plan";
  let nonGitWriteApproved = false;
  output.write(`CARIS ready · project: ${path.basename(cwd)}\nType /help for commands.\n\n`);

  const run = async (request: string, planOnly: boolean): Promise<RunState> => {
    current = await runtime.engine.start(request, planOnly, {
      mentionedFiles: extractMentionPaths(request),
      onEvent: printEvent,
      allowNonGitWrite: nonGitWriteApproved || runtime.workspaceContext.kind === "git",
    });
    printResult(current);
    return current;
  };

  const manual = async (step: ManualStep, instruction: string): Promise<RunState> => {
    if ((step === "IMPLEMENT" || step === "DEBUG") && !(await approveNonGitWrite())) {
      throw new Error("Non-Git write cancelled");
    }
    current = step === "PLAN" || current?.executionMode !== "manual"
      ? await runtime.engine.startManual(step, instruction, { onEvent: printEvent, allowNonGitWrite: nonGitWriteApproved || runtime.workspaceContext.kind === "git" })
      : await runtime.engine.executeManual(current.id, step, instruction, { onEvent: printEvent, allowNonGitWrite: nonGitWriteApproved || runtime.workspaceContext.kind === "git" });
    printResult(current);
    return current;
  };

  const approveNonGitWrite = async (): Promise<boolean> => {
    if (runtime.workspaceContext.kind === "git" || nonGitWriteApproved) return true;
    output.write(
      "This directory is not a Git repository. Changes have no Git diff or recovery point.\n" +
      "Run git init and create a baseline commit to enable them.\n",
    );
    if (!input.isTTY) return false;
    const answer = (await rl.question("Allow file modifications for this CARIS session? [y/N] ")).trim().toLowerCase();
    nonGitWriteApproved = answer === "y" || answer === "yes";
    return nonGitWriteApproved;
  };

  const processSource = async (source: string): Promise<boolean> => {
    const trimmed = source.trim();
    if (!trimmed) return false;
    try {
      if (trimmed.startsWith("/")) {
        const result = await executePlainCommand(trimmed, runtime, current, mode, run, manual);
        current = result.current;
        mode = result.mode;
        return result.exit;
      }
      if (current?.checkpoint && ["awaiting_input", "paused"].includes(current.status)) {
        const normalized = trimmed.toLowerCase();
        const response = normalized === "y" || normalized === "yes"
          ? { kind: "approve" as const }
          : normalized === "n" || normalized === "no"
            ? { kind: "pause" as const }
            : { kind: "feedback" as const, message: trimmed };
        const modifyingNext =
          (response.kind === "approve" && (current.checkpoint.nextAction === "IMPLEMENT" || current.checkpoint.nextAction === "DEBUG")) ||
          (response.kind === "feedback" && ["IMPLEMENT", "VERIFY", "DEBUG"].includes(current.checkpoint.completedStep));
        if (modifyingNext && !(await approveNonGitWrite())) {
          output.write("Non-Git write cancelled.\n");
          return false;
        }
        current = await runtime.engine.respond(current.id, response, { onEvent: printEvent, allowNonGitWrite: nonGitWriteApproved || runtime.workspaceContext.kind === "git" });
        printResult(current);
        return false;
      }
      if (mode === "run") await run(trimmed, false);
      else await manual(mode.toUpperCase() as ManualStep, trimmed);
    } catch (error) {
      output.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return false;
  };

  try {
    if (!input.isTTY) {
      for await (const line of rl) {
        if (await processSource(line)) break;
      }
      return;
    }
    while (true) {
      if (await processSource(await rl.question(`${mode.toUpperCase()}> `))) break;
    }
  } finally {
    rl.close();
  }
}

async function executePlainCommand(
  source: string,
  runtime: Runtime,
  current: RunState | undefined,
  mode: ComposerMode,
  run: (request: string, planOnly: boolean) => Promise<RunState>,
  manual: (step: ManualStep, instruction: string) => Promise<RunState>,
): Promise<{ exit: boolean; current: RunState | undefined; mode: ComposerMode }> {
  const command = parseCommand(source);
  if (!command) throw new Error(`Unknown command: ${source}. Type /help.`);
  let nextCurrent = current;
  let nextMode = mode;
  const handlers: Record<CommandName, () => Promise<boolean>> = {
    exit: async () => true,
    quit: async () => true,
    help: async () => {
      output.write(`${COMMANDS.map((item) => `${item.usage.padEnd(28)} ${item.description}`).join("\n")}\n`);
      return false;
    },
    clear: async () => {
      nextCurrent = undefined;
      output.write("\x1Bc");
      return false;
    },
    status: async () => {
      output.write(`${formatStatus(runtime, current, mode)}\n`);
      return false;
    },
    roles: async () => {
      for (const [role, config] of Object.entries(runtime.config.agents)) {
        output.write(`${role}: ${config.provider} (fallback: ${config.fallback.join(", ") || "none"})\n`);
      }
      return false;
    },
    role: async () => {
      setRole(command.args, runtime);
      return false;
    },
    model: async () => {
      await setModel(command.args, runtime);
      return false;
    },
    plan: async () => {
      nextMode = "plan";
      if (command.argumentText) nextCurrent = await manual("PLAN", command.argumentText);
      else output.write("Composer mode: PLAN\n");
      return false;
    },
    implement: async () => {
      nextMode = "implement";
      if (command.argumentText) nextCurrent = await manual("IMPLEMENT", command.argumentText);
      else output.write("Composer mode: IMPLEMENT\n");
      return false;
    },
    debug: async () => {
      nextMode = "debug";
      if (command.argumentText) nextCurrent = await manual("DEBUG", command.argumentText);
      else output.write("Composer mode: DEBUG\n");
      return false;
    },
    verify: async () => {
      nextMode = "verify";
      if (command.argumentText) nextCurrent = await manual("VERIFY", command.argumentText);
      else output.write("Composer mode: VERIFY\n");
      return false;
    },
    review: async () => {
      nextMode = "review";
      if (command.argumentText) nextCurrent = await manual("REVIEW", command.argumentText);
      else output.write("Composer mode: REVIEW\n");
      return false;
    },
    run: async () => {
      nextMode = "run";
      if (command.argumentText) nextCurrent = await run(command.argumentText, false);
      else output.write("Composer mode: RUN\n");
      return false;
    },
    budget: async () => {
      output.write(`${JSON.stringify(runtime.config.budgets, null, 2)}\n`);
      return false;
    },
    diff: async () => {
      await printArtifact(runtime, current, "changes.patch");
      return false;
    },
    log: async () => {
      await printArtifact(runtime, current, "events.jsonl");
      return false;
    },
    transcript: async () => {
      await printArtifact(runtime, current, "transcript.md");
      return false;
    },
    resume: async () => {
      const id = command.args[0] ?? current?.id;
      if (!id) throw new Error("Usage: /resume <run-id>");
      nextCurrent = await runtime.engine.resume(id, { onEvent: printEvent });
      printResult(nextCurrent);
      return false;
    },
    doctor: async () => {
      const report = await runDoctor(
        runtime.store.projectRoot,
        runtime.adapters,
        runtime.runner,
        command.args.includes("--live"),
        runtime.config.providers,
      );
      output.write(`${formatDoctorReport(report)}\n`);
      return false;
    },
  };
  const shouldExit = await handlers[command.name]();
  return { exit: shouldExit, current: nextCurrent, mode: nextMode };
}

function setRole(args: string[], runtime: Runtime): void {
  const roles: RoleName[] = ["planner", "implementer", "debugger", "verifier", "reviewer"];
  const providers: Array<ProviderName | "auto"> = ["auto", "codex", "claude", "gemini", "antigravity"];
  if (args[0] !== "set" || !roles.includes(args[1] as RoleName) || !providers.includes(args[2] as ProviderName)) {
    throw new Error("Usage: /role set <role> <provider>");
  }
  runtime.config.agents[args[1] as RoleName].provider = args[2] as ProviderName | "auto";
  output.write(`${args[1]} -> ${args[2]} for this session\n`);
}

async function setModel(args: string[], runtime: Runtime): Promise<void> {
  const providers: ProviderName[] = ["codex", "claude", "gemini", "antigravity"];
  const provider = args[0] as ProviderName;
  if (!providers.includes(provider)) {
    throw new Error("Usage: /model <codex|claude|gemini> [model|default] [effort|default] [--save]");
  }
  const model = args[1] && args[1] !== "default" ? args[1] : undefined;
  const effort = provider !== "gemini" && provider !== "antigravity" && args[2] && args[2] !== "default" && args[2] !== "--save"
    ? args[2]
    : undefined;
  const settings: ProviderRuntimeConfig = {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
  const merged = { ...runtime.config.providers[provider], ...settings };
  runtime.config.providers[provider] = merged;
  if (args.includes("--save")) await saveProviderConfig(runtime.store.projectRoot, provider, merged);
  output.write(`${provider}: model=${model ?? "default"} effort=${provider === "gemini" || provider === "antigravity" ? "unsupported" : effort ?? "default"}\n`);
}

function formatStatus(runtime: Runtime, current: RunState | undefined, mode: ComposerMode): string {
  const providers = (["codex", "claude", "gemini", "antigravity"] as ProviderName[])
    .map((provider) => {
      const config = runtime.config.providers[provider];
      const effort = "effort" in config ? config.effort : undefined;
      return `${provider}: executable=${runtime.adapters.get(provider)?.executable ?? "not registered"} model=${config.model ?? "default"} effort=${provider === "gemini" || provider === "antigravity" ? "unsupported" : effort ?? "default"}`;
    })
    .join("\n");
  const checkpoint = current?.checkpoint
    ? `${current.checkpoint.completedStep} -> ${current.checkpoint.nextAction}`
    : "none";
  const steps = current?.stepHistory.map((item) => `${item.index}:${item.step}/${item.status}`).join(", ") || "none";
  const workspace = runtime.workspaceContext.kind === "git"
    ? `Git (${runtime.workspaceContext.root})`
    : "Directory mode (Git diff/recovery unavailable; run git init and create a baseline commit to enable them)";
  return `workspace=${workspace}\nmode=${mode}\nrun=${current ? `${current.id} ${current.executionMode} ${current.stage}/${current.status} calls=${current.agentCalls}` : "none"}\ncheckpoint=${checkpoint}\nsteps=${steps}\n${providers}`;
}

async function printArtifact(runtime: Runtime, current: RunState | undefined, name: string): Promise<void> {
  if (!current) throw new Error("No run in this session");
  try {
    output.write(await readFile(path.join(runtime.store.runDir(current.id), name), "utf8"));
  } catch {
    output.write(`${name} is not available.\n`);
  }
}

function printEvent(event: WorkflowEvent): void {
  output.write(`${formatWorkflowEvent(event)}\n`);
}

function printResult(state: RunState): void {
  output.write(`run=${state.id} stage=${state.stage} status=${state.status} calls=${state.agentCalls}\n`);
  if (state.error) output.write(`Error: ${state.error}\n`);
  else if (state.checkpoint) output.write(`${state.checkpoint.message}\nRespond with Y, N, or custom feedback.\n`);
}
