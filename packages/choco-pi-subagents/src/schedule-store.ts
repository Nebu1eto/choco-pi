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

export async function acquireScheduleLock(lockPath: string): Promise<void> {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    if (await createExclusiveFile(lockPath, `${process.pid}`)) return;
    try {
      const pid = parseInt(await readFile(lockPath, "utf-8"), 10);
      if (pid && !isProcessRunning(pid)) {
        await unlink(lockPath);
        continue;
      }
    } catch {}
    await delay(LOCK_RETRY_MS);
  }
  throw new Error(`Failed to acquire schedule lock: ${lockPath}`);
}

export async function releaseScheduleLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {}
}

export function resolveStorePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "subagent-schedules", `${sessionId}.json`);
}

export class ScheduleStore {
  private filePath: string;
  private lockPath: string;
  private jobs = new Map<string, ScheduledSubagent>();
  private chain: Promise<void> = Promise.resolve();

  private constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  static async open(filePath: string): Promise<ScheduleStore> {
    const store = new ScheduleStore(filePath);
    await store.load();
    return store;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  private async load(): Promise<void> {
    let text: string | undefined;
    try {
      text = await readTextIfExists(this.filePath);
    } catch {
      return;
    }
    if (text === undefined) return;
    try {
      const data: ScheduleStoreData = JSON.parse(text);
      this.jobs.clear();
      for (const j of data.jobs ?? []) this.jobs.set(j.id, j);
    } catch {}
  }

  private async save(): Promise<void> {
    const data: ScheduleStoreData = { version: 1, jobs: [...this.jobs.values()] };
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, this.filePath);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

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

  list(): ScheduledSubagent[] {
    return [...this.jobs.values()];
  }

  hasName(name: string, exceptId?: string): boolean {
    for (const j of this.jobs.values()) {
      if (j.id !== exceptId && j.name === name) return true;
    }
    return false;
  }

  get(id: string): ScheduledSubagent | undefined {
    return this.jobs.get(id);
  }

  add(job: ScheduledSubagent): Promise<boolean> {
    return this.withLock(() => {
      if (this.hasName(job.name, job.id)) return false;
      this.jobs.set(job.id, job);
      return true;
    });
  }

  update(id: string, patch: Partial<ScheduledSubagent>): Promise<ScheduledSubagent | undefined> {
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
    if (!this.jobs.has(id)) return Promise.resolve(false);
    return this.withLock(() => this.jobs.delete(id));
  }

  deleteFileIfEmpty(): Promise<void> {
    return this.serialize(async () => {
      if (this.jobs.size !== 0) return;
      try {
        await unlink(this.filePath);
      } catch {}
    });
  }
}
