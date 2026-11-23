import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { logSessionStart } from "../sessionstart-logger.ts";
import { debugLog, installerPlatform } from "./installer-env.ts";

const pathWalkMemo = new Map<string, boolean>();

function hashSync(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export function resetPathWalkMemo(): void {
  pathWalkMemo.clear();
}

export async function isCommandAvailable(command: string, _args?: string[]): Promise<boolean> {
  const isWindows = installerPlatform() === "win32";
  const pathEnv = process.env.PATH || process.env.Path || process.env.path || "";
  const dirs = pathEnv.split(path.delimiter);

  const names = isWindows
    ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
    : [command];

  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        const stat = statSync(candidate);
        if (stat.isFile() && stat.size > 0) {
          return true;
        }
      } catch {}
    }
  }

  return false;
}

export async function isSpawnableCommand(command: string): Promise<boolean> {
  if (/[\\/]/.test(command)) {
    try {
      const stat = statSync(command);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }
  const memoKey = `${command}:${hashSync(process.env.PATH || "")}`;
  if (pathWalkMemo.has(memoKey)) return pathWalkMemo.get(memoKey) ?? false;
  const isSpawnable = await isCommandAvailable(command);
  pathWalkMemo.set(memoKey, isSpawnable);
  return isSpawnable;
}

export function isLspTransportRequiredError(output: string): boolean {
  return /Connection (?:input|output) stream is not set|Use arguments of createConnection/i.test(
    output,
  );
}

export function parsePinnedVersion(packageName: string): string | undefined {
  const at = packageName.lastIndexOf("@");
  if (at <= 0) return undefined;
  return packageName.slice(at + 1) || undefined;
}

export function extractVersionToken(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0];
}

export const lastManagedInstallVersion = new Map<string, string>();

export async function verifyToolBinary(
  binPath: string,
  onVersionOutput?: (output: string) => void,
  onTransient?: () => void,
  timeoutMs = 10000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const isWindows = installerPlatform() === "win32";
    const hasKnownWindowsExt = /\.(cmd|exe|ps1)$/i.test(binPath);

    let execPath = isWindows && !hasKnownWindowsExt ? `${binPath}.cmd` : binPath;
    let useShell = isWindows && /\.(cmd|bat)$/i.test(execPath);

    if (isWindows && /\.ps1$/i.test(execPath)) {
      const cmdSibling = `${execPath.slice(0, -4)}.cmd`;
      if (require("node:fs").existsSync(cmdSibling)) {
        execPath = cmdSibling;
        useShell = true;
      } else {
        useShell = false;
      }
    }

    const spawnCmd = useShell ? `"${execPath}" --version` : execPath;
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(spawnCmd, useShell ? [] : ["--version"], {
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
        shell: useShell,
      });
    } catch (err) {
      logSessionStart(
        `auto-install verify: spawn threw for ${binPath} (${err instanceof Error ? err.message : String(err)})`,
      );
      onTransient?.();
      resolve(false);
      return;
    }

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => (stdout += data));
    proc.stderr?.on("data", (data) => (stderr += data));

    proc.on("exit", (code, signal) => {
      if (code === 0) {
        debugLog(`Verified: ${binPath} (version: ${stdout.trim()})`);
        onVersionOutput?.(stdout);
        resolve(true);
      } else if (isLspTransportRequiredError(`${stdout}\n${stderr}`)) {
        debugLog(`Verified (stdio LSP, transport-required): ${binPath}`);
        resolve(true);
      } else {
        if (code === null || signal) onTransient?.();
        logSessionStart(
          `auto-install verify: failed for ${binPath} (exit=${code}${signal ? `, signal=${signal}` : ""})`,
        );
        resolve(false);
      }
    });

    proc.on("error", (err) => {
      // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno === "EAGAIN" || errno === "EBUSY" || errno === "ETIMEDOUT") {
        onTransient?.();
      }
      logSessionStart(`auto-install verify: error for ${binPath}: ${err.message}`);
      resolve(false);
    });
  });
}
