import { assignOptionalProperties } from "./optional-properties.ts";
import { isString, type LspBoundaryValue } from "./runtime-guards.ts";
import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { logLatency } from "./latency-logger.ts";
import { recordDegradation } from "./degradation-ledger.ts";
import { logExtension } from "./extension-log.ts";
import { isFullyQualifiedWin32 } from "./path-utils.ts";
import { startSpawnUsageSampler } from "./resource-sampler.ts";

export interface SpawnResourceUsage {
  sampleCount: number;
  avgCpuPercent: number;
  peakCpuPercent: number;
  avgRssBytes: number;
  peakRssBytes: number;
}

interface SpawnUsageSampler {
  stop: () => SpawnResourceUsage | null;
}

export type SpawnFailureKind = "aborted" | "timeout" | "spawn" | "signal";

export type SpawnFailureType =
  | "tool-not-found"
  | "cwd-unresolvable"
  | "permission-denied"
  | "spawn-failed"
  | "timeout"
  | "killed";

export class SpawnFailureError extends Error {
  readonly name = "SpawnFailureError";
  readonly kind: SpawnFailureType;
  readonly cause: Error;

  constructor(kind: SpawnFailureType, message: string, cause: Error) {
    super(message, { cause });
    this.kind = kind;
    this.cause = cause;
  }
}

export function hasSpawnFailureKind(error: LspBoundaryValue, kind: SpawnFailureType): boolean {
  // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
  return error instanceof Error && "kind" in error && (error as { kind?: unknown }).kind === kind;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
  spawnFailure?: SpawnFailureError;
  failure?: SpawnFailureKind;
  outputTruncated?: boolean;
  resourceUsage?: SpawnResourceUsage;
}

function toError(error: LspBoundaryValue): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorCode(error: Error): string | undefined {
  // SAFETY: The adjacent Error and property-presence checks establish the optional Node error code representation.
  return (error as NodeJS.ErrnoException).code;
}

async function cwdIsUnresolvable(cwd: string | undefined): Promise<boolean> {
  if (cwd === undefined) return false;
  try {
    return !(await fs.promises.stat(cwd)).isDirectory();
  } catch {
    return true;
  }
}

function cwdIsUnresolvableSync(cwd: string | undefined): boolean {
  if (cwd === undefined) return false;
  try {
    return !fs.statSync(cwd).isDirectory();
  } catch {
    return true;
  }
}

function commandProbablyPresent(command: string): boolean | "ambiguous" {
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  const existsWithExt = (base: string): boolean => {
    for (const ext of exts) {
      try {
        if (fs.existsSync(base + ext)) return true;
      } catch {}
    }
    return false;
  };
  if (path.isAbsolute(command)) return existsWithExt(command);
  if (command.includes("/") || command.includes("\\")) return "ambiguous";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && existsWithExt(path.join(dir, command))) return true;
  }
  return false;
}

function classifyWithCwdFlag(
  cause: Error,
  options: { command: string; cwd?: string },
  cwdUnresolvable: boolean,
): SpawnFailureError {
  const code = errorCode(cause);
  let failure: SpawnFailureError;
  if (code === "ENOENT" && cwdUnresolvable && commandProbablyPresent(options.command) !== false) {
    failure = new SpawnFailureError(
      "cwd-unresolvable",
      `Cannot spawn ${options.command}: working directory is unresolvable (${options.cwd})`,
      cause,
    );
  } else if (code === "ENOENT") {
    failure = new SpawnFailureError(
      "tool-not-found",
      `Cannot spawn ${options.command}: tool not found (${cause.message})`,
      cause,
    );
  } else if (code === "EACCES" || code === "EPERM") {
    failure = new SpawnFailureError(
      "permission-denied",
      `Cannot spawn ${options.command}: permission denied`,
      cause,
    );
  } else {
    failure = new SpawnFailureError(
      "spawn-failed",
      `Cannot spawn ${options.command}: ${cause.message}`,
      cause,
    );
  }
  recordSpawnClassification(failure, options);
  return failure;
}

const loggedSpawnClassifications = new Set<string>();
const SPAWN_CLASSIFICATION_LOG_CAP = 200;

