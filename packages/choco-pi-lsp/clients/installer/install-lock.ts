import { unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { getGlobalPiLensDir } from "../file-utils.ts";

export const _installerRequire = createRequire(import.meta.url);

export const TOOLS_DIR = path.join(getGlobalPiLensDir(), "tools");
const INSTALL_LOCK_PATH = path.join(TOOLS_DIR, ".install.lock");
const activeInstallLocks = new Set<string>();
let installLockExitCleanupRegistered = false;

function releaseInstallLocksAtExit(): void {
  installLockExitCleanupRegistered = false;
  for (const lockPath of activeInstallLocks) {
    try {
      unlinkSync(lockPath);
    } catch {}
  }
}

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
        try {
          const stat = await fs.stat(INSTALL_LOCK_PATH);
          const maxAgeMs =
            (Number(process.env.CHOCO_PI_LSP_INSTALL_TIMEOUT_MS) || 120_000) + 60_000;
          if (Date.now() - stat.mtimeMs > maxAgeMs) {
            await fs.rm(INSTALL_LOCK_PATH, { force: true });
            continue;
          }
        } catch {}
        void readError;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return {
    reason: `timed out after ${timeoutMs}ms waiting for shared tools install lock (${lastOwner})`,
  };
}
