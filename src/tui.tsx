import { readFile } from "node:fs/promises";
import path from "node:path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { COMMANDS, commandSuggestions, parseCommand } from "./command-registry.js";
import { saveProviderConfig } from "./config.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import type {
  ProviderName,
  ProviderRuntimeConfig,
  RoleName,
  RunState,
  ManualStep,
  InteractionRequest,
} from "./domain.js";
import {
  activeMentionToken,
  buildFileIndex,
  extractMentionPaths,
  insertMention,
  parentDirectory,
  resolveSubmittedMentions,
  type FileIndex,
  type FileIndexEntry,
} from "./file-index.js";
import type { ModelOption } from "./model-catalog.js";
import { createRuntime } from "./runtime.js";
import type { ComposerMode, TranscriptEntry } from "./tui-session.js";
import type { WorkflowEvent } from "./workflow.js";
import { formatWorkflowEvent } from "./workflow-event-format.js";
import { formatTranscriptItem } from "./transcript-format.js";
import { roleAccent } from "./tui-theme.js";
import { CarisLogo } from "./caris-logo.js";
import { ComposerInput } from "./composer-input.js";
import { renderStoredTranscript } from "./stored-transcript.js";

type Runtime = Awaited<ReturnType<typeof createRuntime>>;
type Choice = { id: string; label: string; description?: string };
type Dialog =
  | { type: "select"; title: string; choices: Choice[]; onSelect: (id: string) => void }
  | {
      type: "multi";
      title: string;
      choices: Choice[];
      initial: string[];
      onSubmit: (ids: string[]) => void;
    }
  | { type: "input"; title: string; value: string; onSubmit: (value: string) => void };

export async function startTui(cwd: string): Promise<void> {
  const runtime = await createRuntime(cwd);
  const fileIndex = await buildFileIndex(cwd, runtime.runner);
  const instance = render(<CarisTui cwd={cwd} runtime={runtime} initialFileIndex={fileIndex} />);
  await instance.waitUntilExit();
}

