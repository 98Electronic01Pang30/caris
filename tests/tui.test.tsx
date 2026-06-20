import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { MultiSelectionDialog, SelectionDialog, SuggestionList } from "../src/tui.js";

describe("TUI components", () => {
  it("renders command suggestions and selection", () => {
    const view = render(
      <SuggestionList
        items={[
          { label: "/model", description: "Configure model" },
          { label: "/status", description: "Show status" },
        ]}
        selected={1}
      />,
    );
    expect(view.lastFrame()).toContain("/model");
    expect(view.lastFrame()).toContain("› /status");
  });

  it("supports keyboard selection in picker", async () => {
    const selected = vi.fn();
    const view = render(
      <SelectionDialog
        title="Provider"
        choices={[{ id: "codex", label: "codex" }, { id: "claude", label: "claude" }]}
        onSelect={selected}
        onCancel={() => undefined}
      />,
    );
    view.stdin.write("\u001B[B");
    view.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(selected).toHaveBeenCalledWith("claude");
  });

  it("supports toggling fallback providers", async () => {
    const submitted = vi.fn();
    const view = render(
      <MultiSelectionDialog
        title="Fallbacks"
        choices={[{ id: "codex", label: "codex" }, { id: "claude", label: "claude" }]}
        initial={["codex"]}
        onSubmit={submitted}
        onCancel={() => undefined}
      />,
    );
    view.stdin.write("\u001B[B");
    view.stdin.write(" ");
    view.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(submitted).toHaveBeenCalledWith(["codex", "claude"]);
  });
});
