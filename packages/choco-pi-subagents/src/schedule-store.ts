/**
 * schedule-store.ts — File-backed store for scheduled subagents.
 *
 * Session-scoped: each pi session owns its own schedules at
 * `<cwd>/.pi/subagent-schedules/<sessionId>.json`. `/new` starts a fresh
 * empty store; `/resume` reloads.
 *
 * Concurrency model lifted from pi-chonky-tasks/src/task-store.ts: every
 * mutation acquires a PID-based exclusion lock, re-reads the latest state
 * from disk, applies the change, atomic-writes via temp+rename, releases.
 *
 * All I/O is asynchronous. The lock is an exclusive create (`open(..., "wx")`)
 * holding the owner's PID; contention waits with a timer, never a busy loop.
 * Within one process, mutations of one store run through a promise chain, so
 * two saves never interleave the shared temp file.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createExclusiveFile, readTextIfExists } from "./fs-async.ts";
import type { ScheduledSubagent, ScheduleStoreData } from "./types.ts";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Acquire the PID lock at `lockPath`, reclaiming it from a dead owner. Rejects after the retry budget. */
export async function acquireScheduleLock(lockPath: string): Promise<void> {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    if (await createExclusiveFile(lockPath, `${process.pid}`)) return;
    try {
      const pid = parseInt(await readFile(lockPath, "utf-8"), 10);
      if (pid && !isProcessRunning(pid)) {
        await unlink(lockPath);
        continue;
      }
    } catch {
      /* ignore — try again */
    }
    await delay(LOCK_RETRY_MS);
  }
  throw new Error(`Failed to acquire schedule lock: ${lockPath}`);
}

/** Release a lock taken by {@link acquireScheduleLock}. Never rejects. */
export async function releaseScheduleLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {
    /* ignore */
  }
}

/** Resolve the storage path for a session-scoped store. */
export function resolveStorePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "subagent-schedules", `${sessionId}.json`);
}

export class ScheduleStore {
  private filePath: string;
  private lockPath: string;
  private jobs = new Map<string, ScheduledSubagent>();
  /** Tail of this store's mutation chain; mutations run one at a time, in call order. */
  private chain: Promise<void> = Promise.resolve();

  private constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  /** Open a store and load its persisted jobs into the in-memory cache. */
  static async open(filePath: string): Promise<ScheduleStore> {
    const store = new ScheduleStore(filePath);
    await store.load();
    return store;
  }

  /** Create the backing directory lazily — only when we're about to persist. */
  private async ensureDir(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  /** Load from disk into the in-memory cache. Silent on parse errors. */
  private async load(): Promise<void> {
    let text: string | undefined;
    try {
      text = await readTextIfExists(this.filePath);
    } catch {
      return; // unreadable — keep the cache, next save rewrites
    }
    if (text === undefined) return;
    try {
      const data: ScheduleStoreData = JSON.parse(text);
      this.jobs.clear();
      for (const j of data.jobs ?? []) this.jobs.set(j.id, j);
    } catch {
      /* corrupt — start fresh, next save rewrites */
    }
  }

  /** Atomic write via temp file + rename (POSIX-atomic). */
  private async save(): Promise<void> {
    const data: ScheduleStoreData = { version: 1, jobs: [...this.jobs.values()] };
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, this.filePath);
  }

  /** Queue `fn` behind this store's earlier mutations; the chain survives a failed step. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Serialize → acquire lock → reload → mutate → save → release. */
  private withLock<T>(fn: () => T): Promise<T> {
    return this.serialize(async () => {
      await this.ensureDir();
      await acquireScheduleLock(this.lockPath);
      try {
        await this.load();
        const result = fn();
        await this.save();
        return result;
      } finally {
        await releaseScheduleLock(this.lockPath);
      }
    });
  }

  /** Read-only — returns a snapshot of the in-memory cache. */
  list(): ScheduledSubagent[] {
    return [...this.jobs.values()];
  }

  /** Read-only check — uses the cache. */
  hasName(name: string, exceptId?: string): boolean {
    for (const j of this.jobs.values()) {
      if (j.id !== exceptId && j.name === name) return true;
    }
    return false;
  }

  get(id: string): ScheduledSubagent | undefined {
    return this.jobs.get(id);
  }

  /**
   * Add `job` unless another job already holds its name. The name is checked
   * under the lock against the freshly reloaded state, so two concurrent adds
   * of one name cannot both succeed. Resolves `false` (nothing written to
   * the job set) when the name is taken.
   */
  add(job: ScheduledSubagent): Promise<boolean> {
    return this.withLock(() => {
      if (this.hasName(job.name, job.id)) return false;
      this.jobs.set(job.id, job);
      return true;
    });
  }

  update(id: string, patch: Partial<ScheduledSubagent>): Promise<ScheduledSubagent | undefined> {
    // No-op fast path — an unknown id changes nothing, so don't lock or touch
    // disk (which would otherwise lazily create the backing directory).
    if (!this.jobs.has(id)) return Promise.resolve(undefined);
    return this.withLock(() => {
      const existing = this.jobs.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...patch };
      this.jobs.set(id, updated);
      return updated;
    });
  }

  remove(id: string): Promise<boolean> {
    // No-op fast path — see update().
    if (!this.jobs.has(id)) return Promise.resolve(false);
    return this.withLock(() => this.jobs.delete(id));
  }

  /** Delete the backing file (used when no jobs remain, optional cleanup). */
  deleteFileIfEmpty(): Promise<void> {
    return this.serialize(async () => {
      if (this.jobs.size !== 0) return;
      try {
        await unlink(this.filePath);
      } catch {
        /* ignore — absent or already removed */
      }
    });
  }
}
