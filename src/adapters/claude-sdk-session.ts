import { query, type CanUseTool, type PermissionResult, type Query } from "@anthropic-ai/claude-agent-sdk";
import { AsyncEventQueue } from "../agent-session.js";
import type { AgentResult, AgentSession, AgentSessionEvent, AgentTask, InteractionRequest, InteractionResponse } from "../domain.js";

type JsonRecord = Record<string, unknown>;
type UnsequencedEvent =
  | { kind: "transcript"; item: AgentResult["transcript"][number]; delta?: boolean }
  | { kind: "interaction_requested"; request: InteractionRequest }
  | { kind: "diagnostic"; message: string };

export function createClaudeSdkSession(executable: string, task: AgentTask): AgentSession {
  const events = new AsyncEventQueue<AgentSessionEvent>();
  const transcript: AgentResult["transcript"] = [];
  const rawEvents: unknown[] = [];
  const pending = new Map<string, { resolve: (result: PermissionResult) => void; toolName: string; input: JsonRecord; suggestions?: Parameters<CanUseTool>[2]["suggestions"] }>();
  let sequence = 0;
  let output = "";
  let sessionId = "";
  const started = performance.now();

  const emit = (event: UnsequencedEvent): void => {
    events.push({ ...event, sequence: ++sequence } as AgentSessionEvent);
  };
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    const id = `claude-${options.toolUseID}`;
    const question = toolName === "AskUserQuestion";
    const request: InteractionRequest = {
      id,
      kind: question ? "question" : "permission",
      prompt: question ? formatClaudeQuestions(input) : options.title ?? options.description ?? options.decisionReason ?? `${toolName}\n${JSON.stringify(input, null, 2)}`,
      choices: question ? claudeQuestionChoices(input) : [
        { id: "y", label: "Allow once" },
        { id: "a", label: "Allow for session" },
        { id: "n", label: "Deny" },
      ],
      allowMultiple: question && claudeQuestions(input).some((item) => item.multiSelect === true || claudeQuestions(input).length > 1),
      secret: false,
    };
    emit({ kind: "interaction_requested", request });
    return new Promise<PermissionResult>((resolve) => pending.set(id, {
      resolve,
      toolName,
      input,
      ...(options.suggestions ? { suggestions: options.suggestions } : {}),
    }));
  };

  let sdkQuery: Query = query({
    prompt: task.prompt,
    options: {
      cwd: task.cwd,
      pathToClaudeCodeExecutable: executable,
      includePartialMessages: true,
      permissionMode: task.role === "planner" || task.role === "verifier" || task.role === "reviewer" ? "plan" : "default",
      canUseTool,
      ...(task.model ? { model: task.model } : {}),
      ...(task.effort ? { effort: task.effort as "low" | "medium" | "high" | "max" } : {}),
      ...(task.signal ? { abortController: abortControllerFor(task.signal) } : {}),
    },
  });

  const result = (async (): Promise<AgentResult> => {
    try {
      for await (const message of sdkQuery) {
        rawEvents.push(message);
        const event = record(message);
        if (typeof event.session_id === "string") sessionId = event.session_id;
        if (event.type === "stream_event") {
          const streamEvent = record(event.event);
          const delta = record(streamEvent.delta);
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            output += delta.text;
            emit({ kind: "transcript", item: { kind: "assistant_message", text: delta.text }, delta: true });
          }
          continue;
        }
        if (event.type === "assistant") {
          for (const block of contentBlocks(event)) {
            if (block.type === "text" && typeof block.text === "string") {
              output = block.text;
              transcript.push({ kind: "assistant_message", text: block.text });
            } else if (block.type === "tool_use") {
              const item = { kind: "tool_call" as const, tool: String(block.name ?? "tool"), text: JSON.stringify(block.input ?? {}, null, 2) };
              transcript.push(item);
              emit({ kind: "transcript", item });
            }
          }
        } else if (event.type === "user") {
          for (const block of contentBlocks(event)) {
            if (block.type === "tool_result") {
              const item = { kind: "tool_result" as const, text: stringify(block.content ?? ""), ...(block.is_error === true ? { exitCode: 1 } : {}) };
              transcript.push(item);
              emit({ kind: "transcript", item });
            }
          }
        } else if (event.type === "result") {
          if (typeof event.result === "string") output = event.result;
          if (record(event.usage) && Object.keys(record(event.usage)).length > 0) transcript.push({ kind: "usage", text: JSON.stringify(event.usage), usage: numericRecord(record(event.usage)) });
        }
      }
      return { provider: "claude", exitCode: 0, output: output.trim(), stdout: rawEvents.map((item) => JSON.stringify(item)).join("\n"), stderr: "", durationMs: Math.round(performance.now() - started), rawEvents, transcript };
    } catch (error) {
      return { provider: "claude", exitCode: 1, output: output.trim(), stdout: rawEvents.map((item) => JSON.stringify(item)).join("\n"), stderr: error instanceof Error ? error.message : String(error), durationMs: Math.round(performance.now() - started), rawEvents, transcript };
    } finally {
      events.close();
    }
  })();

  return {
    events,
    result,
    respond: async (id: string, response: InteractionResponse) => {
      const request = pending.get(id);
      if (!request) throw new Error(`Unknown Claude interaction: ${id}`);
      pending.delete(id);
      if (request.toolName === "AskUserQuestion" && response.kind === "answer") {
        const questions = claudeQuestions(request.input);
        const answers = Object.fromEntries(questions.map((question, index) => [
          String(question.question ?? question.header ?? `question-${index + 1}`),
          questions.length === 1 ? response.answers.join(", ") : response.answers[index] ?? "",
        ]));
        request.resolve({ behavior: "allow", updatedInput: { ...request.input, answers } });
      } else if (response.kind === "allow_once") {
        request.resolve({ behavior: "allow", updatedInput: request.input });
      } else if (response.kind === "allow_session") {
        request.resolve({ behavior: "allow", updatedInput: request.input, ...(request.suggestions ? { updatedPermissions: request.suggestions } : {}) });
      } else {
        request.resolve({ behavior: "deny", message: "Denied by user in CARIS" });
      }
    },
    steer: async (message: string) => {
      await sdkQuery.streamInput((async function* () {
        yield { type: "user", message: { role: "user", content: message }, parent_tool_use_id: null, session_id: sessionId } as never;
      })());
    },
    cancel: async () => { await sdkQuery.interrupt().catch(() => undefined); sdkQuery.close(); },
  };
}

function abortControllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

function record(value: unknown): JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function contentBlocks(event: JsonRecord): JsonRecord[] { const message = record(event.message); return Array.isArray(message.content) ? message.content.map(record) : []; }
function stringify(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function numericRecord(value: JsonRecord): Record<string, number> { return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number")); }
function formatClaudeQuestions(input: JsonRecord): string { return (Array.isArray(input.questions) ? input.questions.map(record) : []).map((question) => String(question.question ?? question.header ?? "Answer required")).join("\n"); }
function claudeQuestionChoices(input: JsonRecord): Array<{ id: string; label: string }> { return (Array.isArray(input.questions) ? input.questions.map(record) : []).flatMap((question) => Array.isArray(question.options) ? question.options.map((option) => ({ id: String(record(option).label ?? "option"), label: String(record(option).description ?? record(option).label ?? "option") })) : []); }
function claudeQuestions(input: JsonRecord): JsonRecord[] { return Array.isArray(input.questions) ? input.questions.map(record) : []; }
