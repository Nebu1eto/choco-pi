import { execFile, spawn, type ExecFileException } from "node:child_process";
import { isString } from "../../runtime-values.ts";
import type { ExecRunner } from "../types.ts";
import type { DiffClock } from "./clock.ts";
import type { DiffLimits } from "./limits.ts";

export const PINNED_GIT_OPTIONS: readonly string[] = [
  "--no-optional-locks",
  "--no-pager",
  "--literal-pathspecs",
  "-c",
  "core.quotepath=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "color.ui=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.relative=false",
];

export const PINNED_DIFF_OPTIONS: readonly string[] = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--no-relative",
  "--ignore-submodules=dirty",
];

export class DiffGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffGitError";
  }
}

export type CapturedExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  killSignal?: NodeJS.Signals;
  maxBuffer: number;
};

export type CapturedExec<Output> = {
  stdout: Output;
  stderr: Output;
  error: ExecFileException | null;
};

function captureOptions(options: CapturedExecOptions) {
  return {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs ?? 0,
    killSignal: options.killSignal ?? "SIGTERM",
    maxBuffer: options.maxBuffer,
  };
}

export function execFileCapture(
  cmd: string,
  args: readonly string[],
  options: CapturedExecOptions,
): Promise<CapturedExec<string>> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      [...args],
      { ...captureOptions(options), encoding: "utf8" },
      (error, stdout, stderr) => resolve({ stdout, stderr, error }),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input ?? "");
  });
}

export function execFileCaptureBuffer(
  cmd: string,
  args: readonly string[],
  options: CapturedExecOptions,
): Promise<CapturedExec<Buffer>> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      [...args],
      { ...captureOptions(options), encoding: "buffer" },
      (error, stdout, stderr) => resolve({ stdout, stderr, error }),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input ?? "");
  });
}

export function isSpawnFailure(error: ExecFileException): boolean {
  return isString(error.code) && error.syscall?.startsWith("spawn") === true;
}

export class DiffDisposedError extends Error {
  constructor() {
    super("The diff store was disposed.");
    this.name = "DiffDisposedError";
  }
}

function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((value) => value.trim())
      .find(Boolean) ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export function shortErrorMessage(error: Error | string): string {
  return firstLine(error instanceof Error ? error.message : error) || "Unknown error";
}

function subcommandOf(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-c") {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) return arg;
  }
  return "git";
}

export function createGitExecRunner(
  limits: Pick<DiffLimits, "timeoutMs" | "maxOutputBytes">,
  signal?: AbortSignal,
): ExecRunner {
  return (cmd, args, opts) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DiffDisposedError());
        return;
      }
      const child = spawn(cmd, args, {
        cwd: opts?.cwd,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          PAGER: "cat",
          LC_ALL: "C",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        action();
      };
      const abort = () =>
        finish(() => {
          child.kill("SIGKILL");
          reject(new DiffDisposedError());
        });
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        finish(() => {
          child.kill("SIGKILL");
          reject(
            new DiffGitError(`git ${subcommandOf(args)} timed out after ${limits.timeoutMs} ms`),
          );
        });
      }, limits.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > limits.maxOutputBytes) {
          finish(() => {
            child.kill("SIGKILL");
            reject(
              new DiffGitError(
                `git ${subcommandOf(args)} output exceeded ${limits.maxOutputBytes} bytes`,
              ),
            );
          });
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes >= 64 * 1024) return;
        stderrBytes += chunk.length;
        stderr.push(chunk);
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) =>
        finish(() =>
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            code: code ?? 1,
          }),
        ),
      );
      child.stdin.on("error", () => {});
      child.stdin.end(opts?.input ?? "");
    });
}

export type PinnedGitRunner = {
  run: ExecRunner;
  cancelAll(): void;
};

export function createPinnedGitRunner(
  exec: ExecRunner,
  clock: DiffClock,
  limits: Pick<DiffLimits, "timeoutMs" | "maxOutputBytes">,
): PinnedGitRunner {
  const inFlight = new Set<(error: Error) => void>();
  let closed = false;
  const run: ExecRunner = (cmd, args, opts) => {
    const pinnedArgs = cmd === "git" ? [...PINNED_GIT_OPTIONS, ...args] : args;
    if (closed) return Promise.reject(new DiffDisposedError());
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clock.clearTimeout(timer);
        inFlight.delete(cancel);
        action();
      };
      const cancel = (error: Error) => settle(() => reject(error));
      const timer = clock.setTimeout(() => {
        cancel(
          new DiffGitError(`git ${subcommandOf(args)} timed out after ${limits.timeoutMs} ms`),
        );
      }, limits.timeoutMs);
      inFlight.add(cancel);
      new Promise<Awaited<ReturnType<ExecRunner>>>((start) =>
        start(exec(cmd, pinnedArgs, opts)),
      ).then(
        (result) =>
          settle(() => {
            if (Buffer.byteLength(result.stdout, "utf8") > limits.maxOutputBytes) {
              reject(
                new DiffGitError(
                  `git ${subcommandOf(args)} output exceeded ${limits.maxOutputBytes} bytes`,
                ),
              );
              return;
            }
            resolve(result);
          }),
        (error: Error) => settle(() => reject(error)),
      );
    });
  };
  return {
    run,
    cancelAll() {
      closed = true;
      for (const cancel of inFlight) cancel(new DiffDisposedError());
    },
  };
}

export async function runGit(
  runner: ExecRunner,
  cwd: string,
  args: string[],
  allowedCodes: readonly number[] = [0],
  input?: string,
): Promise<string> {
  const result = await runner("git", args, input === undefined ? { cwd } : { cwd, input });
  if (!allowedCodes.includes(result.code)) {
    const detail = firstLine(result.stderr) || `exited with status ${result.code}`;
    throw new DiffGitError(`git ${subcommandOf(args)} failed: ${detail}`);
  }
  return result.stdout;
}
