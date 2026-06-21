import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { CheckpointPrompt, MultiSelectionDialog, SelectionDialog, SuggestionList } from "../src/tui.js";
import type { RunState } from "../src/domain.js";

describe("TUI components", () => {
  it("renders checkpoint choices while a run awaits input", () => {
    const now = new Date().toISOString();
    const state: RunState = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      request: "test",
      cwd: process.cwd(),
      stage: "PLANNED",
      executionMode: "pipeline",
      stepHistory: [],
      status: "awaiting_input",
      checkpoint: { completedStep: "PLAN", nextAction: "IMPLEMENT", message: "Approve", verificationFailed: false },
      feedback: [],
      debugAttempts: 0,
      createdAt: now,
      updatedAt: now,
      activeTimeMs: 1,
      agentCalls: 1,
      planOnly: false,
      mentionedFiles: [],
      verification: [],
    };
    const view = render(<CheckpointPrompt state={state} />);
    expect(view.lastFrame()).toContain("PLAN complete");
    expect(view.lastFrame()).toContain("Y: continue");
    expect(view.lastFrame()).toContain("custom text: revise");
  });

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
