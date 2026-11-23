import {
  type ChildProcess,
  execFileSync,
  spawn as nodeSpawn,
  type SpawnOptions,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTestMode } from "../env-utils.ts";
import { getGlobalPiLensDir } from "../file-utils.ts";
import { isFullyQualified } from "../path-utils.ts";
import { findGlobalBinary } from "../package-manager.ts";
import { redactSecrets } from "../redact/secrets.ts";
import { classifySpawnFailure, SpawnFailureError } from "../safe-spawn.ts";
import { getRubyVersionDirNamesAsync } from "./ruby-drive-dirs.ts";
import { nodeBinDirectory, nodeExecutable } from "@choco-pi/shared/node-runtime";

export interface LSPProcess {
  process: ChildProcess;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  pid: number;
  command: string;
  args: string[];
}

const isWindows = process.platform === "win32";

function computeNeedsShell(resolvedCommand: string): boolean {
  return (
    isWindows &&
    (resolvedCommand.includes(" ") ||
      /\.(cmd|bat)$/i.test(resolvedCommand) ||
      !/\.(exe|cmd|bat)$/i.test(resolvedCommand))
  );
}

const DEFAULT_STARTUP_FAILURE_WINDOW_MS = 50;
const WINDOWS_NAV_STARTUP_FAILURE_WINDOW_MS = 500;
const SESSIONSTART_LOG_DIR = getGlobalPiLensDir();
const SESSIONSTART_LOG = path.join(SESSIONSTART_LOG_DIR, "sessionstart.log");
const CHOCO_PI_LSP_BIN_DIR = path.join(getGlobalPiLensDir(), "bin");
const CHOCO_PI_LSP_TOOLS_BIN_DIR = path.join(getGlobalPiLensDir(), "tools", "node_modules", ".bin");

function logSessionStart(msg: string): void {
  if (isTestMode()) {
    return;
  }
  const line = redactSecrets(`[${new Date().toISOString()}] ${msg}\n`);
  try {
    fs.mkdirSync(SESSIONSTART_LOG_DIR, { recursive: true });
    fs.appendFileSync(SESSIONSTART_LOG, line);
  } catch {}
}

function compactLogValue(value: string, max = 280): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function delimiterForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function splitPathEntries(value: string | undefined, delimiter: string): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizePathEntry(entry: string, platform: NodeJS.Platform): string {
  const normalized = path.normalize(entry);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function combinePathValuesForPlatform(
  values: Array<string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string {
  const unique: string[] = [];
  const seen = new Set<string>();
  const delimiter = delimiterForPlatform(platform);

  for (const value of values) {
    for (const entry of splitPathEntries(value, delimiter)) {
      const key = normalizePathEntry(entry, platform);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(entry);
    }
  }

  return unique.join(delimiter);
}

function resolvePathValue(env: NodeJS.ProcessEnv): string {
  return combinePathValuesForPlatform([env.PATH, env.Path, env.path]);
}

function readWindowsRegistryPath(): string {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')",
      ],
      { timeout: 3000, encoding: "utf8" },
    );
    return out.trim();
  } catch {
    return "";
  }
}

let _liveWindowsPath: string | null = null;
function getLiveWindowsPath(): string {
  if (_liveWindowsPath === null) {
    _liveWindowsPath = readWindowsRegistryPath();
  }
  return _liveWindowsPath;
}

async function buildAugmentedPath(basePath?: string): Promise<string> {
  const candidates: string[] = [];
  const nodeDir = nodeBinDirectory();
  if (nodeDir) {
    candidates.push(nodeDir);
  }

  if (isWindows) {
    const home = os.homedir();
    const driveRoot = path.parse(home).root;
    candidates.push(path.join(home, ".cargo", "bin"));
    candidates.push(path.join(home, "go", "bin"));
    candidates.push(path.join(home, ".dotnet", "tools"));
    candidates.push(CHOCO_PI_LSP_BIN_DIR);
    candidates.push(CHOCO_PI_LSP_TOOLS_BIN_DIR);
    candidates.push(path.join(driveRoot, "Program Files", "Go", "bin"));
    candidates.push(path.join(driveRoot, "Go", "bin"));
    for (const entry of await getRubyVersionDirNamesAsync(driveRoot)) {
      candidates.push(path.join(driveRoot, entry, "bin"));
    }
  }

  const effectiveBase = isWindows
    ? combinePathValuesForPlatform([basePath, getLiveWindowsPath()])
    : basePath;

  const existing = new Set<string>();
  for (const entry of splitPathEntries(effectiveBase, path.delimiter)) {
    if (!entry) continue;
    existing.add(normalizePathEntry(entry, process.platform));
  }

  const toAppend: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const normalized = normalizePathEntry(candidate, process.platform);
    if (existing.has(normalized)) continue;
    toAppend.push(candidate);
    existing.add(normalized);
  }

  if (toAppend.length === 0) return basePath ?? "";
  if (!basePath) return toAppend.join(path.delimiter);
  return `${basePath}${path.delimiter}${toAppend.join(path.delimiter)}`;
}

