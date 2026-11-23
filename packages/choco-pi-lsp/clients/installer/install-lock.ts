/**
 * Managed tools directory and the cross-process install lock.
 */
import { unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { getGlobalPiLensDir } from "../file-utils.ts";

export const _installerRequire = createRequire(import.meta.url);

// Global installation directory for choco-pi-lsp tools
export const TOOLS_DIR = path.join(getGlobalPiLensDir(), "tools");
const INSTALL_LOCK_PATH = path.join(TOOLS_DIR, ".install.lock");
const activeInstallLocks = new Set<string>();
let installLockExitCleanupRegistered = false;

// Removes this process's held install locks at exit. unlinkSync is retained
// because an `exit` listener cannot await. The listener is registered only
// while a lock is held: Pi may evaluate this module more than once per process,
// and a permanent listener would pin every evaluation's module graph.
function releaseInstallLocksAtExit(): void {
  installLockExitCleanupRegistered = false;
  for (const lockPath of activeInstallLocks) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Best effort; the next owner verifies this PID is dead.
    }
  }
}

/**
 * The managed tools tree, for callers that need to tell a path `getToolPath()`
 * returned from the managed install apart from a global/PATH hit (the tool
 * registry is this module's business — don't re-derive `<choco-pi-lsp home>/tools`).
 */
export function getManagedToolsDir(): string {
  return TOOLS_DIR;
}

interface InstallLockOwner {
  pid: number;
  createdAt: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function acquireInstallLock(): Promise<{
  release?: () => Promise<void>;
  reason?: string;
}> {
  await fs.mkdir(TOOLS_DIR, { recursive: true });
  // #946 review F2: the waiter's bound must exceed the owner's install bound
  // (CHOCO_PI_LSP_INSTALL_TIMEOUT_MS, default 120s) — a 30s waiter gave up on a
  // legitimate slow install and reported the tool unavailable for the whole
  // session even though it arrived seconds later.
  const timeoutMs = Number(process.env.CHOCO_PI_LSP_INSTALL_LOCK_TIMEOUT_MS) || 150_000;
  const deadline = Date.now() + timeoutMs;
  let lastOwner = "unknown owner";

  while (Date.now() < deadline) {
    try {
      const handle = await fs.open(INSTALL_LOCK_PATH, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      await handle.close();
      activeInstallLocks.add(INSTALL_LOCK_PATH);
      if (!installLockExitCleanupRegistered) {
        installLockExitCleanupRegistered = true;
        process.once("exit", releaseInstallLocksAtExit);
      }
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          activeInstallLocks.delete(INSTALL_LOCK_PATH);
          if (activeInstallLocks.size === 0 && installLockExitCleanupRegistered) {
            installLockExitCleanupRegistered = false;
            process.off("exit", releaseInstallLocksAtExit);
          }
          await fs.rm(INSTALL_LOCK_PATH, { force: true });
        },
      };
    } catch (error) {
      // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        // SAFETY: The parsed value is consumed only through the optional fields declared here and each field is validated before use.
        const owner = JSON.parse(await fs.readFile(INSTALL_LOCK_PATH, "utf8")) as InstallLockOwner;
        lastOwner = `pid=${owner.pid} createdAt=${owner.createdAt}`;
        // #946 review F1: PID liveness alone cannot detect a hard-killed
        // owner whose PID Windows has recycled — that lock would poison
        // every future install with a full-timeout wait. A lock older
        // than any legitimate install (owner install bound + slack) is
        // stale regardless of what the PID now points at.
        const maxAgeMs = (Number(process.env.CHOCO_PI_LSP_INSTALL_TIMEOUT_MS) || 120_000) + 60_000;
        const expired = Number.isFinite(owner.createdAt) && Date.now() - owner.createdAt > maxAgeMs;
        if (
          expired ||
          (Number.isInteger(owner.pid) && owner.pid > 0 && !isProcessAlive(owner.pid))
        ) {
          await fs.rm(INSTALL_LOCK_PATH, { force: true });
          continue;
        }
      } catch (readError) {
        lastOwner = "unreadable owner";
        // An unreadable/empty lock has no createdAt to age out — fall
        // back to the file's own mtime for the max-age check so it is
        // eventually recoverable (#946 review F1/F6).
        try {
          const stat = await fs.stat(INSTALL_LOCK_PATH);
          const maxAgeMs =
            (Number(process.env.CHOCO_PI_LSP_INSTALL_TIMEOUT_MS) || 120_000) + 60_000;
          if (Date.now() - stat.mtimeMs > maxAgeMs) {
            await fs.rm(INSTALL_LOCK_PATH, { force: true });
            continue;
          }
        } catch {
          // stat raced a release — loop and retry acquisition.
        }
        void readError;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return {
    reason: `timed out after ${timeoutMs}ms waiting for shared tools install lock (${lastOwner})`,
  };
}
