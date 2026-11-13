import { spawn } from "node:child_process";
import type { ExecRunner } from "../types.ts";
import type { DiffClock } from "./clock.ts";
import type { DiffLimits } from "./limits.ts";

/**
 * Global options placed before every git subcommand the pane runs.
 *
 * - `--no-optional-locks` keeps `status` from refreshing and rewriting the
 *   index, so the pane never takes `index.lock` and never blocks, or is
 *   blocked by, the agent's own git commands.
 * - `--literal-pathspecs` makes a file named `*.ts` or `:(glob)x` mean itself.
 * - The `-c` pins neutralise user configuration that would change output
 *   (quoted paths, colour, missing prefixes, cwd-relative paths) or start
 *   extra processes (fsmonitor).
 */
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

/** Options for every `git diff` the pane runs. */
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

/** Short, single-line message for a store error state. */
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

/**
 * Default process runner for the pane: no shell, closed stdin, a hard
 * deadline that kills the child, and a stdout cap that kills the child
 * instead of buffering without bound.
 */
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
      // Aborting kills the child at once instead of letting it run to its deadline.
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
  /** Runs git with pinned options, a clock deadline, and an output cap. */
  run: ExecRunner;
  /** Rejects every call in flight and every later call, clearing all deadline timers. */
  cancelAll(): void;
};

/**
 * Wrap any runner (including an injected test runner) with the pane's git
 * pins and limits. The deadline uses the injected clock so tests can drive
 * it, and `cancelAll` lets dispose leave no timers behind.
 */
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
      // A runner that throws synchronously still settles through the same path.
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
      // Deleting the visited entry during Set iteration is safe.
      for (const cancel of inFlight) cancel(new DiffDisposedError());
    },
  };
}

/** Run git and require one of `allowedCodes`, raising a short error otherwise. */
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