function CarisTui({
  cwd,
  runtime,
  initialFileIndex,
}: {
  cwd: string;
  runtime: Runtime;
  initialFileIndex: FileIndex;
}): React.JSX.Element {
  const { exit } = useApp();
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<ComposerMode>("plan");
  const [current, setCurrent] = useState<RunState>();
  const [attachments, setAttachments] = useState<string[]>([]);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([
    entry("system", `CARIS ready · project: ${path.basename(cwd)} · type /help`),
  ]);
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState(0);
  const [mentionDirectory, setMentionDirectory] = useState("");
  const [dismissedInput, setDismissedInput] = useState("");
  const [fileIndex, setFileIndex] = useState(initialFileIndex);
  const [dialog, setDialog] = useState<Dialog>();
  const [pendingInteraction, setPendingInteraction] = useState<{ runId: string; request: InteractionRequest }>();
  const [liveRunId, setLiveRunId] = useState<string>();
  const nonGitWriteApproved = useRef(false);
  const abortController = useRef<AbortController | undefined>(undefined);
  const deltaBuffer = useRef<WorkflowEvent[]>([]);
  const deltaTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const mention = activeMentionToken(value);
  const commandOptions = dismissedInput === value ? [] : commandSuggestions(value);
  const mentionOptions = useMemo(
    () =>
      dismissedInput === value || !mention
        ? []
        : fileIndex.search(mention.query, mentionDirectory),
    [dismissedInput, fileIndex, mention, mentionDirectory, value],
  );
  const popupCount = commandOptions.length || mentionOptions.length;

  const append = (
    kind: TranscriptEntry["kind"],
    text: string,
    metadata: Pick<TranscriptEntry, "agentCallId" | "role" | "provider" | "streamKey"> = {},
  ): void => {
    setTranscript((items) => [...items, entry(kind, text, metadata)]);
  };

  const appendWorkflowEvent = (event: WorkflowEvent): void => {
    if (event.delta && event.transcriptItem) {
      deltaBuffer.current.push(event);
      if (!deltaTimer.current) {
        deltaTimer.current = setTimeout(() => {
          const pending = deltaBuffer.current.splice(0);
          deltaTimer.current = undefined;
          const grouped = new Map<string, WorkflowEvent>();
          for (const item of pending) {
            const key = `${item.agentCallId}:${item.transcriptItem?.kind}`;
            const previous = grouped.get(key);
            if (previous?.transcriptItem && item.transcriptItem && previous.transcriptItem.kind === item.transcriptItem.kind) {
              if (previous.transcriptItem.kind === "assistant_message" && item.transcriptItem.kind === "assistant_message") {
                previous.transcriptItem = { kind: "assistant_message", text: previous.transcriptItem.text + item.transcriptItem.text };
              } else if (previous.transcriptItem.kind === "tool_result" && item.transcriptItem.kind === "tool_result") {
                previous.transcriptItem = { kind: "tool_result", text: previous.transcriptItem.text + item.transcriptItem.text };
              }
            } else grouped.set(key, { ...item, delta: false });
          }
          for (const item of grouped.values()) {
            if (!item.transcriptItem) continue;
            const streamKey = `${item.agentCallId}:${item.transcriptItem.kind}`;
            const kind: TranscriptEntry["kind"] = item.transcriptItem.kind === "tool_result" ? "tool" : "agent";
            const initialText = formatTranscriptItem(item.transcriptItem, { truncateToolResult: true });
            const continuation = item.transcriptItem.kind === "assistant_message" || item.transcriptItem.kind === "tool_result"
              ? item.transcriptItem.text
              : initialText;
            setLiveRunId(item.runId);
            setTranscript((entries) => {
              const last = entries.at(-1);
              if (last?.streamKey === streamKey) {
                return [...entries.slice(0, -1), { ...last, text: last.text + continuation }];
              }
              return [...entries, entry(kind, initialText, {
                ...(item.agentCallId !== undefined ? { agentCallId: item.agentCallId } : {}),
                ...(item.role ? { role: item.role } : {}),
                ...(item.provider ? { provider: item.provider } : {}),
                streamKey,
              })];
            });
          }
        }, 33);
      }
      return;
    }
    setLiveRunId(event.runId);
    if (event.kind === "interaction_requested" && event.interactionRequest) {
      setPendingInteraction({ runId: event.runId, request: event.interactionRequest });
    }
    const kind: TranscriptEntry["kind"] = event.kind === "provider_error"
      ? "error"
      : event.kind === "workspace_diff"
        ? "diff"
        : event.kind === "agent_transcript"
          ? event.transcriptItem?.kind === "tool_call" || event.transcriptItem?.kind === "tool_result" ? "tool" : "agent"
          : "event";
    const text = event.kind === "agent_transcript" && event.transcriptItem
      ? formatTranscriptItem(event.transcriptItem, { truncateToolResult: true })
      : formatWorkflowEvent(event, { truncateToolResult: true });
    append(kind, text, {
      ...(event.agentCallId !== undefined ? { agentCallId: event.agentCallId } : {}),
      ...(event.role ? { role: event.role } : {}),
      ...(event.provider ? { provider: event.provider } : {}),
    });
  };

  useEffect(() => () => {
    if (deltaTimer.current) clearTimeout(deltaTimer.current);
  }, []);

  const selectSuggestion = (): boolean => {
    if (commandOptions.length > 0) {
      const command = commandOptions[selected % commandOptions.length];
      if (!command) return false;
      setValue(command.usage.includes("[") || command.usage.includes("<") ? `/${command.name} ` : `/${command.name}`);
      setSelected(0);
      return true;
    }
    if (mention && mentionOptions.length > 0) {
      const selectedEntry = mentionOptions[selected % mentionOptions.length];
      if (!selectedEntry) return false;
      if (selectedEntry.kind === "directory") {
        setMentionDirectory(selectedEntry.path);
        setValue(`${value.slice(0, mention.start)}@`);
      } else {
        setValue(insertMention(value, mention, selectedEntry.path));
        setAttachments((items) => [...new Set([...items, selectedEntry.path])]);
        setMentionDirectory("");
      }
      setSelected(0);
      return true;
    }
    return false;
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        if (running) {
          const controller = abortController.current;
          if (liveRunId) {
            void runtime.engine.cancelActiveSession(liveRunId)
              .catch(() => undefined)
              .finally(() => setTimeout(() => controller?.abort(), 1_500));
          } else controller?.abort();
        }
        else exit();
        return;
      }
      if (dialog) return;
      if (key.upArrow && popupCount > 0) setSelected((index) => Math.max(0, index - 1));
      if (key.downArrow && popupCount > 0) setSelected((index) => (index + 1) % popupCount);
      if (key.tab && popupCount > 0) selectSuggestion();
      if (key.escape && popupCount > 0) {
        setDismissedInput(value);
        setSelected(0);
      }
      if (key.backspace && mention && mention.query === "" && mentionDirectory) {
        setMentionDirectory(parentDirectory(mentionDirectory));
      }
      if (key.backspace && value === "" && attachments.length > 0) {
        setAttachments((items) => items.slice(0, -1));
      }
    },
    { isActive: true },
  );

  useEffect(() => setSelected(0), [value]);

  const executeWorkflow = async (request: string): Promise<void> => {
    const text = request.trim();
    if (!text) return;
    const resolved = await resolveSubmittedMentions(cwd, text, attachments);
    if (resolved.invalid.length > 0) {
      append("error", `Attachment is missing or outside the workspace: ${resolved.invalid.join(", ")}`);
      return;
    }
    append("user", `RUN> ${text}`);
    setValue("");
    setRunning(true);
    const controller = new AbortController();
    abortController.current = controller;
    try {
      const state = await runtime.engine.start(text, false, {
        signal: controller.signal,
        mentionedFiles: resolved.files,
        onEvent: appendWorkflowEvent,
        interactive: true,
      });
      setCurrent(state);
      reportState(state);
      setAttachments([]);
      setFileIndex(await buildFileIndex(cwd, runtime.runner));
    } catch (error) {
      append("error", errorMessage(error));
    } finally {
      abortController.current = undefined;
      setRunning(false);
    }
  };

  const executeManualNow = async (step: ManualStep, instruction: string): Promise<void> => {
    const text = instruction.trim();
    if (!text) return;
    const resolved = await resolveSubmittedMentions(cwd, text, attachments);
    if (resolved.invalid.length > 0) {
      append("error", `Attachment is missing or outside the workspace: ${resolved.invalid.join(", ")}`);
      return;
    }
    append("user", `${step}> ${text}`);
    setValue("");
    setRunning(true);
    const controller = new AbortController();
    abortController.current = controller;
    try {
      const options = {
        signal: controller.signal,
        mentionedFiles: resolved.files,
        onEvent: appendWorkflowEvent,
        interactive: true,
        allowNonGitWrite: nonGitWriteApproved.current || runtime.workspaceContext.kind === "git",
      };
      const state = step === "PLAN" || current?.executionMode !== "manual"
        ? await runtime.engine.startManual(step, text, options)
        : await runtime.engine.executeManual(current.id, step, text, options);
      setCurrent(state);
      reportState(state);
      setAttachments([]);
      setFileIndex(await buildFileIndex(cwd, runtime.runner));
    } catch (error) {
      append("error", errorMessage(error));
    } finally {
      abortController.current = undefined;
      setRunning(false);
    }
  };

  const requestNonGitWriteApproval = (onApprove: () => void): boolean => {
    if (runtime.workspaceContext.kind === "git" || nonGitWriteApproved.current) return true;
    setDialog({
      type: "select",
      title: "This directory is not a Git repository. Changes have no Git diff or recovery point. Allow writes for this session?",
      choices: [
        { id: "no", label: "No, cancel" },
        { id: "yes", label: "Yes, allow this session" },
      ],
      onSelect: (choice) => {
        setDialog(undefined);
        if (choice !== "yes") {
          append("system", "Non-Git write cancelled. Run git init and create a baseline commit to enable diff and recovery.");
          return;
        }
        nonGitWriteApproved.current = true;
        onApprove();
      },
    });
    return false;
  };

  const executeManual = async (step: ManualStep, instruction: string): Promise<void> => {
    if ((step === "IMPLEMENT" || step === "DEBUG") && !requestNonGitWriteApproval(() => void executeManualNow(step, instruction))) return;
    await executeManualNow(step, instruction);
  };

  const reportState = (state: RunState): void => {
    if (state.error) append("error", state.error);
    else if (state.checkpoint) append("system", `${state.checkpoint.message}\nRespond with Y, N, or custom feedback.`);
    else append("system", `Completed ${state.id} · calls=${state.agentCalls}`);
  };

  const respondToCheckpoint = async (source: string): Promise<void> => {
    if (!current?.checkpoint) return;
    const normalized = source.trim().toLowerCase();
    const response = normalized === "y" || normalized === "yes"
      ? { kind: "approve" as const }
      : normalized === "n" || normalized === "no"
        ? { kind: "pause" as const }
        : { kind: "feedback" as const, message: source.trim() };
    const modifyingNext =
      (response.kind === "approve" && (current.checkpoint.nextAction === "IMPLEMENT" || current.checkpoint.nextAction === "DEBUG")) ||
      (response.kind === "feedback" && ["IMPLEMENT", "VERIFY", "DEBUG"].includes(current.checkpoint.completedStep));
    if (modifyingNext && !requestNonGitWriteApproval(() => void respondToCheckpoint(source))) return;
    append("user", source.trim());
    setValue("");
    setRunning(true);
    const controller = new AbortController();
    abortController.current = controller;
    try {
      const state = await runtime.engine.respond(current.id, response, {
        signal: controller.signal,
        onEvent: appendWorkflowEvent,
        interactive: true,
        allowNonGitWrite: nonGitWriteApproved.current || runtime.workspaceContext.kind === "git",
      });
      setCurrent(state);
      reportState(state);
      setFileIndex(await buildFileIndex(cwd, runtime.runner));
    } catch (error) {
      append("error", errorMessage(error));
    } finally {
      abortController.current = undefined;
      setRunning(false);
    }
  };

  const showModelDialog = (): void => {
    setDialog({
      type: "select",
      title: "Select provider",
      choices: (["codex", "claude", "gemini", "antigravity"] as ProviderName[]).map((provider) => ({
        id: provider,
        label: provider,
        description: formatProviderConfig(runtime.config.providers[provider], provider),
      })),
      onSelect: (id) => void chooseModel(id as ProviderName),
    });
  };

  const chooseModel = async (provider: ProviderName): Promise<void> => {
    const models = await runtime.modelCatalog.list(provider, cwd);
    const currentModel = runtime.config.providers[provider].model;
    const choices: Choice[] = [
      { id: "__default__", label: "Provider default" },
      ...models.map((model) => ({ id: model.id, label: model.label, description: model.id })),
      ...(currentModel && !models.some((model) => model.id === currentModel)
        ? [{ id: currentModel, label: currentModel, description: "Current custom model" }]
        : []),
      { id: "__custom__", label: "Custom model ID" },
    ];
    setDialog({
      type: "select",
      title: `${provider}: select model`,
      choices,
      onSelect: (id) => {
        if (id === "__custom__") {
          setDialog({
            type: "input",
            title: `${provider}: custom model ID`,
            value: currentModel ?? "",
            onSubmit: (model) => chooseEffort(provider, model.trim() || undefined, models),
          });
        } else {
          chooseEffort(provider, id === "__default__" ? undefined : id, models);
        }
      },
    });
  };

  const chooseEffort = (
    provider: ProviderName,
    model: string | undefined,
    models: ModelOption[],
  ): void => {
    if (provider === "gemini" || provider === "antigravity") {
      chooseSaveScope(provider, { ...(model ? { model } : {}) });
      return;
    }
    const modelOption = models.find((item) => item.id === model);
    const efforts = modelOption?.efforts.length
      ? modelOption.efforts
      : provider === "codex"
        ? ["low", "medium", "high", "xhigh"]
        : ["low", "medium", "high", "xhigh", "max"];
    setDialog({
      type: "select",
      title: `${provider}: select effort`,
      choices: [
        { id: "__default__", label: "Provider default" },
        ...efforts.map((effort) => ({ id: effort, label: effort })),
      ],
      onSelect: (effort) =>
        chooseSaveScope(provider, {
          ...(model ? { model } : {}),
          ...(effort !== "__default__" ? { effort } : {}),
        }),
    });
  };

  const chooseSaveScope = (provider: ProviderName, settings: ProviderRuntimeConfig): void => {
    setDialog({
      type: "select",
      title: "Apply model settings",
      choices: [
        { id: "session", label: "Current session" },
        { id: "project", label: "Session + save to project" },
      ],
      onSelect: (scope) => {
        const currentProvider = runtime.config.providers[provider];
        const merged: ProviderRuntimeConfig = {
          ...(currentProvider.executable ? { executable: currentProvider.executable } : {}),
          ...settings,
        };
        runtime.config.providers[provider] = merged;
        void (async () => {
          if (scope === "project") await saveProviderConfig(cwd, provider, merged);
          append("system", `${provider}: ${formatProviderConfig(merged, provider)} · ${scope}`);
          setDialog(undefined);
        })().catch((error: unknown) => {
          append("error", errorMessage(error));
          setDialog(undefined);
        });
      },
    });
  };

  const showRolesDialog = (): void => {
    setDialog({
      type: "select",
      title: "Select role",
      choices: (Object.keys(runtime.config.agents) as RoleName[]).map((role) => ({
        id: role,
        label: role,
        description: runtime.config.agents[role].provider,
      })),
      onSelect: (role) => {
        setDialog({
          type: "select",
          title: `${role}: select provider (session only)`,
          choices: (["auto", "codex", "claude", "gemini", "antigravity"] as const).map((provider) => ({
            id: provider,
            label: provider,
          })),
          onSelect: (provider) => {
            const roleName = role as RoleName;
            const fallbackChoices = (["codex", "claude", "gemini", "antigravity"] as ProviderName[])
              .filter((item) => item !== provider)
              .map((item) => ({ id: item, label: item }));
            setDialog({
              type: "multi",
              title: `${role}: select fallback providers`,
              choices: fallbackChoices,
              initial: runtime.config.agents[roleName].fallback.filter((item) => item !== provider),
              onSubmit: (fallback) => {
                runtime.config.agents[roleName] = {
                  provider: provider as ProviderName | "auto",
                  fallback: fallback as ProviderName[],
                };
                append("system", `${role} -> ${provider} (fallback: ${fallback.join(", ") || "none"}) for this session`);
                setDialog(undefined);
              },
            });
          },
        });
      },
    });
  };

  const executeCommand = async (source: string): Promise<void> => {
    const command = parseCommand(source);
    if (!command) {
      append("error", `Unknown command: ${source}. Type /help.`);
      return;
    }
    switch (command.name) {
      case "exit":
      case "quit":
        exit();
        return;
      case "clear":
        setTranscript([]);
        setCurrent(undefined);
        setAttachments([]);
        setValue("");
        return;
      case "help":
        append("system", COMMANDS.map((item) => `${item.usage.padEnd(28)} ${item.description}`).join("\n"));
        return;
      case "model":
        showModelDialog();
        return;
      case "roles":
        showRolesDialog();
        return;
      case "role":
        setRoleInline(command.args, runtime, append);
        return;
      case "plan":
        setMode("plan");
        if (command.argumentText) await executeManual("PLAN", command.argumentText);
        else append("system", "Composer mode: PLAN");
        return;
      case "implement":
        setMode("implement");
        if (command.argumentText) await executeManual("IMPLEMENT", command.argumentText);
        else append("system", "Composer mode: IMPLEMENT");
        return;
      case "debug":
        setMode("debug");
        if (command.argumentText) await executeManual("DEBUG", command.argumentText);
        else append("system", "Composer mode: DEBUG");
        return;
      case "verify":
        setMode("verify");
        if (command.argumentText) await executeManual("VERIFY", command.argumentText);
        else append("system", "Composer mode: VERIFY");
        return;
      case "review":
        setMode("review");
        if (command.argumentText) await executeManual("REVIEW", command.argumentText);
        else append("system", "Composer mode: REVIEW");
        return;
      case "run":
        setMode("run");
        if (command.argumentText) await executeWorkflow(command.argumentText);
        else append("system", "Composer mode: RUN");
        return;
      case "status":
        append("system", formatStatus(runtime, current, attachments, mode));
        return;
      case "budget":
        append("system", JSON.stringify(runtime.config.budgets, null, 2));
        return;
      case "diff":
        append("system", await readArtifact(runtime, current, "changes.patch"));
        return;
      case "log":
        append("system", await readArtifact(runtime, current, "events.jsonl"));
        return;
      case "transcript":
        append("system", current ? await renderStoredTranscript(runtime.store, current.id) : "No run in this session.");
        return;
      case "steer":
        if (!liveRunId || !running) append("error", "No live agent session is running.");
        else if (!command.argumentText) append("error", "Usage: /steer <message>");
        else {
          await runtime.engine.steer(liveRunId, command.argumentText);
          append("user", `STEER> ${command.argumentText}`);
        }
        return;
      case "doctor": {
        const report = await runDoctor(
          cwd,
          runtime.adapters,
          runtime.runner,
          command.args.includes("--live"),
          runtime.config.providers,
        );
        append("system", formatDoctorReport(report));
        return;
      }
      case "resume": {
        const id = command.args[0];
        if (id) await resumeRun(id);
        else await showResumeDialog();
        return;
      }
    }
  };

  const resumeRun = async (id: string): Promise<void> => {
    setRunning(true);
    const controller = new AbortController();
    abortController.current = controller;
    try {
      const state = await runtime.engine.resume(id, {
        signal: controller.signal,
        onEvent: appendWorkflowEvent,
        interactive: true,
      });
      setCurrent(state);
      append("system", `Resumed ${id}: ${state.stage} (${state.status})`);
      reportState(state);
    } finally {
      setRunning(false);
      abortController.current = undefined;
    }
  };

  const showResumeDialog = async (): Promise<void> => {
    const runs = await runtime.store.listRuns();
    setDialog({
      type: "select",
      title: "Resume run",
      choices: runs.slice(0, 12).map((run) => ({
        id: run.id,
        label: `${run.stage.padEnd(9)} ${run.request.slice(0, 60)}`,
        description: run.id,
      })),
      onSelect: (id) => {
        setDialog(undefined);
        void resumeRun(id);
      },
    });
  };

  const submit = (source: string): void => {
    const trimmed = source.trim();
    if (!parseCommand(trimmed) && selectSuggestion()) return;
    if (!trimmed) return;
    if (trimmed.startsWith("/")) {
      clearSubmittedCommandInput({ setValue, setDismissedInput, setSelected, setMentionDirectory });
      void executeCommand(trimmed).catch((error) => append("error", errorMessage(error)));
    }
    else {
      setDismissedInput("");
      if (pendingInteraction) {
        const lower = trimmed.toLowerCase();
        const response = pendingInteraction.request.kind === "permission"
          ? lower === "y" || lower === "yes"
            ? { kind: "allow_once" as const }
            : lower === "a" || lower === "always"
              ? { kind: "allow_session" as const }
              : { kind: "deny" as const }
          : { kind: "answer" as const, answers: [trimmed] };
        setValue("");
        void runtime.engine.respondToInteraction(pendingInteraction.runId, response)
          .then(() => setPendingInteraction(undefined))
          .catch((error) => append("error", errorMessage(error)));
      }
      else if (running) append("error", "An agent is running. Use /steer <message> or Ctrl+C.");
      else if (current?.checkpoint && ["awaiting_input", "paused"].includes(current.status)) void respondToCheckpoint(trimmed);
      else if (mode === "run") void executeWorkflow(trimmed);
      else void executeManual(modeToStep(mode), trimmed);
    }
  };

  return (
    <Box flexDirection="column">
      <CarisLogo project={cwd} />
      <Box flexDirection="column" marginBottom={1}>
        {renderTranscriptGroups(transcript)}
      </Box>

      {dialog ? (
        dialog.type === "select" ? (
          <SelectionDialog
            title={dialog.title}
            choices={dialog.choices}
            onSelect={dialog.onSelect}
            onCancel={() => setDialog(undefined)}
          />
        ) : dialog.type === "multi" ? (
          <MultiSelectionDialog
            title={dialog.title}
            choices={dialog.choices}
            initial={dialog.initial}
            onSubmit={dialog.onSubmit}
            onCancel={() => setDialog(undefined)}
          />
        ) : (
          <InputDialog
            title={dialog.title}
            initialValue={dialog.value}
            onSubmit={dialog.onSubmit}
            onCancel={() => setDialog(undefined)}
          />
        )
      ) : (
        <>
          {attachments.length > 0 && (
            <Text color="cyan">Attachments: {attachments.map((item) => `@${item}`).join("  ")}</Text>
          )}
          {commandOptions.length > 0 && (
            <SuggestionList
              items={commandOptions.map((item) => ({ label: item.usage, description: item.description }))}
              selected={selected}
            />
          )}
          {mentionOptions.length > 0 && (
            <SuggestionList
              items={mentionOptions.map(formatFileSuggestion)}
              selected={selected}
              title={mentionDirectory ? `@${mentionDirectory}/` : "Files"}
            />
          )}
          {mention && mentionOptions.length === 0 && (
            <Box borderStyle="round" borderColor="gray" paddingX={1}>
              <Text dimColor>{fileIndex.entries.length === 0 ? fileIndex.diagnostic : "No matching project files."}</Text>
            </Box>
          )}
          {mention && fileIndex.truncated && mentionOptions.length > 0 && (
            <Text color="yellow">{fileIndex.diagnostic}</Text>
          )}
          {current?.checkpoint && <CheckpointPrompt state={current} />}
          {pendingInteraction && (
            <InteractionPrompt
              request={pendingInteraction.request}
              onResponse={(response) => {
                void runtime.engine.respondToInteraction(pendingInteraction.runId, response)
                  .then(() => setPendingInteraction(undefined))
                  .catch((error) => append("error", errorMessage(error)));
              }}
            />
          )}
          <Box borderStyle="single" borderColor={roleAccent(mode)} paddingX={1}>
            <Text color={roleAccent(mode)}>{mode.toUpperCase()} › </Text>
            <ComposerInput
                value={value}
                onChange={(next) => {
                  setValue(next);
                  setDismissedInput("");
                  const mentioned = new Set(extractMentionPaths(next));
                  setAttachments((items) => items.filter((item) => mentioned.has(item)));
                }}
                onSubmit={submit}
                focus={!pendingInteraction}
                placeholder={pendingInteraction ? "Answer the agent request (Y / A / N or text)" : current?.checkpoint ? "Y / N / custom feedback" : running ? "Use /steer <message> or Ctrl+C" : "Ask CARIS, type / for commands, @ for files"}
              />
            {running && <Text dimColor>  Working... Ctrl+C to cancel</Text>}
          </Box>
          <Text dimColor>
            {formatFooter(runtime, current, attachments.length)} · empty Backspace removes attachment
          </Text>
        </>
      )}
    </Box>
  );
}

