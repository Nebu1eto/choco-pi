import * as fs from "node:fs";
import fsp from "node:fs/promises";
import { writeFileAtomic, writeFileAtomicAsync } from "./atomic-write.ts";
import {
  acquireBoundedPidFileLock,
  acquireQuarantinePidFileLock,
} from "./bounded-pid-file-lock.ts";

interface DurableStoreCommitCore<T> {
  path: string;
  deserialize: (contents: string | undefined) => T;
  merge: (current: T) => T;
  serialize: (value: T) => string | Uint8Array;
  waitMs: number;
  retryMs: number;
  timeoutMessage: string;
}

interface DurableStoreCommitBase<T> extends DurableStoreCommitCore<T> {
  afterWriteLocked?: (value: T) => void;
}

interface AsyncDurableStoreCommitBase<T> extends DurableStoreCommitCore<T> {
  staleMs: number;
  afterWriteLocked?: (value: T) => void | Promise<void>;
}

function readLocked(path: string): string | undefined {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function commitDurableStore<T>(
  options: DurableStoreCommitBase<T> & { onContention?: "throw" },
): T;
export function commitDurableStore<T>(
  options: DurableStoreCommitBase<T> & {
    onContention: "skip-log";
    logContention: () => void;
  },
): T | undefined;
export function commitDurableStore<T>(
  options: DurableStoreCommitBase<T> &
    ({ onContention?: "throw" } | { onContention: "skip-log"; logContention: () => void }),
): T | undefined {
  const release =
    options.onContention === "skip-log"
      ? acquireBoundedPidFileLock(`${options.path}.lock`, {
          waitMs: options.waitMs,
          retryMs: options.retryMs,
          timeoutMessage: options.timeoutMessage,
          onContention: "skip-log",
          logContention: options.logContention,
        })
      : acquireBoundedPidFileLock(`${options.path}.lock`, {
          waitMs: options.waitMs,
          retryMs: options.retryMs,
          timeoutMessage: options.timeoutMessage,
          onContention: "throw",
        });
  if (!release) return undefined;
  let committed: T;
  try {
    const current = options.deserialize(readLocked(options.path));
    committed = options.merge(current);
    writeFileAtomic(options.path, options.serialize(committed), {
      bestEffort: false,
    });
    options.afterWriteLocked?.(committed);
  } finally {
    release();
  }
  return committed;
}

async function readLockedAsync(path: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function commitDurableStoreAsync<T>(
  options: AsyncDurableStoreCommitBase<T> & { onContention?: "throw" },
): Promise<T>;
export async function commitDurableStoreAsync<T>(
  options: AsyncDurableStoreCommitBase<T> & {
    onContention: "skip-log";
    logContention: () => void;
  },
): Promise<T | undefined>;
export async function commitDurableStoreAsync<T>(
  options: AsyncDurableStoreCommitBase<T> &
    ({ onContention?: "throw" } | { onContention: "skip-log"; logContention: () => void }),
): Promise<T | undefined> {
  const release =
    options.onContention === "skip-log"
      ? await acquireQuarantinePidFileLock(`${options.path}.lock`, {
          waitMs: options.waitMs,
          retryMs: options.retryMs,
          staleMs: options.staleMs,
          timeoutMessage: options.timeoutMessage,
          onContention: "skip-log",
          logContention: options.logContention,
        })
      : await acquireQuarantinePidFileLock(`${options.path}.lock`, {
          waitMs: options.waitMs,
          retryMs: options.retryMs,
          staleMs: options.staleMs,
          timeoutMessage: options.timeoutMessage,
          onContention: "throw",
        });
  if (!release) return undefined;
  try {
    const current = options.deserialize(await readLockedAsync(options.path));
    const committed = options.merge(current);
    await writeFileAtomicAsync(options.path, options.serialize(committed), {
      bestEffort: false,
    });
    await options.afterWriteLocked?.(committed);
    return committed;
  } finally {
    await release();
  }
}
