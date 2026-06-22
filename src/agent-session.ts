import type {
  AgentResult,
  AgentSession,
  AgentSessionEvent,
  AgentTask,
  InteractionResponse,
  ProviderCapabilities,
} from "./domain.js";
import type { ProcessHandle, ProcessRequest, ProcessRunner } from "./process-runner.js";

export const BUFFERED_CAPABILITIES: ProviderCapabilities = {
  streaming: false,
  approvals: false,
  questions: false,
  steering: false,
  resume: false,
};

export const STREAMING_OUTPUT_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  approvals: false,
  questions: false,
  steering: false,
  resume: false,
};

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export function createStreamingCliSession(options: {
  runner: ProcessRunner;
  request: ProcessRequest;
  task: AgentTask;
  provider: AgentResult["provider"];
  parseResult: (stdout: string, stderr: string) => Pick<AgentResult, "output" | "rawEvents">;
  parseTranscript: (stdout: string, stderr: string) => AgentResult["transcript"];
}): AgentSession | undefined {
  if (!options.runner.spawn) return undefined;
  const events = new AsyncEventQueue<AgentSessionEvent>();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let sequence = 0;
  const emitLines = (chunk: string, stderr = false): void => {
    if (stderr) {
      stderrBuffer += chunk;
      return;
    }
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      for (const item of options.parseTranscript(`${line}\n`, "")) {
        events.push({ kind: "transcript", item, sequence: ++sequence });
      }
    }
  };
  let handle: ProcessHandle;
  handle = options.runner.spawn(options.request, {
    stdout: (chunk) => emitLines(chunk),
    stderr: (chunk) => emitLines(chunk, true),
  });
  if (options.request.input !== undefined) handle.write(options.request.input);
  handle.endInput();
  const result = handle.completed.then((processResult) => {
    if (stdoutBuffer) {
      for (const item of options.parseTranscript(stdoutBuffer, "")) {
        events.push({ kind: "transcript", item, sequence: ++sequence });
      }
    }
    const parsed = options.parseResult(processResult.stdout, processResult.stderr);
    return {
      provider: options.provider,
      exitCode: processResult.exitCode,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      durationMs: processResult.durationMs,
      ...parsed,
      transcript: options.parseTranscript(processResult.stdout, processResult.stderr),
    };
  }).finally(() => events.close());
  return {
    events,
    result,
    respond: async () => { throw new Error(`${options.provider} session does not expose interactive requests`); },
    steer: async () => { throw new Error(`${options.provider} session does not support steering`); },
    cancel: async () => handle.cancel(),
  };
}

export function createBufferedSession(execute: () => Promise<AgentResult>): AgentSession {
  const events = new AsyncEventQueue<AgentSessionEvent>();
  const result = execute().finally(() => events.close());
  return {
    events,
    result,
    respond: async (_id: string, _response: InteractionResponse) => { throw new Error("Buffered session cannot respond"); },
    steer: async () => { throw new Error("Buffered session cannot steer"); },
    cancel: async () => undefined,
  };
}

export function createProtocolFallbackSession(
  primary: AgentSession,
  fallback: () => AgentSession,
  shouldFallback: (result: AgentResult) => boolean,
): AgentSession {
  const events = new AsyncEventQueue<AgentSessionEvent>();
  let active = primary;
  let sequence = 0;
  const forward = async (session: AgentSession): Promise<void> => {
    for await (const event of session.events) events.push({ ...event, sequence: ++sequence });
  };
  const primaryPump = forward(primary);
  const result = primary.result.then(async (primaryResult) => {
    await primaryPump;
    if (!shouldFallback(primaryResult)) return primaryResult;
    events.push({ kind: "diagnostic", message: "Interactive protocol is unavailable; using the buffered CLI adapter.", sequence: ++sequence });
    active = fallback();
    const fallbackPump = forward(active);
    const fallbackResult = await active.result;
    await fallbackPump;
    return fallbackResult;
  }).finally(() => events.close());
  return {
    events,
    result,
    respond: (id, response) => active.respond(id, response),
    steer: (message) => active.steer(message),
    cancel: () => active.cancel(),
  };
}

export function isUnsupportedProtocolFailure(result: AgentResult): boolean {
  return result.exitCode !== 0 && /unknown (?:command|option)|unrecognized|unsupported|not supported|invalid.*(?:app-server|--acp)/i.test(`${result.stderr}\n${result.output}`);
}
