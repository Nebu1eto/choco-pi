/**
 * PATH command availability, spawnability checks, pinned-version parsing, and managed binary verification.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { logSessionStart } from "../sessionstart-logger.ts";
import { debugLog, installerPlatform } from "./installer-env.ts";

// --- Check Functions ---

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

/**
 * Check if a command is available in PATH by walking PATH entries and
 * verifying each candidate is a real file with non-zero size.
 * Catches broken symlinks (stat throws ENOENT or returns size 0) without
 * spawning a process — ~μs per candidate vs ~50ms for which/where.
 */
export async function isCommandAvailable(command: string, _args?: string[]): Promise<boolean> {
  const isWindows = installerPlatform() === "win32";
  const pathEnv = process.env.PATH || process.env.Path || process.env.path || "";
  const dirs = pathEnv.split(path.delimiter);

  // On Windows, probe .exe, .cmd, and .bat extensions in addition to bare name.
  // On Unix, probe bare name and extensionless (scripts, symlinks).
  const names = isWindows
    ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
    : [command];

  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        const stat = statSync(candidate);
        // isFile() returns false for broken symlinks (target missing)
        if (stat.isFile() && stat.size > 0) {
          return true;
        }
      } catch {
        // ENOENT or permission denied — skip this candidate
      }
    }
  }

  return false;
}

/**
 * Can `command` even be spawned? Path-bearing commands stat the file directly;
 * bare names walk PATH. ~μs either way — callers use this to skip a `--version`
 * probe that is guaranteed to fail with a full spawn round-trip.
 */
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

// --- Verification Functions

/**
 * Stdio LSP servers built on `vscode-languageserver-node` (the entire
 * `vscode-langservers-extracted` family — json/css/html/eslint, and markdown)
 * reject a bare `--version`: `createConnection()` throws immediately because no
 * transport flag was supplied, and the process exits non-zero. That error is
 * positive proof the binary loaded and is a working LSP server — it just needs
 * `--stdio` to actually run — so `--version`-based verification must treat it as
 * success rather than a broken install (#208). A genuinely broken binary fails
 * with a different error (SyntaxError, ERR_MODULE_NOT_FOUND, …) that does not
 * match this pattern, so the broken-install guard is preserved.
 */
export function isLspTransportRequiredError(output: string): boolean {
  return /Connection (?:input|output) stream is not set|Use arguments of createConnection/i.test(
    output,
  );
}

/**
 * Parse the exact version pinned in a TOOLS `packageName` spec, e.g.
 * `"jscpd@3.5.10"` -> `"3.5.10"`. Scoped packages (`"@ast-grep/cli"`) have no
 * pin unless a version is appended after the package name
 * (`"@scope/pkg@1.2.3"`) — `lastIndexOf("@")` on a bare scope marker (index 0)
 * correctly reports "no pin" rather than mistaking the scope for a version.
 * Returns undefined when packageName has no explicit `@version` suffix.
 */
export function parsePinnedVersion(packageName: string): string | undefined {
  const at = packageName.lastIndexOf("@");
  if (at <= 0) return undefined;
  return packageName.slice(at + 1) || undefined;
}

/** Extract the first semver-ish token (e.g. "3.5.10") from `--version` output. */
export function extractVersionToken(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0];
}

/**
 * Version reported by the last successful `--version` probe of a choco-pi-lsp
 * managed local npm install, keyed by toolId. Populated only inside
 * getToolPath()'s managed-local-install checks below — i.e. only when that
 * code path already spawns verifyToolBinary anyway (cache hits in
 * ensureTool()'s fast paths never reach getToolPath, so this never adds a new
 * spawn). Consumed by ensureTool() to detect drift against the tool's current
 * `packageName` pin (#589) — deliberately scoped to installStrategy "npm"
 * with an explicit version pin; unpinned tools and non-npm strategies (github/
 * maven/archive) never populate or read this map.
 */
export const lastManagedInstallVersion = new Map<string, string>();

/**
 * Verify a tool binary actually works by running --version
 * This catches broken symlinks, partial installs, and corrupted binaries.
 * `onVersionOutput`, when provided, receives the raw stdout on a successful
 * (exit 0) probe — used to piggyback version-pin drift detection onto this
 * already-happening spawn instead of adding a new one (#589).
 *
 * Exported so every managed-binary check runs THIS verification rather than a
 * bare `existsSync` of its own: an on-disk shim that cannot run must not
 * shadow a working PATH binary (#1657).
 */
export async function verifyToolBinary(
  binPath: string,
  onVersionOutput?: (output: string) => void,
  /**
   * Called when a `false` verdict came from a probe that never got a fair
   * run — a spawn timeout/signal or a spawn-boundary EAGAIN/EBUSY/sync throw
   * — rather than the binary actually rejecting `--version` (#1569). An
   * unspawnable prober is never a durable verdict: a caller that falls
   * through to a lower-priority candidate on one of these must not let the
   * fallback's selection be trusted as if the preferred candidate were
   * genuinely broken.
   */
  onTransient?: () => void,
  /**
   * Spawn budget, ms. Install paths keep the generous default; a latency-
   * sensitive caller on the dispatch hot path passes a shorter one and treats
   * the expiry as transient rather than as a verdict (#1657).
   */
  timeoutMs = 10000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const isWindows = installerPlatform() === "win32";
    const hasKnownWindowsExt = /\.(cmd|exe|ps1)$/i.test(binPath);

    // On Windows, resolve the best executable path:
    // - extensionless → prefer .cmd (cmd.exe-safe)
    // - .ps1 → prefer .cmd sibling to avoid PowerShell execution-policy hangs
    // - .cmd / .exe → use as-is
    let execPath = isWindows && !hasKnownWindowsExt ? `${binPath}.cmd` : binPath;
    let useShell = isWindows && /\.(cmd|bat)$/i.test(execPath);

    if (isWindows && /\.ps1$/i.test(execPath)) {
      const cmdSibling = `${execPath.slice(0, -4)}.cmd`;
      if (require("node:fs").existsSync(cmdSibling)) {
        execPath = cmdSibling;
        useShell = true;
      } else {
        // Fall back to running without shell — cmd.exe can't run .ps1
        useShell = false;
      }
    }

    // When shell:true (Windows .cmd), bake args into the command string to avoid DEP0190.
    const spawnCmd = useShell ? `"${execPath}" --version` : execPath;
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(spawnCmd, useShell ? [] : ["--version"], {
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
        shell: useShell,
      });
    } catch (err) {
      // SYNCHRONOUS spawn throw (Windows `spawn UNKNOWN`/EINVAL, the pidusage
      // bug class, #533) — best-effort verify, resolve rather than reject.
      // The prober itself never ran, so this says nothing about the binary.
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
        // Valid stdio LSP server that rejects `--version` (#208) — the
        // transport-required error proves the binary works.
        debugLog(`Verified (stdio LSP, transport-required): ${binPath}`);
        resolve(true);
      } else {
        // `code === null` (usually paired with a `signal`) means the
        // spawn timeout fired and the process was killed before it could
        // exit on its own — a stall, not a verdict from the binary.
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