export function InteractionPrompt({
  request,
  onResponse,
}: {
  request: InteractionRequest;
  onResponse?: (response: import("./domain.js").InteractionResponse) => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [other, setOther] = useState(request.choices.length === 0);
  const [answer, setAnswer] = useState("");
  useInput((input, key) => {
    if (!onResponse || other) return;
    if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    if (key.downArrow) setSelected((value) => Math.min(request.choices.length - 1, value + 1));
    if ((key.tab || input === " ") && request.allowMultiple) {
      const id = request.choices[selected]?.id;
      if (id) setSelectedIds((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
    }
    if (input.toLowerCase() === "o" && request.kind === "question") setOther(true);
    if (key.escape) onResponse(request.kind === "permission" ? { kind: "deny" } : { kind: "answer", answers: [] });
    if (key.return) {
      const ids = request.allowMultiple ? selectedIds : request.choices[selected] ? [request.choices[selected]!.id] : [];
      if (request.kind === "permission") {
        const id = ids[0]?.toLowerCase();
        const label = request.choices.find((choice) => choice.id === ids[0])?.label.toLowerCase() ?? "";
        onResponse({ kind: id === "a" || id?.includes("always") || label.includes("allow_always") || label.includes("session") ? "allow_session" : id === "y" || id?.includes("allow") || label.includes("allow_once") ? "allow_once" : "deny" });
      } else onResponse({ kind: "answer", answers: ids });
    }
  }, { isActive: Boolean(onResponse) && !other });
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text bold color="yellow">Agent input required</Text>
      <Text>{request.prompt}</Text>
      {request.choices.map((choice, index) => (
        <Text key={choice.id} {...(index === selected ? { color: "cyan" as const } : {})}>
          {index === selected ? "› " : "  "}{selectedIds.includes(choice.id) ? "[x] " : ""}{choice.label}
        </Text>
      ))}
      {other && onResponse && (
        <ComposerInput
          value={answer}
          onChange={setAnswer}
          onSubmit={(value) => onResponse({ kind: "answer", answers: [value] })}
          placeholder="Type your answer"
          {...(request.secret !== undefined ? { mask: request.secret } : {})}
        />
      )}
      {request.kind === "permission" && <Text dimColor>↑/↓ select  Enter confirm  Esc deny</Text>}
      {request.kind === "question" && !other && <Text dimColor>↑/↓ select  Space/Tab toggle  O other  Enter confirm</Text>}
    </Box>
  );
}

export function clearSubmittedCommandInput(actions: {
  setValue: (value: string) => void;
  setDismissedInput: (value: string) => void;
  setSelected: (value: number) => void;
  setMentionDirectory: (value: string) => void;
}): void {
  actions.setValue("");
  actions.setDismissedInput("");
  actions.setSelected(0);
  actions.setMentionDirectory("");
}

export function CheckpointPrompt({ state }: { state: RunState }): React.JSX.Element | null {
  if (!state.checkpoint) return null;
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text color="yellow">{state.checkpoint.completedStep} complete → {state.checkpoint.nextAction}</Text>
      <Text>Y: continue · N: pause · custom text: revise</Text>
    </Box>
  );
}

export function MultiSelectionDialog({
  title,
  choices,
  initial,
  onSubmit,
  onCancel,
}: {
  title: string;
  choices: Choice[];
  initial: string[];
  onSubmit: (ids: string[]) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState(0);
  const [checked, setChecked] = useState(() => new Set(initial));
  useInput((input, key) => {
    if (key.upArrow) setSelected((index) => Math.max(0, index - 1));
    if (key.downArrow) setSelected((index) => Math.min(choices.length - 1, index + 1));
    const selectedChoice = choices[selected];
    if (input === " " && selectedChoice) {
      setChecked((current) => {
        const next = new Set(current);
        const id = selectedChoice.id;
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }
    if (key.return) onSubmit(choices.map((choice) => choice.id).filter((id) => checked.has(id)));
    if (key.escape) onCancel();
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{title}</Text>
      {choices.map((choice, index) => (
        <Text key={choice.id} {...(index === selected ? { color: "cyan" as const } : {})}>
          {index === selected ? "› " : "  "}[{checked.has(choice.id) ? "x" : " "}] {choice.label}
        </Text>
      ))}
      <Text dimColor>↑/↓ select · Space toggle · Enter confirm · Esc cancel</Text>
    </Box>
  );
}

export function SelectionDialog({
  title,
  choices,
  onSelect,
  onCancel,
}: {
  title: string;
  choices: Choice[];
  onSelect: (id: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState(0);
  useInput((_, key) => {
    if (key.upArrow) setSelected((index) => Math.max(0, index - 1));
    if (key.downArrow) setSelected((index) => Math.min(choices.length - 1, index + 1));
    if (key.return && choices[selected]) onSelect(choices[selected].id);
    if (key.escape) onCancel();
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{title}</Text>
      {choices.length === 0 ? (
        <Text dimColor>No options available. Esc to cancel.</Text>
      ) : (
        choices.map((choice, index) => (
          <Text key={choice.id} {...(index === selected ? { color: "cyan" as const } : {})}>
            {index === selected ? "› " : "  "}{choice.label}
            {choice.description ? <Text dimColor> · {choice.description}</Text> : null}
          </Text>
        ))
      )}
      <Text dimColor>↑/↓ select · Enter confirm · Esc cancel</Text>
    </Box>
  );
}

function InputDialog({
  title,
  initialValue,
  onSubmit,
  onCancel,
}: {
  title: string;
  initialValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue);
  useInput((_, key) => {
    if (key.escape) onCancel();
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{title}</Text>
      <TextInput value={value} onChange={setValue} onSubmit={onSubmit} focus />
      <Text dimColor>Enter confirm · Esc cancel</Text>
    </Box>
  );
}

export function SuggestionList({
  items,
  selected,
  title,
}: {
  items: Array<{ label: string; description?: string }>;
  selected: number;
  title?: string;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {title && <Text bold>{title}</Text>}
      {items.slice(0, 8).map((item, index) => (
        <Text key={`${item.label}-${index}`} {...(index === selected ? { color: "cyan" as const } : {})}>
          {index === selected ? "› " : "  "}{item.label}
          {item.description ? <Text dimColor> · {item.description}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

let transcriptId = 0;
function entry(
  kind: TranscriptEntry["kind"],
  text: string,
  metadata: Pick<TranscriptEntry, "agentCallId" | "role" | "provider" | "streamKey"> = {},
): TranscriptEntry {
  transcriptId += 1;
  return { id: transcriptId, kind, text, ...metadata };
}

function renderTranscriptGroups(items: TranscriptEntry[]): React.JSX.Element[] {
  const rendered: React.JSX.Element[] = [];
  for (let index = 0; index < items.length;) {
    const item = items[index]!;
    if (item.agentCallId === undefined) {
      rendered.push(renderTranscript(item));
      index += 1;
      continue;
    }
    const group = [item];
    let cursor = index + 1;
    while (cursor < items.length && items[cursor]?.agentCallId === item.agentCallId) {
      group.push(items[cursor]!);
      cursor += 1;
    }
    rendered.push(<AgentResponseBlock key={`agent-${item.agentCallId}-${item.id}`} entries={group} />);
    index = cursor;
  }
  return rendered;
}

export function AgentResponseBlock({ entries }: { entries: TranscriptEntry[] }): React.JSX.Element {
  const first = entries[0];
  const role = first?.role;
  const provider = first?.provider;
  const title = [role ? capitalize(role) : "Agent", provider ? capitalize(provider) : undefined]
    .filter(Boolean)
    .join(" · ");
  return (
    <Box borderStyle="round" borderColor={roleAccent(role)} paddingX={1} flexDirection="column" marginBottom={1}>
      <Text bold color={roleAccent(role)}>{title}</Text>
      {entries.map(renderTranscript)}
    </Box>
  );
}

function renderTranscript(item: TranscriptEntry): React.JSX.Element {
  if (item.kind === "error") return <Text key={item.id} color="red">{item.text}</Text>;
  if (item.kind === "event") return <Text key={item.id} color="yellow">{item.text}</Text>;
  if (item.kind === "tool") return <Text key={item.id} color="gray">{item.text}</Text>;
  if (item.kind === "diff") return <Text key={item.id} color="green">{item.text}</Text>;
  if (item.kind === "user") return <Text key={item.id} color="cyan">{item.text}</Text>;
  return <Text key={item.id}>{item.text}</Text>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatFileSuggestion(item: FileIndexEntry): { label: string; description: string } {
  return { label: item.path, description: item.kind === "directory" ? "directory" : "file" };
}

function formatProviderConfig(config: ProviderRuntimeConfig, provider: ProviderName): string {
  const model = config.model ?? "provider default";
  const effort = provider === "gemini" || provider === "antigravity" ? "effort unsupported" : config.effort ?? "default effort";
  return `${model} · ${effort}`;
}

function formatFooter(runtime: Runtime, current: RunState | undefined, attachmentCount: number): string {
  const stage = current?.stage ?? "idle";
  const checkpoint = current?.checkpoint ? ` · awaiting ${current.checkpoint.nextAction}` : "";
  return `stage ${stage} (${current?.status ?? "idle"})${checkpoint} · attachments ${attachmentCount} · /model ${formatProviderConfig(runtime.config.providers.codex, "codex")}`;
}

function formatStatus(
  runtime: Runtime,
  current: RunState | undefined,
  attachments: string[],
  mode: ComposerMode,
): string {
  const providers = (["codex", "claude", "gemini", "antigravity"] as ProviderName[])
    .map((provider) => {
      const adapter = runtime.adapters.get(provider);
      const capability = adapter?.capabilities;
      return `${provider}: ${formatProviderConfig(runtime.config.providers[provider], provider)}\n  executable: ${adapter?.executable ?? "not registered"}\n  capabilities: stream=${capability?.streaming ?? false} approvals=${capability?.approvals ?? false} questions=${capability?.questions ?? false} steer=${capability?.steering ?? false}`;
    })
    .join("\n");
  const roles = (Object.keys(runtime.config.agents) as RoleName[])
    .map((role) => `${role}: ${runtime.config.agents[role].provider}`)
    .join("\n");
  return [
    `workspace: ${runtime.workspaceContext.kind === "git" ? `Git (${runtime.workspaceContext.root})` : "Directory mode (Git diff/recovery unavailable; initialize Git and create a baseline commit to enable them)"}`,
    `mode: ${mode}`,
    `run: ${current ? `${current.id} ${current.executionMode} ${current.stage}/${current.status} calls=${current.agentCalls}` : "none"}`,
    `checkpoint: ${current?.checkpoint ? `${current.checkpoint.completedStep} -> ${current.checkpoint.nextAction}` : "none"}`,
    `steps: ${current?.stepHistory.map((item) => `${item.index}:${item.step}/${item.status}`).join(", ") || "none"}`,
    `attachments: ${attachments.join(", ") || "none"}`,
    "providers:",
    providers,
    "roles:",
    roles,
  ].join("\n");
}

function setRoleInline(
  args: string[],
  runtime: Runtime,
  append: (kind: TranscriptEntry["kind"], text: string) => void,
): void {
  const roles: RoleName[] = ["planner", "implementer", "debugger", "verifier", "reviewer"];
  const providers: ProviderName[] = ["codex", "claude", "gemini", "antigravity"];
  if (args[0] !== "set" || !roles.includes(args[1] as RoleName) || !providers.includes(args[2] as ProviderName)) {
    throw new Error("Usage: /role set <planner|implementer|debugger|verifier|reviewer> <codex|claude|gemini|antigravity>");
  }
  runtime.config.agents[args[1] as RoleName].provider = args[2] as ProviderName;
  append("system", `${args[1]} -> ${args[2]} for this session`);
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function modeToStep(mode: Exclude<ComposerMode, "run">): ManualStep {
  return mode.toUpperCase() as ManualStep;
}

async function readArtifact(
  runtime: Runtime,
  current: RunState | undefined,
  name: string,
): Promise<string> {
  if (!current) return "No run in this session.";
  try {
    return await readFile(path.join(runtime.store.runDir(current.id), name), "utf8");
  } catch {
    return `${name} is not available.`;
  }
}
