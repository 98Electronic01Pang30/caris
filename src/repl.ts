import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ProviderName, RoleName, RunState } from "./domain.js";
import { providerNameSchema, roleNameSchema } from "./domain.js";
import { createRuntime } from "./runtime.js";

export async function startRepl(cwd: string): Promise<void> {
  const runtime = await createRuntime(cwd);
  const rl = createInterface({ input, output });
  let current: RunState | undefined;
  output.write(`CARIS ready · project: ${path.basename(cwd)}\nType /help for commands.\n\n`);

  try {
    while (true) {
      const source = (await rl.question("> ")).trim();
      if (!source) continue;
      try {
        if (source.startsWith("/")) {
          const shouldExit = await handleCommand(source, runtime, current, (state) => {
            current = state;
          });
          if (shouldExit) break;
          continue;
        }
        current = await runtime.engine.start(source, false, {
          onEvent: printEvent,
        });
        printResult(current);
      } catch (error) {
        output.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

async function handleCommand(
  source: string,
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  current: RunState | undefined,
  setCurrent: (state: RunState) => void,
): Promise<boolean> {
  const [command, ...args] = source.split(/\s+/);
  switch (command) {
    case "/exit":
    case "/quit":
      return true;
    case "/help":
      output.write(
        "/status  /plan  /roles  /role set <role> <provider>  /budget  /diff  /log  /exit\n",
      );
      return false;
    case "/status":
      output.write(current ? `${formatState(current)}\n` : "No run in this session.\n");
      return false;
    case "/plan":
      output.write(current?.plan ? `${JSON.stringify(current.plan, null, 2)}\n` : "No plan.\n");
      return false;
    case "/roles":
      for (const [role, config] of Object.entries(runtime.config.agents)) {
        output.write(`${role}: ${config.provider} (fallback: ${config.fallback.join(", ") || "none"})\n`);
      }
      return false;
    case "/role":
      setRole(args, runtime.config);
      return false;
    case "/budget":
      output.write(`${JSON.stringify(runtime.config.budgets, null, 2)}\n`);
      return false;
    case "/diff":
      await printArtifact(runtime.store.runDir(requireCurrent(current).id), "changes.patch");
      return false;
    case "/log":
      await printArtifact(runtime.store.runDir(requireCurrent(current).id), "events.jsonl");
      return false;
    case "/resume": {
      const id = args[0] ?? current?.id;
      if (!id) throw new Error("Usage: /resume <run-id>");
      const state = await runtime.engine.resume(id, { onEvent: printEvent });
      setCurrent(state);
      printResult(state);
      return false;
    }
    default:
      output.write(`Unknown command: ${command}. Type /help.\n`);
      return false;
  }
}

function setRole(args: string[], config: Awaited<ReturnType<typeof createRuntime>>["config"]): void {
  if (args[0] !== "set" || !args[1] || !args[2]) {
    throw new Error("Usage: /role set <role> <provider>");
  }
  const role = roleNameSchema.parse(args[1]) as RoleName;
  const provider = providerNameSchema.parse(args[2]) as ProviderName;
  config.agents[role].provider = provider;
  output.write(`${role} -> ${provider} for this session\n`);
}

function requireCurrent(current: RunState | undefined): RunState {
  if (!current) throw new Error("No run in this session");
  return current;
}

async function printArtifact(directory: string, name: string): Promise<void> {
  try {
    output.write(await readFile(path.join(directory, name), "utf8"));
  } catch {
    output.write(`${name} is not available.\n`);
  }
}

function printEvent(event: { stage: string; message: string }): void {
  output.write(`[${event.stage}] ${event.message}\n`);
}

function printResult(state: RunState): void {
  output.write(`${formatState(state)}\n`);
  if (state.error) output.write(`Error: ${state.error}\n`);
}

function formatState(state: RunState): string {
  return `run=${state.id} stage=${state.stage} calls=${state.agentCalls}`;
}