export function isCmdShimValid(cmdPath: string): boolean {
  try {
    const content = fs.readFileSync(cmdPath, "utf-8");
    const match = content.match(/"%~dp0[/\\]\.\.[/\\]((?:[\w./@-]|\\)+\.(?:mjs|cjs|js))"/i);
    if (!match) return true;
    const relPath = match[1].replace(/[/\\]/g, path.sep);
    const target = path.resolve(path.dirname(cmdPath), "..", relPath);
    return fs.existsSync(target);
  } catch {
    return true;
  }
}

function bypassPs1OnWindows(
  ps1Path: string,
  args: string[],
): { command: string; args: string[]; needsShell: boolean } | undefined {
  const cmdPath = `${ps1Path.slice(0, -4)}.cmd`;
  if (fs.existsSync(cmdPath)) {
    return { command: cmdPath, args, needsShell: true };
  }

  try {
    const content = fs.readFileSync(ps1Path, "utf-8");
    const match = content.match(/"\$basedir[/\\]\.\.[/\\]((?:[\w./@-]|\\)+\.(?:mjs|cjs|js))"/i);
    if (match) {
      const relPath = match[1].replace(/[/\\]/g, path.sep);
      const jsPath = path.resolve(path.dirname(ps1Path), "..", relPath);
      if (fs.existsSync(jsPath)) {
        return {
          command: nodeExecutable(),
          args: [jsPath, ...args],
          needsShell: false,
        };
      }
    }
  } catch {}

  return undefined;
}

function findBinaryOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const result = execFileSync(isWindows ? "where" : "which", [command], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const candidate of result) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {}
  return undefined;
}

