import { describe, expect, it } from "vitest";
import { commandSuggestions, parseCommand } from "../src/command-registry.js";

describe("command registry", () => {
  it("filters slash commands by name and description", () => {
    expect(commandSuggestions("/mo").map((item) => item.name)).toContain("model");
    expect(commandSuggestions("/sta").map((item) => item.name)).toContain("status");
  });

  it("preserves inline command arguments", () => {
    expect(parseCommand("/plan inspect the API layer")).toEqual({
      name: "plan",
      args: ["inspect", "the", "API", "layer"],
      argumentText: "inspect the API layer",
    });
  });

  it("rejects unknown commands", () => {
    expect(parseCommand("/unknown value")).toBeUndefined();
  });
});
