import type { RoleName } from "./domain.js";
import type { ComposerMode } from "./tui-session.js";

export const ROLE_ACCENTS = {
  plan: "#E5A84B",
  implement: "#4C8DFF",
  verify: "#E24A6A",
  debug: "#36C98F",
  neutral: "gray",
} as const;

export function roleAccent(value: RoleName | ComposerMode | undefined): string {
  if (value === "planner" || value === "plan") return ROLE_ACCENTS.plan;
  if (value === "implementer" || value === "implement") return ROLE_ACCENTS.implement;
  if (value === "verifier" || value === "verify") return ROLE_ACCENTS.verify;
  if (value === "debugger" || value === "debug") return ROLE_ACCENTS.debug;
  return ROLE_ACCENTS.neutral;
}
