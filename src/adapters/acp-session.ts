import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { AsyncEventQueue } from "../agent-session.js";
import type {
  AgentResult,
  AgentSession,
  AgentSessionEvent,
  AgentTask,
  AgentTranscriptItem,
  InteractionRequest,
  InteractionResponse,
  ProviderName,
} from "../domain.js";
import type { ProcessHandle, ProcessRequest, ProcessResult, ProcessRunner } from "../process-runner.js";

interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface AcpSessionOptions {
  provider: ProviderName;
  runner: ProcessRunner;
  executable: string;
  args: string[];
  task: AgentTask;
  env?: NodeJS.ProcessEnv;
  diagnosticName?: string;
  supportsSteering?: boolean;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};
type UnsequencedAcpEvent =
  | { kind: "transcript"; item: AgentTranscriptItem; delta?: boolean }
  | { kind: "interaction_requested"; request: InteractionRequest }
  | { kind: "diagnostic"; message: string };

export function createAcpSession(options: AcpSessionOptions): AgentSession | undefined {
  if (!options.runner.spawn) return undefined;
  const events = new AsyncEventQueue<AgentSessionEvent>();
  const transcript: AgentTranscriptItem[] = [];
  const rawEvents: unknown[] = [];
  const pending = new Map<string | number, PendingRequest>();
  const pendingInteractions = new Map<string, { rpcId: string | number; params: Record<string, unknown> }>();
  const started = performance.now();
  let stdout = "";
  let stderr = "";
  let stdoutBuffer = "";
  let sequence = 0;
  let requestId = 0;
  let sessionId = "";
  let output = "";
  let processResult: ProcessResult | undefined;
  let handle: ProcessHandle;

  const emit = (event: UnsequencedAcpEvent): void => {
    events.push({ ...event, sequence: ++sequence } as AgentSessionEvent);
  };
  const write = (message: JsonRpcMessage): void => {
    handle.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = ++requestId;
    write({ id, method, params });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const respondRpc = (id: string | number | null | undefined, result: unknown): void => {
    if (id === undefined || id === null) return;
    write({ id, result });
  };
  const rejectRpc = (id: string | number | null | undefined, message: string): void => {
    if (id === undefined || id === null) return;
    write({ id, error: { code: -32601, message } });
  };
  const finishPending = (error: Error): void => {
    for (const pendingRequest of pending.values()) pendingRequest.reject(error);
    pending.clear();
  };

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch (error) {
      emit({ kind: "diagnostic", message: `Invalid ACP event from ${options.provider}: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    rawEvents.push(message);
    if (message.id !== undefined && message.id !== null && message.method === undefined) {
      const pendingRequest = pending.get(message.id);
      if (!pendingRequest) return;
      pending.delete(message.id);
      if (message.error) pendingRequest.reject(new Error(message.error.message ?? "ACP request failed"));
      else pendingRequest.resolve(message.result);
      return;
    }
    if (message.method === methods.client.session.update) {
      handleSessionUpdate(record(message.params)?.update);
      return;
    }
    if (message.method === methods.client.session.requestPermission) {
      handlePermissionRequest(message.id, record(message.params));
      return;
    }
    if (message.method === methods.client.elicitation.create) {
      handleQuestionRequest(message.id, record(message.params));
      return;
    }
    if (message.method) {
      const detail = `${options.provider} ACP requested unsupported client method: ${message.method}`;
      emit({ kind: "diagnostic", message: detail });
      rejectRpc(message.id, detail);
    }
  };

  handle = options.runner.spawn(
    {
      executable: options.executable,
      args: options.args,
      cwd: options.task.cwd,
      ...(options.task.timeoutMs !== undefined ? { timeoutMs: options.task.timeoutMs } : {}),
      ...(options.task.signal !== undefined ? { signal: options.task.signal } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    } satisfies ProcessRequest,
    {
      stdout: (chunk) => {
        stdout += chunk;
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      },
      stderr: (chunk) => {
        stderr += chunk;
        emit({ kind: "diagnostic", message: chunk });
      },
    },
  );

  handle.completed.then((result) => {
    processResult = result;
    finishPending(new Error(result.stderr.trim() || result.stdout.trim() || `${options.provider} ACP process exited with code ${result.exitCode}`));
  }).catch((error: unknown) => {
    finishPending(error instanceof Error ? error : new Error(String(error)));
  });

  const result = (async (): Promise<AgentResult> => {
    try {
      await request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          plan: {},
          elicitation: {},
          auth: { terminal: false },
        },
        clientInfo: { name: "caris", version: "0.1.0" },
      });
      const session = record(await request(methods.agent.session.new, { cwd: options.task.cwd, mcpServers: [] }));
      sessionId = stringValue(session?.sessionId) ?? "";
      if (!sessionId) throw new Error(`${options.provider} ACP did not return a session id`);
      await request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: options.task.prompt }],
      });
      return buildResult(0, "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.trim()) transcript.push({ kind: "diagnostic", text: message });
      const completed = processResult ?? await settleProcess(handle);
      const exitCode = completed.exitCode === 0 ? 1 : completed.exitCode;
      return buildResult(exitCode, completed.stderr || message);
    } finally {
      events.close();
      if (!processResult) handle.cancel();
    }
  })();

  options.task.signal?.addEventListener("abort", () => {
    void cancelSession();
  }, { once: true });

  async function cancelSession(): Promise<void> {
    if (sessionId) {
      write({ method: methods.agent.session.cancel, params: { sessionId } });
    }
    handle.cancel();
  }

  return {
    events,
    result,
    respond: async (requestId, response) => respondInteraction(requestId, response),
    steer: async (message) => {
      if (!options.supportsSteering) throw new Error(`${options.provider} ACP does not support same-turn steering`);
      if (!sessionId) throw new Error(`${options.provider} ACP session has not started yet`);
      await request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: message }] });
    },
    cancel: cancelSession,
  };

  function handleSessionUpdate(update: unknown): void {
    const payload = record(update);
    const sessionUpdate = stringValue(payload?.sessionUpdate);
    if (!payload || !sessionUpdate) return;
    if (sessionUpdate === "agent_message_chunk") {
      const text = contentText(payload.content);
      if (!text) return;
      output += text;
      emit({ kind: "transcript", item: { kind: "assistant_message", text }, delta: true });
      return;
    }
    if (sessionUpdate === "tool_call") {
      const item: AgentTranscriptItem = {
        kind: "tool_call",
        tool: stringValue(payload.kind) ?? "tool",
        text: stringValue(payload.title) ?? stringify(payload.rawInput ?? payload),
      };
      transcript.push(item);
      emit({ kind: "transcript", item });
      return;
    }
    if (sessionUpdate === "tool_call_update") {
      const text = [
        stringValue(payload.title),
        stringValue(payload.status),
        contentText(payload.content),
        payload.rawOutput !== undefined ? stringify(payload.rawOutput) : undefined,
      ].filter(Boolean).join("\n");
      const item: AgentTranscriptItem = { kind: "tool_result", text: text || stringify(payload) };
      transcript.push(item);
      emit({ kind: "transcript", item });
      return;
    }
    if (sessionUpdate === "usage_update") {
      const usage = numericRecord(payload);
      const item: AgentTranscriptItem = { kind: "usage", text: stringify(payload), usage };
      transcript.push(item);
      emit({ kind: "transcript", item });
      return;
    }
    if (sessionUpdate === "plan") {
      const entries = Array.isArray(payload.entries) ? payload.entries.map(planEntryText).filter(Boolean).join("\n") : "";
      if (entries) emit({ kind: "transcript", item: { kind: "assistant_message", text: entries } });
    }
  }

  function handlePermissionRequest(rpcId: string | number | null | undefined, params: Record<string, unknown> | undefined): void {
    if (rpcId === undefined || rpcId === null || !params) return;
    const toolCall = record(params.toolCall);
    const permissionOptions = Array.isArray(params.options) ? params.options.map(record).filter(Boolean) : [];
    const id = `${options.provider}-permission-${String(rpcId)}`;
    pendingInteractions.set(id, { rpcId, params });
    const request: InteractionRequest = {
      id,
      kind: "permission",
      prompt: stringValue(toolCall?.title) ?? "Allow this ACP tool call?",
      choices: permissionOptions.map((option, index) => ({
        id: stringValue(option?.optionId) ?? stringValue(option?.id) ?? String(index),
        label: `${stringValue(option?.name) ?? stringValue(option?.kind) ?? "option"}${option?.kind ? ` (${String(option.kind)})` : ""}`,
      })),
    };
    emit({ kind: "interaction_requested", request });
  }

  function handleQuestionRequest(rpcId: string | number | null | undefined, params: Record<string, unknown> | undefined): void {
    if (rpcId === undefined || rpcId === null || !params) return;
    const id = `${options.provider}-question-${String(rpcId)}`;
    pendingInteractions.set(id, { rpcId, params });
    emit({
      kind: "interaction_requested",
      request: {
        id,
        kind: "question",
        prompt: stringValue(params.message) ?? stringValue(params.prompt) ?? "The agent needs input.",
        choices: [],
      },
    });
  }

  function respondInteraction(id: string, response: InteractionResponse): void {
    const pendingInteraction = pendingInteractions.get(id);
    if (!pendingInteraction) throw new Error(`Unknown ACP interaction: ${id}`);
    pendingInteractions.delete(id);
    if (id.includes("-permission-")) {
      const params = pendingInteraction.params;
      const permissionOptions = Array.isArray(params.options) ? params.options.map(record).filter(Boolean) : [];
      const desired = response.kind === "allow_session" ? "allow_always" : response.kind === "allow_once" ? "allow_once" : "reject_once";
      const selected = permissionOptions.find((option) => option?.kind === desired) ?? permissionOptions.at(response.kind === "deny" ? -1 : 0);
      respondRpc(pendingInteraction.rpcId, selected
        ? { outcome: { outcome: "selected", optionId: selected.optionId ?? selected.id } }
        : { outcome: { outcome: "cancelled" } });
      return;
    }
    const answers = response.kind === "answer" ? response.answers : [];
    respondRpc(pendingInteraction.rpcId, {
      response: { type: "accepted", values: Object.fromEntries(answers.map((answer, index) => [String(index), answer])) },
    });
  }

  function buildResult(exitCode: number, error: string): AgentResult {
    const finalOutput = output.trim();
    if (finalOutput) transcript.push({ kind: "assistant_message", text: finalOutput });
    return {
      provider: options.provider,
      exitCode,
      output: finalOutput,
      stdout,
      stderr: stderr || error,
      durationMs: processResult?.durationMs ?? Math.round(performance.now() - started),
      rawEvents,
      transcript,
    };
  }
}

async function settleProcess(handle: ProcessHandle): Promise<ProcessResult> {
  try {
    return await handle.completed;
  } catch {
    return { exitCode: 1, stdout: "", stderr: "", durationMs: 0, failed: true, timedOut: false, cancelled: false };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  const payload = record(value);
  if (!payload) return "";
  if (payload.type === "text" && typeof payload.text === "string") return payload.text;
  if (payload.content !== undefined) return contentText(payload.content);
  if (payload.text !== undefined) return contentText(payload.text);
  return "";
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function numericRecord(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}

function planEntryText(value: unknown): string {
  const entry = record(value);
  if (!entry) return "";
  return `- ${[entry.priority, entry.status, entry.content ?? entry.title].filter(Boolean).join(" · ")}`;
}
