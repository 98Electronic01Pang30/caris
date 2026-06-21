import { readFileSync } from "node:fs";

export const CARIS_VERSION = readVersion();

function readVersion(): string {
  try {
    const source: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (source !== null && typeof source === "object" && "version" in source) {
      const version = (source as { version?: unknown }).version;
      if (typeof version === "string" && version) return version;
    }
  } catch {
    // Source checkouts and packaged installs both normally include package.json.
  }
  return "unknown";
}
