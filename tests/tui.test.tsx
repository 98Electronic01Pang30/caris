import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { AgentResponseBlock, CheckpointPrompt, InteractionPrompt, MultiSelectionDialog, SelectionDialog, SuggestionList, clearSubmittedCommandInput } from "../src/tui.js";
import { ComposerInput, splitGraphemes } from "../src/composer-input.js";
import type { RunState } from "../src/domain.js";
import { CarisLogo, readLogoArt } from "../src/caris-logo.js";
import { ROLE_ACCENTS, roleAccent } from "../src/tui-theme.js";

describe("TUI components", () => {
  it("clears composer state after a slash command is submitted", () => {
    const setValue = vi.fn();
    const setDismissedInput = vi.fn();
    const setSelected = vi.fn();
    const setMentionDirectory = vi.fn();
    clearSubmittedCommandInput({ setValue, setDismissedInput, setSelected, setMentionDirectory });
    expect(setValue).toHaveBeenCalledWith("");
    expect(setDismissedInput).toHaveBeenCalledWith("");
    expect(setSelected).toHaveBeenCalledWith(0);
    expect(setMentionDirectory).toHaveBeenCalledWith("");
  });

  it("maps workflow roles to distinct gemstone accents", () => {
    expect(roleAccent("planner")).toBe(ROLE_ACCENTS.plan);
    expect(roleAccent("implement")).toBe(ROLE_ACCENTS.implement);
    expect(roleAccent("verifier")).toBe(ROLE_ACCENTS.verify);
    expect(roleAccent("debug")).toBe(ROLE_ACCENTS.debug);
    expect(new Set(Object.values(ROLE_ACCENTS)).size).toBe(5);
  });

  it("renders grouped agent output with a role and provider header", () => {
    const view = render(<AgentResponseBlock entries={[
      { id: 1, kind: "agent", text: "I will inspect the files.", agentCallId: 2, role: "implementer", provider: "codex" },
      { id: 2, kind: "tool", text: "Tool\nrg src", agentCallId: 2, role: "implementer", provider: "codex" },
    ]} />);
    expect(view.lastFrame()).toContain("Implementer · Codex");
    expect(view.lastFrame()).toContain("I will inspect the files.");
    expect(view.lastFrame()).toContain("rg src");
  });

  it("renders full and compact CARIS branding", () => {
    const full = render(<CarisLogo project="D:\\demo" width={120} version="1.2.3" />);
    expect(full.lastFrame()).toContain("CLI AGENT ROUTING AND INTEGRATION SYSTEM");
    expect(full.lastFrame()).toContain("V.1.2.3");
    expect(full.lastFrame()).toContain("D:\\demo");
    expect(full.lastFrame()).toContain("████");
    expect(readLogoArt().length).toBeGreaterThan(8);
    const compact = render(<CarisLogo project="D:\\demo" width={40} />);
    expect(compact.lastFrame()).toContain("CARIS");
    expect(compact.lastFrame()).not.toContain("ROUTING");
  });
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

  it("handles Korean graphemes without a one-character delay", async () => {
    expect(splitGraphemes("한글A")).toEqual(["한", "글", "A"]);
    let value = "";
    const changed = vi.fn((next: string) => { value = next; });
    const view = render(<ComposerInput value={value} onChange={changed} onSubmit={() => undefined} />);
    view.stdin.write("한");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(changed).toHaveBeenLastCalledWith("한");
  });

  it("renders an agent permission request inside CARIS", () => {
    const view = render(<InteractionPrompt request={{
      id: "approval-1",
      kind: "permission",
      prompt: "Allow npm test?",
      choices: [{ id: "y", label: "Allow once" }],
    }} />);
    expect(view.lastFrame()).toContain("Agent input required");
    expect(view.lastFrame()).toContain("Allow npm test?");
    expect(view.lastFrame()).toContain("Enter confirm");
  });

  it("answers an agent permission with keyboard selection", async () => {
    const responded = vi.fn();
    const view = render(<InteractionPrompt request={{
      id: "approval-2",
      kind: "permission",
      prompt: "Allow command?",
      choices: [{ id: "y", label: "Allow once" }, { id: "a", label: "Allow for session" }, { id: "n", label: "Deny" }],
    }} onResponse={responded} />);
    view.stdin.write("\u001B[B");
    view.stdin.write("\u001B[B");
    view.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(responded).toHaveBeenCalledWith({ kind: "deny" });
  });
});
