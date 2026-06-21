export type CommandName =
  | "model"
  | "status"
  | "roles"
  | "role"
  | "plan"
  | "implement"
  | "debug"
  | "verify"
  | "review"
  | "run"
  | "resume"
  | "diff"
  | "log"
  | "transcript"
  | "budget"
  | "doctor"
  | "clear"
  | "help"
  | "exit"
  | "quit";

export interface CommandDefinition {
  name: CommandName;
  description: string;
  usage: string;
}

export const COMMANDS: CommandDefinition[] = [
  { name: "model", description: "Configure provider model and effort", usage: "/model" },
  { name: "status", description: "Show session and run status", usage: "/status" },
  { name: "roles", description: "Show or edit role routing", usage: "/roles" },
  { name: "role", description: "Set a role provider", usage: "/role set <role> <provider>" },
  { name: "plan", description: "Enter plan mode or plan an inline request", usage: "/plan [request]" },
  { name: "implement", description: "Enter implement mode or implement an inline instruction", usage: "/implement [instruction]" },
  { name: "debug", description: "Enter debug mode or debug an inline instruction", usage: "/debug [instruction]" },
  { name: "verify", description: "Enter verify mode or verify an inline scope", usage: "/verify [scope]" },
  { name: "review", description: "Enter review mode or review an inline scope", usage: "/review [scope]" },
  { name: "run", description: "Enter run mode or execute an inline request", usage: "/run [request]" },
  { name: "resume", description: "Resume a run", usage: "/resume [run-id]" },
  { name: "diff", description: "Show the current run diff", usage: "/diff" },
  { name: "log", description: "Show the current run events", usage: "/log" },
  { name: "transcript", description: "Show the current run agent transcript", usage: "/transcript" },
  { name: "budget", description: "Show execution budgets", usage: "/budget" },
  { name: "doctor", description: "Inspect providers", usage: "/doctor [--live]" },
  { name: "clear", description: "Clear the visible session", usage: "/clear" },
  { name: "help", description: "Show available commands", usage: "/help" },
  { name: "exit", description: "Exit CARIS", usage: "/exit" },
  { name: "quit", description: "Exit CARIS", usage: "/quit" },
];

export interface ParsedCommand {
  name: CommandName;
  args: string[];
  argumentText: string;
}

export function parseCommand(source: string): ParsedCommand | undefined {
  const match = source.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match?.[1]) return undefined;
  const definition = COMMANDS.find((command) => command.name === match[1]);
  if (!definition) return undefined;
  const argumentText = match[2]?.trim() ?? "";
  return {
    name: definition.name,
    args: argumentText ? argumentText.split(/\s+/) : [],
    argumentText,
  };
}

export function commandSuggestions(input: string): CommandDefinition[] {
  if (!input.startsWith("/") || /\s/.test(input)) return [];
  const query = input.slice(1).toLowerCase();
  return COMMANDS.filter(
    (command) =>
      command.name.startsWith(query) || command.description.toLowerCase().includes(query),
  );
}
