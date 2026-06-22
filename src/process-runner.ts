import { execa, type Options } from "execa";
import { access } from "node:fs/promises";
import path from "node:path";

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  failed: boolean;
  timedOut: boolean;
  cancelled: boolean;
  errorCode?: string;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
  spawn?(request: ProcessRequest, listener: ProcessListener): ProcessHandle;
}

export interface ProcessListener {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
}

export interface ProcessHandle {
  readonly completed: Promise<ProcessResult>;
  write(input: string): void;
  endInput(): void;
  cancel(): void;
}

export class ExecaProcessRunner implements ProcessRunner {
  spawn(request: ProcessRequest, listener: ProcessListener): ProcessHandle {
    const started = performance.now();
    const child = execa(request.executable, request.args, {
      cwd: request.cwd,
      reject: false,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      stripFinalNewline: false,
      windowsHide: true,
      ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      stdout += text;
      listener.stdout?.(text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      stderr += text;
      listener.stderr?.(text);
    });
    const abort = (): void => { child.kill("SIGTERM"); };
    request.signal?.addEventListener("abort", abort, { once: true });
    const completed: Promise<ProcessResult> = child.then((result) => ({
      exitCode: result.exitCode ?? 1,
      stdout,
      stderr,
      durationMs: Math.round(performance.now() - started),
      failed: result.failed,
      timedOut: result.timedOut,
      cancelled: result.isCanceled || request.signal?.aborted === true,
    })).catch((error: unknown) => {
      const errorCode = getErrorCode(error);
      return {
        exitCode: 1,
        stdout,
        stderr: stderr || (error instanceof Error ? error.message : String(error)),
        durationMs: Math.round(performance.now() - started),
        failed: true,
        timedOut: false,
        cancelled: request.signal?.aborted === true,
        ...(errorCode !== undefined ? { errorCode } : {}),
      };
    }).finally(() => request.signal?.removeEventListener("abort", abort));
    return {
      completed,
      write: (input) => child.stdin?.write(input),
      endInput: () => child.stdin?.end(),
      cancel: abort,
    };
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    const started = performance.now();
    const options: Options = {
      cwd: request.cwd,
      reject: false,
      stdout: "pipe",
      stderr: "pipe",
      stripFinalNewline: false,
      windowsHide: true,
      ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
      ...(request.signal !== undefined ? { cancelSignal: request.signal } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.input !== undefined ? { input: request.input } : { stdin: "ignore" as const }),
    };

    try {
      const result = await execa(request.executable, request.args, options);
      return {
        exitCode: result.exitCode ?? 1,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
        durationMs: Math.round(performance.now() - started),
        failed: result.failed,
        timedOut: result.timedOut,
        cancelled: result.isCanceled,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = getErrorCode(error);
      return {
        exitCode: 1,
        stdout: "",
        stderr: message,
        durationMs: Math.round(performance.now() - started),
        failed: true,
        timedOut: false,
        cancelled: request.signal?.aborted ?? false,
        ...(errorCode !== undefined ? { errorCode } : {}),
      };
    }
  }
}

export async function resolveExecutable(command: string): Promise<string | undefined> {
  const directories = command.includes("/") || command.includes("\\")
    ? [""]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const hasExtension = path.extname(command) !== "";
  const extensions = process.platform === "win32" && !hasExtension
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = directory ? path.join(directory, `${command}${extension}`) : `${command}${extension}`;
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Continue through PATH in precedence order.
      }
    }
  }
  return undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