function recordSpawnClassification(
  failure: SpawnFailureError,
  options: { command: string; cwd?: string },
): void {
  const pair = `${failure.kind}\0${options.command}`;
  if (!loggedSpawnClassifications.has(pair)) {
    if (loggedSpawnClassifications.size >= SPAWN_CLASSIFICATION_LOG_CAP) {
      loggedSpawnClassifications.clear();
    }
    loggedSpawnClassifications.add(pair);
    logExtension({
      subsystem: "safe-spawn",
      level: "debug",
      message: "spawn failure classified",
      metadata: {
        kind: failure.kind,
        command: options.command,
        cwd: options.cwd,
      },
    });
  }
  if (failure.kind !== "tool-not-found") {
    recordDegradation({
      kind: "spawn-failure",
      subject: options.command,
      reason: `${failure.kind}${options.cwd ? ` in ${options.cwd}` : ""}`,
    });
  }
}

export async function classifySpawnFailure(
  error: LspBoundaryValue,
  options: { command: string; cwd?: string },
): Promise<SpawnFailureError> {
  const cause = toError(error);
  const needsCwdProbe = errorCode(cause) === "ENOENT";
  const cwdUnresolvable = needsCwdProbe && (await cwdIsUnresolvable(options.cwd));
  return classifyWithCwdFlag(cause, options, cwdUnresolvable);
}

function classifySpawnFailureSync(
  error: LspBoundaryValue,
  options: { command: string; cwd?: string },
): SpawnFailureError {
  const cause = toError(error);
  const needsCwdProbe = errorCode(cause) === "ENOENT";
  const cwdUnresolvable = needsCwdProbe && cwdIsUnresolvableSync(options.cwd);
  return classifyWithCwdFlag(cause, options, cwdUnresolvable);
}

export interface SafeSpawnOptions {
  timeout?: number;
  deadlineAt?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  ignoreAmbientSignal?: boolean;
  resourceLabel?: string;
  maxOutputBytes?: number;
  lifetimeCoupled?: boolean;
}

interface LifetimeCleanupState {
  pids: Set<number>;
  installed: boolean;
}

const lifetimeStateKey = Symbol.for("choco-pi-lsp.safe-spawn.lifetime-state");

// SAFETY: This module owns the symbol or process-global slot and writes only the declared state representation.
const processWithLifetimeState = process as typeof process & {
  [lifetimeStateKey]?: LifetimeCleanupState;
};
const lifetimeState =
  processWithLifetimeState[lifetimeStateKey] ??
  (processWithLifetimeState[lifetimeStateKey] = {
    pids: new Set<number>(),
    installed: false,
  });