function trySpawn(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  needsShell: boolean,
): ChildProcess {
  let proc: ChildProcess;

  if (needsShell) {
    const escapeCmdArg = (s: string): string => {
      const escaped = s.replace(/([&|<>^()!])/g, "^$1");
      return /[\s"]/.test(escaped) ? `"${escaped.replace(/"/g, '""')}"` : escaped;
    };
    const shellCommand = `"${command}" ${args.map(escapeCmdArg).join(" ")}`;
    proc = nodeSpawn(shellCommand, [], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: !isWindows,
      windowsHide: true,
      shell: true,
    });
  } else {
    proc = nodeSpawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: !isWindows,
      windowsHide: isWindows,
    });
  }

  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    throw new Error(`Failed to spawn LSP server: ${command}`);
  }

  if (proc.exitCode !== null || proc.killed) {
    throw new Error(
      `LSP server ${command} exited immediately (code: ${proc.exitCode}). ` +
        `The binary may be missing or corrupted.`,
    );
  }

  return proc;
}

function unrefLspProcessHandles(proc: ChildProcess): void {
  try {
    proc.unref();
  } catch {}
  for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
    try {
      if (stream && "unref" in stream) {
        // SAFETY: The property check verifies this concrete child-process pipe exposes unref.
        (stream as { unref: () => void }).unref();
      }
    } catch {}
  }
}

function _attachErrorHandler(
  proc: ChildProcess,
  context: string,
  logContext?: {
    command: string;
    args: string[];
    cwd: string;
    pid?: number;
  },
  rejectOnImmediateError?: (err: Error) => void,
): void {
  let stderrPreview = "";
  let closeLogged = false;
  const onStderr = (chunk: Buffer | string): void => {
    if (stderrPreview.length >= 4000) return;
    stderrPreview += chunk.toString();
  };
  proc.stderr?.on("data", onStderr);

  proc.on("error", (err) => {
    if (logContext) {
      logSessionStart(
        "lsp process " +
          context +
          ": spawn-error command=" +
          logContext.command +
          " args=" +
          JSON.stringify(logContext.args) +
          " cwd=" +
          logContext.cwd +
          " pid=" +
          (logContext.pid ?? 0) +
          " error=" +
          err.message +
          (stderrPreview ? " stderr=" + compactLogValue(stderrPreview) : ""),
      );
    }

    if (rejectOnImmediateError && logContext) {
      void classifySpawnFailure(err, {
        command: logContext.command,
        cwd: logContext.cwd,
      }).then(rejectOnImmediateError);
    }
  });

  proc.on("close", (code, signal) => {
    if (closeLogged) return;
    closeLogged = true;
    proc.stderr?.off("data", onStderr);
    if (code !== 0 && code !== null) {
      if (logContext) {
        logSessionStart(
          "lsp process " +
            context +
            ": closed code=" +
            code +
            (signal ? " signal=" + signal : "") +
            " command=" +
            logContext.command +
            " args=" +
            JSON.stringify(logContext.args) +
            " cwd=" +
            logContext.cwd +
            " pid=" +
            (logContext.pid ?? 0) +
            (stderrPreview ? " stderr=" + compactLogValue(stderrPreview) : ""),
        );
      }
    } else if (signal && logContext) {
      logSessionStart(
        "lsp process " +
          context +
          ": closed signal=" +
          signal +
          " command=" +
          logContext.command +
          " args=" +
          JSON.stringify(logContext.args) +
          " cwd=" +
          logContext.cwd +
          " pid=" +
          (logContext.pid ?? 0) +
          (stderrPreview ? " stderr=" + compactLogValue(stderrPreview) : ""),
      );
    }
  });
}

export async function launchLSP(
  command: string,
  args: string[] = [],
  options: SpawnOptions & {
    startupFailureWindowMs?: number;
  } = {},
): Promise<LSPProcess> {
  const cwd = String(options.cwd ?? process.cwd());
  const mergedEnv = { ...process.env, ...options.env };
  const augmentedPath = await buildAugmentedPath(resolvePathValue(mergedEnv));
  const env: NodeJS.ProcessEnv = {
    ...mergedEnv,
    PATH: augmentedPath,
  };
  if (isWindows) env.Path = augmentedPath;

  const isRelativePath =
    !isFullyQualified(command) && (command.includes(path.sep) || command.includes("/"));
  const explicitCommand = isRelativePath ? path.resolve(cwd, command) : command;
  const resolvedCommand =
    !isFullyQualified(command) && !command.includes(path.sep) && !command.includes("/")
      ? (findBinaryOnPath(command, env) ?? explicitCommand)
      : explicitCommand;

  let needsShell = computeNeedsShell(resolvedCommand);

  let spawnCommand = resolvedCommand;

  if (!isFullyQualified(command) && !command.includes(path.sep) && !command.includes("/")) {
    const globalBinPath = await findGlobalBinary(command);
    if (globalBinPath) {
      spawnCommand = globalBinPath;
      needsShell = computeNeedsShell(spawnCommand);
    }
  }

  if (isWindows && /\.(cmd|bat)$/i.test(spawnCommand) && !isCmdShimValid(spawnCommand)) {
    logSessionStart(`lsp cmd-shim-invalid: ${spawnCommand} target missing — skipping candidate`);
    const cause = Object.assign(new Error(`LSP .cmd shim target not found: ${spawnCommand}`), {
      code: "ENOENT",
    });
    throw await classifySpawnFailure(cause, { command, cwd });
  }

  if (isWindows && /\.ps1$/i.test(spawnCommand)) {
    const bypass = bypassPs1OnWindows(spawnCommand, args);
    if (bypass) {
      logSessionStart(
        `lsp ps1-bypass: ${spawnCommand} → ${bypass.command} shell=${bypass.needsShell}`,
      );
      spawnCommand = bypass.command;
      args = bypass.args;
      needsShell = bypass.needsShell;
    } else {
      logSessionStart(
        `lsp ps1-bypass: no .cmd or JS entry found for ${spawnCommand}, spawn may hang`,
      );
    }
  }

  let proc: ChildProcess;

  try {
    proc = trySpawn(spawnCommand, args, cwd, env, needsShell);
  } catch (err) {
    if (!isFullyQualified(command) && !command.includes(path.sep) && !command.includes("/")) {
      const globalBinPath = await findGlobalBinary(command);
      if (globalBinPath && globalBinPath !== spawnCommand) {
        const needsShellGlobal = computeNeedsShell(globalBinPath);
        proc = trySpawn(globalBinPath, args, cwd, env, needsShellGlobal);
      } else {
        throw await classifySpawnFailure(err, { command, cwd });
      }
    } else {
      throw await classifySpawnFailure(err, { command, cwd });
    }
  }

  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    throw new Error(`Failed to spawn LSP server: ${command}`);
  }

  if (proc.exitCode !== null || proc.killed) {
    throw new Error(
      `LSP server ${command} exited immediately (code: ${proc.exitCode}). ` +
        `The binary may be missing or corrupted.`,
    );
  }

  logSessionStart(
    `lsp launch: command=${command} resolved=${spawnCommand} args=${JSON.stringify(args)} cwd=${cwd} shell=${needsShell ? "true" : "false"} pid=${proc.pid ?? 0}`,
  );

  const formatStartupStderr = (stderr: string): string => {
    const normalized = compactLogValue(stderr);
    if (!normalized) return "";
    return ` stderr=${normalized}`;
  };

  let startupStderr = "";
  const onStartupStderr = (chunk: Buffer | string): void => {
    if (startupStderr.length >= 4000) return;
    startupStderr += chunk.toString();
  };
  proc.stderr?.on("data", onStartupStderr);

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      proc.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          void classifySpawnFailure(err, { command, cwd }).then((failure) => {
            const detail = formatStartupStderr(startupStderr);
            reject(
              detail
                ? new SpawnFailureError(failure.kind, `${failure.message}${detail}`, failure.cause)
                : failure,
            );
          });
        }
      });

      proc.on("exit", (code: number | null) => {
        if (!settled && code !== null) {
          settled = true;
          const isWindowsCmd = isWindows && command.endsWith(".cmd");
          const errorMsg =
            isWindowsCmd && code === 1
              ? `npm .cmd shim failed (underlying binary not installed). Run 'npm install' in this project or use a global installation.`
              : `The binary may be missing or corrupted.`;
          reject(
            new Error(
              `LSP server ${command} exited immediately with code ${code}. ${errorMsg}${formatStartupStderr(startupStderr)}`,
            ),
          );
        }
      });

      const startupFailureWindowMs = ((): number => {
        if (options?.startupFailureWindowMs) {
          return options.startupFailureWindowMs;
        }
        if (isWindows && needsShell) {
          return WINDOWS_NAV_STARTUP_FAILURE_WINDOW_MS;
        }
        return DEFAULT_STARTUP_FAILURE_WINDOW_MS;
      })();

      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, startupFailureWindowMs);
    });
  } finally {
    proc.stderr?.off("data", onStartupStderr);
  }

  _attachErrorHandler(proc, command, {
    command: spawnCommand,
    args,
    cwd,
    pid: proc.pid ?? 0,
  });
  unrefLspProcessHandles(proc);

  return {
    process: proc,
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    pid: proc.pid ?? 0,
    command: spawnCommand,
    args,
  };
}

export async function launchViaNode(
  scriptPath: string,
  args: string[] = [],
  options: SpawnOptions = {},
): Promise<LSPProcess> {
  return launchLSP(nodeExecutable(), [scriptPath, ...args], options);
}

export async function launchViaPython(
  moduleName: string,
  args: string[] = [],
  options: SpawnOptions = {},
): Promise<LSPProcess> {
  const pythonCmd = process.platform === "win32" ? "py" : "python3";
  return launchLSP(pythonCmd, ["-m", moduleName, ...args], options);
}

export async function stopLSP(handle: LSPProcess): Promise<void> {
  if (handle.process.exitCode !== null || handle.process.signalCode !== null) {
    return;
  }

  return new Promise((resolve) => {
    let settled = false;
    let forceTimeout: ReturnType<typeof setTimeout> | undefined;
    let giveUpTimeout: ReturnType<typeof setTimeout> | undefined;

    const done = () => {
      if (settled) return;
      settled = true;
      if (forceTimeout) clearTimeout(forceTimeout);
      if (giveUpTimeout) clearTimeout(giveUpTimeout);
      handle.process.off("exit", done);
      handle.process.off("error", done);
      resolve();
    };

    handle.process.once("exit", done);
    handle.process.once("error", done);

    const killWindowsTree = (): boolean => {
      if (!isWindows || handle.pid <= 0) return false;
      if (handle.process.exitCode !== null || handle.process.signalCode !== null) return false;
      try {
        const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
        const killer = nodeSpawn(taskkill, ["/F", "/T", "/PID", String(handle.pid)], {
          shell: false,
          windowsHide: true,
        });
        killer.once("error", done);
        return true;
      } catch {
        return false;
      }
    };

    try {
      if (!killWindowsTree()) {
        handle.process.kill("SIGTERM");
      }
    } catch {
      done();
      return;
    }

    forceTimeout = setTimeout(() => {
      if (settled) return;
      try {
        if (!killWindowsTree()) {
          handle.process.kill("SIGKILL");
        }
      } catch {
        done();
        return;
      }
      giveUpTimeout = setTimeout(done, 500);
    }, 5000);
  });
}