function killPidTreeSync(pid: number): void {
  if (process.platform === "win32") {
    try {
      const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
      spawnSync(taskkill, ["/F", "/T", "/PID", String(pid)], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {}
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function installLifetimeCleanup(): void {
  if (lifetimeState.installed) return;
  lifetimeState.installed = true;
  process.once("exit", () => {
    for (const pid of lifetimeState.pids) killPidTreeSync(pid);
  });

  // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
    process.once(signal, () => {
      for (const pid of lifetimeState.pids) killPidTreeSync(pid);
      process.kill(process.pid, signal);
    });
  }
}

let ambientAbortSignal: AbortSignal | undefined;

export function setAmbientAbortSignal(signal: AbortSignal | undefined): void {
  ambientAbortSignal = signal;
}

export function getAmbientAbortSignal(): AbortSignal | undefined {
  return ambientAbortSignal;
}

function cmdEscapeArg(arg: string): string {
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export function buildWindowsShellCommand(command: string, args: string[]): string {
  return `chcp 65001 >nul 2>&1 && ${[command, ...args].map(cmdEscapeArg).join(" ")}`;
}

export interface ResolvedWindowsCommand {
  resolvedPath: string;
  ext: string;
}

const WINDOWS_DIRECT_RESOLVABLE_EXTS = new Set([".exe", ".com", ".cmd", ".bat"]);

export function mergeWindowsEnvironment(
  base: NodeJS.ProcessEnv,
  overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const entries = new Map<string, { key: string; value: string }>();
  const assign = (source: NodeJS.ProcessEnv | undefined): void => {
    if (!source) return;
    for (const [key, value] of Object.entries(source)) {
      const folded = key.toLowerCase();
      entries.delete(folded);
      if (value !== undefined) entries.set(folded, { key, value });
    }
  };
  assign(base);
  assign(overrides);

  const merged: NodeJS.ProcessEnv = {};
  for (const { key, value } of entries.values()) merged[key] = value;
  return merged;
}

function getWindowsEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  let value: string | undefined;
  for (const [key, entry] of Object.entries(env)) {
    if (key.toLowerCase() === name.toLowerCase()) value = entry;
  }
  return value;
}

function driveLetter(value: string): string | undefined {
  const match = /^([A-Za-z]):/.exec(value);
  return match?.[1]?.toUpperCase();
}

function isDriveAbsolute(value: string, drive: string): boolean {
  return (
    value.length >= 3 &&
    value[0]?.toUpperCase() === drive.toUpperCase() &&
    value[1] === ":" &&
    (value[2] === "\\" || value[2] === "/")
  );
}

function isDriveAbsoluteAnyDrive(value: string): boolean {
  const drive = driveLetter(value);
  return drive !== undefined && isDriveAbsolute(value, drive);
}

function isUncWindowsPath(value: string): boolean {
  return (
    (value[0] === "\\" || value[0] === "/") &&
    (value[1] === "\\" || value[1] === "/") &&
    value[2] !== "\\" &&
    value[2] !== "/"
  );
}

function isFullyQualifiedWindowsPath(value: string): boolean {
  return isFullyQualifiedWin32(value) && !isRootedWindowsPath(value);
}

function isRootedWindowsPath(value: string): boolean {
  return (
    (value[0] === "\\" || value[0] === "/") &&
    driveLetter(value) === undefined &&
    !isUncWindowsPath(value)
  );
}

function resolveRootedWindowsPath(value: string, driveSource: string): string {
  const drive = driveLetter(driveSource);
  if (drive === undefined) return path.win32.normalize(value);
  return path.win32.normalize(path.win32.resolve(`${drive}:\\`, value));
}

function getValidatedPerDriveCwd(env: NodeJS.ProcessEnv, drive: string): string | undefined {
  const value = getWindowsEnvironmentValue(env, `=${drive}:`);
  if (value === undefined || !isDriveAbsolute(value, drive)) return undefined;
  return path.win32.normalize(value);
}

function resolveEffectiveWindowsCwd(
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (cwd === undefined) {
    return path.win32.normalize(process.cwd());
  }
  const requestedDrive = driveLetter(cwd);
  if (requestedDrive !== undefined && !isDriveAbsoluteAnyDrive(cwd)) {
    const base = getValidatedPerDriveCwd(env, requestedDrive);
    return base === undefined ? undefined : path.win32.normalize(path.win32.resolve(base, cwd));
  }
  if (isFullyQualifiedWindowsPath(cwd)) return path.win32.normalize(cwd);
  if (isRootedWindowsPath(cwd)) {
    return resolveRootedWindowsPath(cwd, process.cwd());
  }
  return path.win32.normalize(path.win32.resolve(process.cwd(), cwd));
}

function resolveDriveRelativeWindowsPath(
  value: string,
  effectiveCwd: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const drive = driveLetter(value);
  if (drive === undefined) return undefined;
  const cwdDrive = effectiveCwd === undefined ? undefined : driveLetter(effectiveCwd);
  const base =
    cwdDrive?.toUpperCase() === drive ? effectiveCwd : getValidatedPerDriveCwd(env, drive);
  if (base === undefined) return undefined;
  return path.win32.normalize(path.win32.resolve(base, value));
}

function resolveWindowsPathEntry(
  entry: string,
  effectiveCwd: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (driveLetter(entry) !== undefined && !isDriveAbsoluteAnyDrive(entry)) {
    return resolveDriveRelativeWindowsPath(entry, effectiveCwd, env);
  }
  if (isFullyQualifiedWindowsPath(entry)) return path.win32.normalize(entry);
  if (isRootedWindowsPath(entry)) {
    return effectiveCwd === undefined ? undefined : resolveRootedWindowsPath(entry, effectiveCwd);
  }
  if (effectiveCwd === undefined) return undefined;
  return path.win32.normalize(path.win32.resolve(effectiveCwd, entry));
}

const WINDOWS_COMMAND_CACHE_MAX_ENTRIES = 256;
const WINDOWS_COMMAND_NEGATIVE_CACHE_TTL_MS = 1000;
interface WindowsCommandCacheEntry {
  resolved: ResolvedWindowsCommand | null;
  checkedAt: number;
}
const windowsCommandCache = new Map<string, WindowsCommandCacheEntry>();

export function resetSafeSpawnWindowsCommandCache(): void {
  windowsCommandCache.clear();
  loggedSpawnClassifications.clear();
}

function cacheWindowsCommandResult(key: string, resolved: ResolvedWindowsCommand | null): void {
  if (windowsCommandCache.size >= WINDOWS_COMMAND_CACHE_MAX_ENTRIES) {
    const oldest = windowsCommandCache.keys().next().value;
    if (oldest !== undefined) windowsCommandCache.delete(oldest);
  }
  windowsCommandCache.set(key, { resolved, checkedAt: Date.now() });
}

function getPathExts(env: NodeJS.ProcessEnv): string[] {
  const raw = getWindowsEnvironmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
  return raw
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
}

function statIsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveWindowsCommandUncached(
  command: string,
  effectiveCwd: string | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedWindowsCommand | null {
  const pathExts = getPathExts(env);
  const existingExt = path.win32.extname(command).toLowerCase();
  const hasExplicitExt = existingExt.length > 0;
  const isKnownExecutableExt = (ext: string): boolean =>
    WINDOWS_DIRECT_RESOLVABLE_EXTS.has(ext) || pathExts.includes(ext);

  const tryBase = (base: string): ResolvedWindowsCommand | null => {
    if (hasExplicitExt && isKnownExecutableExt(existingExt) && statIsFile(base)) {
      return { resolvedPath: base, ext: existingExt };
    }
    if (!hasExplicitExt || !pathExts.includes(existingExt)) {
      for (const ext of pathExts) {
        const candidate = base + ext;
        if (statIsFile(candidate)) return { resolvedPath: candidate, ext };
      }
    }
    return null;
  };

  const hasPathSep = /[\\/]/.test(command);
  const hasDrivePrefix = driveLetter(command) !== undefined;
  if (hasPathSep || hasDrivePrefix || isFullyQualifiedWindowsPath(command)) {
    let base: string | undefined;
    if (isFullyQualifiedWindowsPath(command)) {
      base = path.win32.normalize(command);
    } else if (hasDrivePrefix) {
      base = resolveDriveRelativeWindowsPath(command, effectiveCwd, env);
    } else if (isRootedWindowsPath(command)) {
      base =
        effectiveCwd === undefined ? undefined : resolveRootedWindowsPath(command, effectiveCwd);
    } else if (effectiveCwd !== undefined) {
      base = path.win32.normalize(path.win32.resolve(effectiveCwd, command));
    }
    return base === undefined ? null : tryBase(base);
  }

  const pathValue = getWindowsEnvironmentValue(env, "PATH") ?? "";
  const pathDirs = pathValue.split(path.win32.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const resolvedDir = resolveWindowsPathEntry(dir, effectiveCwd, env);
    if (resolvedDir === undefined) continue;
    const found = tryBase(path.win32.join(resolvedDir, command));
    if (found) return found;
  }
  return null;
}

export function resolveWindowsCommandForEnvironment(
  command: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedWindowsCommand | null {
  const effectiveCwd = resolveEffectiveWindowsCwd(cwd, env);
  const pathValue = getWindowsEnvironmentValue(env, "PATH");
  const pathExtValue = getWindowsEnvironmentValue(env, "PATHEXT");
  const perDriveCwds = Object.entries(env)
    .flatMap(([key, value]) =>
      /^=[A-Za-z]:$/.test(key) ? ([[key.toLowerCase(), value] as const] as const) : [],
    )
    .sort(([left], [right]) => left.localeCompare(right));
  const cacheKey = JSON.stringify([
    "win32",
    command,
    pathValue === undefined ? ["absent"] : ["present", pathValue],
    pathExtValue === undefined ? ["absent"] : ["present", pathExtValue],
    effectiveCwd === undefined ? ["unresolved"] : ["resolved", effectiveCwd],
    perDriveCwds,
  ]);
  const cached = windowsCommandCache.get(cacheKey);
  if (cached) {
    if (cached.resolved && statIsFile(cached.resolved.resolvedPath)) {
      return cached.resolved;
    }
    if (
      !cached.resolved &&
      Date.now() - cached.checkedAt <= WINDOWS_COMMAND_NEGATIVE_CACHE_TTL_MS
    ) {
      return null;
    }
    windowsCommandCache.delete(cacheKey);
  }
  const resolved = resolveWindowsCommandUncached(command, effectiveCwd, env);
  cacheWindowsCommandResult(cacheKey, resolved);
  return resolved;
}

function resolveWindowsCommand(
  command: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedWindowsCommand | null {
  return resolveWindowsCommandForEnvironment(command, cwd, env);
}

function getSpawnEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return process.platform === "win32"
    ? mergeWindowsEnvironment(process.env, overrides)
    : { ...process.env, ...overrides };
}

const CMD_UNSAFE_CHARS = /["%!\r\n]/;

function findCmdUnsafeValue(command: string, args: string[]): string | undefined {
  if (CMD_UNSAFE_CHARS.test(command)) return command;
  return args.find((arg) => CMD_UNSAFE_CHARS.test(arg));
}

function synthesizeEnoentError(command: string): NodeJS.ErrnoException {
  // SAFETY: The adjacent Error and property-presence checks establish the optional Node error code representation.
  const err = new Error(`spawn ${command} ENOENT`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  err.syscall = "spawn";
  err.path = command;
  return err;
}

let utf8ConsoleCodePageApplied = false;

function ensureUtf8ConsoleCodePageOnce(): void {
  if (utf8ConsoleCodePageApplied) return;
  utf8ConsoleCodePageApplied = true;
  try {
    const cmdExe = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
    spawnSync(cmdExe, ["/d", "/s", "/c", "chcp 65001 >nul 2>&1"], {
      shell: false,
      windowsHide: true,
    });
  } catch {}
}

export function resetUtf8ConsoleCodePageStateForTests(): void {
  utf8ConsoleCodePageApplied = false;
}

const EXIT_PIPE_IDLE_GRACE_MS = 100;
const EXIT_PIPE_IDLE_MAX_WAIT_MS = 2000;

export async function safeSpawnAsync(
  command: string,
  args: string[],
  options?: SafeSpawnOptions,
): Promise<SpawnResult> {
  const configuredTimeout =
    options?.timeout !== undefined && Number.isFinite(options.timeout) && options.timeout >= 0
      ? options.timeout
      : 30000;
  const deadlineRemaining =
    options?.deadlineAt !== undefined && Number.isFinite(options.deadlineAt)
      ? options.deadlineAt - Date.now()
      : Number.POSITIVE_INFINITY;
  const timeout = Math.max(0, Math.min(configuredTimeout, deadlineRemaining));
  const abortSignal =
    options?.signal ?? (options?.ignoreAmbientSignal ? undefined : ambientAbortSignal);

  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      const cause = new Error("Spawn aborted before start");
      resolve({
        stdout: "",
        stderr: "",
        status: null,
        error: cause,
        failure: "aborted",
        spawnFailure: new SpawnFailureError("killed", cause.message, cause),
      });
      return;
    }
    if (timeout <= 0) {
      const cause = new Error(`Process timed out after ${timeout}ms`);
      resolve({
        stdout: "",
        stderr: "",
        status: null,
        error: cause,
        failure: "timeout",
        spawnFailure: new SpawnFailureError("timeout", cause.message, cause),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let killed = false;
    let outputTruncated = false;
    let resolved = false;
    let pendingSpawnError: Error | undefined;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let rearmIdleGrace: (() => void) | undefined;
    const maxOutputBytes =
      options?.maxOutputBytes !== undefined &&
      Number.isFinite(options.maxOutputBytes) &&
      options.maxOutputBytes > 0
        ? Math.floor(options.maxOutputBytes)
        : undefined;
    const appendOutput = (current: string, chunk: string | Buffer): string => {
      const text = isString(chunk) ? chunk : chunk.toString();
      if (maxOutputBytes === undefined) return current + text;
      const used = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
      const remaining = maxOutputBytes - used;
      if (remaining <= 0) {
        outputTruncated = true;
        return current;
      }
      const bytes = Buffer.byteLength(text);
      if (bytes <= remaining) return current + text;
      outputTruncated = true;
      return current + Buffer.from(text).subarray(0, remaining).toString();
    };

    const isWindows = process.platform === "win32";
    const spawnEnv = getSpawnEnvironment(options?.env);
    const spawnCwd = isWindows
      ? (resolveEffectiveWindowsCwd(options?.cwd, spawnEnv) ?? options?.cwd)
      : options?.cwd;
    let spawnCmd = command;
    let spawnArgs = args;
    let windowsVerbatimArguments = false;
    let resolutionError: Error | undefined;

    if (isWindows) {
      const resolved = resolveWindowsCommand(command, options?.cwd, spawnEnv);
      if (!resolved) {
        resolutionError = synthesizeEnoentError(command);
      } else if (resolved.ext === ".cmd" || resolved.ext === ".bat") {
        const unsafeValue = findCmdUnsafeValue(resolved.resolvedPath, args);
        if (unsafeValue !== undefined) {
          resolutionError = new Error(
            `Refusing to spawn "${resolved.resolvedPath}" via cmd.exe: ` +
              `${JSON.stringify(unsafeValue)} contains a character ("` +
              `, %, !, or CR/LF) that cannot be safely escaped on a ` +
              `cmd.exe /c command line (CWE-78, #817). Rename/quote the ` +
              "value or invoke the tool without going through cmd.exe.",
          );
        } else {
          spawnCmd = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
          spawnArgs = ["/d", "/s", "/c", buildWindowsShellCommand(resolved.resolvedPath, args)];
          windowsVerbatimArguments = true;
        }
      } else {
        ensureUtf8ConsoleCodePageOnce();
        spawnCmd = resolved.resolvedPath;
        spawnArgs = args;
      }
    }

    if (resolutionError) {
      void classifySpawnFailure(resolutionError, {
        command,
        cwd: options?.cwd,
      }).then((spawnFailure) =>
        resolve({
          stdout: "",
          stderr: "",
          status: null,
          error: resolutionError,
          failure: "spawn",
          spawnFailure,
        }),
      );
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(spawnCmd, spawnArgs, {
        cwd: spawnCwd,
        env: spawnEnv,
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments,
      });
    } catch (err) {
      const cause = toError(err);
      void classifySpawnFailure(cause, { command, cwd: options?.cwd }).then((spawnFailure) =>
        resolve({
          stdout: "",
          stderr: "",
          status: null,
          error: cause,
          failure: "spawn",
          spawnFailure,
        }),
      );
      return;
    }
    if (options?.lifetimeCoupled && child.pid) {
      installLifetimeCleanup();
      lifetimeState.pids.add(child.pid);
    }

    let usageSampler: SpawnUsageSampler;
    try {
      usageSampler = startSpawnUsageSampler(child.pid);
    } catch {
      usageSampler = { stop: () => null };
    }
    const resourceLabel = options?.resourceLabel ?? command;

    const killTree = async (): Promise<void> => {
      if (isWindows && child.pid && child.pid > 0) {
        const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
        try {
          await new Promise<void>((done) => {
            const killer = spawn(taskkill, ["/F", "/T", "/PID", String(child.pid)], {
              shell: false,
              windowsHide: true,
              stdio: "ignore",
            });
            killer.once("close", () => done());
            killer.once("error", () => {
              child.kill("SIGKILL");
              done();
            });
          });
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGTERM");
        escalationTimer = setTimeout(() => {
          if (!closed) child.kill("SIGKILL");
        }, 1000);
      }
    };

    const onAbort = () => {
      aborted = true;
      if (!killed && !child.killed) {
        killed = true;
        void killTree();
      }
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    let killPromise: Promise<void> | undefined;
    const stopForOutputLimit = (): void => {
      if (outputTruncated && !killed && !child.killed) {
        killed = true;
        killPromise = killTree();
      }
    };

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (data) => {
      stdout = appendOutput(stdout, data);
      stopForOutputLimit();
      rearmIdleGrace?.();
    });
    child.stderr?.on("data", (data) => {
      stderr = appendOutput(stderr, data);
      stopForOutputLimit();
      rearmIdleGrace?.();
    });

    let closeSeen = false;
    child.on("close", () => {
      closeSeen = true;
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      if (!killed && !child.killed) {
        killed = true;
        killPromise = killTree();
      }
    }, timeout);

    const finishResourceUsage = (): SpawnResourceUsage | undefined => {
      const summary = usageSampler.stop();
      if (!summary) return undefined;
      try {
        logLatency({
          type: "phase",
          phase: "spawn_resource_usage",
          filePath: "",
          durationMs: 0,
          metadata: {
            command: resourceLabel,
            ...summary,
          },
        });
      } catch {}
      return summary;
    };

    const waitForPipeIdle = (): Promise<void> => {
      if (!child.stdout && !child.stderr) return Promise.resolve();
      if (closeSeen) return Promise.resolve();
      return new Promise((finishIdleWait) => {
        let settled = false;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const capTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
          finish();
        }, EXIT_PIPE_IDLE_MAX_WAIT_MS);
        const finish = (): void => {
          if (settled) return;
          settled = true;
          rearmIdleGrace = undefined;
          if (graceTimer) clearTimeout(graceTimer);
          clearTimeout(capTimer);
          child.removeListener?.("close", finish);
          finishIdleWait();
        };
        child.on("close", finish);
        rearmIdleGrace = (): void => {
          if (graceTimer) clearTimeout(graceTimer);
          graceTimer = setTimeout(finish, EXIT_PIPE_IDLE_GRACE_MS);
        };
        rearmIdleGrace();
      });
    };

    let settled = false;
    const onChildSettle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled || resolved) return;
      settled = true;
      closed = true;
      clearTimeout(timeoutId);
      abortSignal?.removeEventListener("abort", onAbort);
      if (child.pid) lifetimeState.pids.delete(child.pid);
      void finalize(code, signal);
    };

    const finalize = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      await killPromise;
      if (resolved) return;
      if (escalationTimer) clearTimeout(escalationTimer);
      resolved = true;
      await waitForPipeIdle();
      const resourceUsage = finishResourceUsage();

      const outputInfo = outputTruncated ? { outputTruncated: true } : {};
      if (timedOut) {
        const cause = new Error(
          `Process timed out after ${timeout}ms (killed with ${signal || "SIGTERM"})`,
        );
        resolve({
          stdout,
          stderr,
          status: null,
          error: cause,
          failure: "timeout",
          spawnFailure: new SpawnFailureError("timeout", cause.message, cause),
          ...outputInfo,
          resourceUsage,
        });
      } else if (aborted) {
        const cause = new Error("Spawn aborted");
        resolve({
          stdout,
          stderr,
          status: null,
          error: cause,
          failure: "aborted",
          spawnFailure: new SpawnFailureError("killed", cause.message, cause),
          ...outputInfo,
          resourceUsage,
        });
      } else if (signal) {
        const cause = new Error(`Process killed by signal: ${signal}`);
        resolve({
          stdout,
          stderr,
          status: null,
          error: cause,
          failure: "signal",
          spawnFailure: new SpawnFailureError("killed", cause.message, cause),
          ...outputInfo,
          resourceUsage,
        });
      } else if (code === null || code < 0) {
        const cause = pendingSpawnError ?? synthesizeEnoentError(command);
        const spawnFailure = await classifySpawnFailure(cause, {
          command,
          cwd: options?.cwd,
        });
        resolve({
          stdout,
          stderr,
          status: code,
          error: cause,
          failure: "spawn",
          spawnFailure,
          ...outputInfo,
          resourceUsage,
        });
      } else {
        resolve({ stdout, stderr, status: code, ...outputInfo, resourceUsage });
      }
    };

    child.on("exit", onChildSettle);
    child.on("close", onChildSettle);

    child.on("error", (err) => {
      pendingSpawnError = err;
      if (resolved) return;
      resolved = true;
      closed = true;
      clearTimeout(timeoutId);
      abortSignal?.removeEventListener("abort", onAbort);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (child.pid) lifetimeState.pids.delete(child.pid);
      const resourceUsage = finishResourceUsage();
      let failure: SpawnFailureKind = "spawn";
      if (aborted) failure = "aborted";
      else if (timedOut) failure = "timeout";
      const controlFailure = aborted
        ? new SpawnFailureError("killed", err.message, err)
        : timedOut
          ? new SpawnFailureError("timeout", err.message, err)
          : undefined;
      const finish = (spawnFailure: SpawnFailureError): void =>
        resolve(
          Object.assign(
            assignOptionalProperties(
              { stdout, stderr, status: null, error: err, failure, spawnFailure },
              outputTruncated,
              () => ({ outputTruncated: true }),
            ),
            { resourceUsage },
          ),
        );
      if (controlFailure) finish(controlFailure);
      else {
        void classifySpawnFailure(err, { command, cwd: options?.cwd }).then(finish);
      }
    });
  });
}

export async function safeSpawnBatch(
  commands: Array<{
    command: string;
    args: string[];
    options?: SafeSpawnOptions;
  }>,
  concurrency = 3,
): Promise<SpawnResult[]> {
  const results: SpawnResult[] = [];

  for (let i = 0; i < commands.length; i += concurrency) {
    const batch = commands.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(({ command, args, options }) => safeSpawnAsync(command, args, options)),
    );
    results.push(...batchResults);
  }

  return results;
}

export async function isCommandAvailableAsync(command: string): Promise<boolean> {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = await safeSpawnAsync(finder, [command], { timeout: 5000 });
  return result.status === 0 && !result.error;
}

export async function findCommandAsync(command: string): Promise<string | null> {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = await safeSpawnAsync(finder, [command], { timeout: 5000 });

  if (result.status !== 0 || result.error) return null;

  return result.stdout.trim().split("\n")[0] || null;
}

export function safeSpawn(
  command: string,
  args: string[],
  options?: SafeSpawnOptions,
): SpawnResult {
  const spawnEnv = getSpawnEnvironment(options?.env);
  if (process.platform === "win32") {
    const spawnCwd = resolveEffectiveWindowsCwd(options?.cwd, spawnEnv) ?? options?.cwd;
    const resolved = resolveWindowsCommand(command, options?.cwd, spawnEnv);
    if (!resolved) {
      const error = synthesizeEnoentError(command);
      return {
        stdout: "",
        stderr: "",
        status: null,
        error,
        failure: "spawn",
        spawnFailure: classifySpawnFailureSync(error, {
          command,
          cwd: options?.cwd,
        }),
      };
    }

    let spawnCmd: string;
    let spawnArgs: string[];
    let windowsVerbatimArguments = false;

    if (resolved.ext === ".cmd" || resolved.ext === ".bat") {
      const unsafeValue = findCmdUnsafeValue(resolved.resolvedPath, args);
      if (unsafeValue !== undefined) {
        const error = new Error(
          `Refusing to spawn "${resolved.resolvedPath}" via cmd.exe: ` +
            `${JSON.stringify(unsafeValue)} contains a character ("` +
            `, %, !, or CR/LF) that cannot be safely escaped on a ` +
            `cmd.exe /c command line (CWE-78, #817). Rename/quote the ` +
            "value or invoke the tool without going through cmd.exe.",
        );
        return {
          stdout: "",
          stderr: "",
          status: null,
          error,
          failure: "spawn",
          spawnFailure: classifySpawnFailureSync(error, {
            command,
            cwd: options?.cwd,
          }),
        };
      }
      spawnCmd = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
      spawnArgs = ["/d", "/s", "/c", buildWindowsShellCommand(resolved.resolvedPath, args)];
      windowsVerbatimArguments = true;
    } else {
      ensureUtf8ConsoleCodePageOnce();
      spawnCmd = resolved.resolvedPath;
      spawnArgs = args;
    }

    const result = spawnSync(spawnCmd, spawnArgs, {
      // SAFETY: The caller-provided options already satisfy the public spawn-options input type; this copy only adds normalized overrides.
      ...(options as SpawnOptions),
      cwd: spawnCwd,
      env: spawnEnv,
      encoding: "utf-8",
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments,
    });

    const spawnFailure = result.error
      ? classifySpawnFailureSync(result.error, { command, cwd: options?.cwd })
      : undefined;
    return assignOptionalProperties(
      {
        stdout: result.stdout?.toString() || "",
        stderr: result.stderr?.toString() || "",
        status: result.status,
        error: result.error,
      },
      spawnFailure,
      () => ({ failure: "spawn" as const, spawnFailure }),
    );
  }

  const result = spawnSync(command, args, {
    // SAFETY: The caller-provided options already satisfy the public spawn-options input type; this copy only adds normalized overrides.
    ...(options as SpawnOptions),
    env: spawnEnv,
    encoding: "utf-8",
    shell: false,
    windowsHide: true,
  });

  const spawnFailure = result.error
    ? classifySpawnFailureSync(result.error, { command, cwd: options?.cwd })
    : undefined;
  return assignOptionalProperties(
    {
      stdout: result.stdout?.toString() || "",
      stderr: result.stderr?.toString() || "",
      status: result.status,
      error: result.error,
    },
    spawnFailure,
    () => ({ failure: "spawn" as const, spawnFailure }),
  );
}

export function isCommandAvailable(command: string): boolean {
  const result = safeSpawn(process.platform === "win32" ? "where" : "which", [command], {
    timeout: 5000,
  });
  return result.status === 0;
}

export function findCommand(command: string): string | null {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = safeSpawn(finder, [command], { timeout: 5000 });

  if (result.status !== 0) return null;

  return result.stdout.trim().split("\n")[0] || null;
}
