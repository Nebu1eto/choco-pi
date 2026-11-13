import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  acquireScheduleLock,
  releaseScheduleLock,
  resolveStorePath,
  ScheduleStore,
} from "../src/schedule-store.ts";
import type { ScheduledSubagent, ScheduleStoreData } from "../src/types.ts";

const execFileAsync = promisify(execFile);

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "schedule-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function job(id: string, name = id): ScheduledSubagent {
  return {
    id,
    name,
    description: name,
    schedule: "5m",
    scheduleType: "interval",
    intervalMs: 300_000,
    subagent_type: "general-purpose",
    prompt: "tick",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
  };
}

async function readStore(path: string): Promise<ScheduleStoreData> {
  return JSON.parse(await readFile(path, "utf-8"));
}

/** A PID that belonged to a process that has exited. */
async function deadPid(): Promise<number> {
  const { stdout } = await execFileAsync(process.execPath, [
    "-e",
    "process.stdout.write(String(process.pid))",
  ]);
  return Number(stdout);
}

test("the wx lock admits one holder at a time; a contender waits for the release", async (t) => {
  const lockPath = join(await tempDir(t), "jobs.json.lock");
  await acquireScheduleLock(lockPath);
  assert.equal(await readFile(lockPath, "utf-8"), String(process.pid), "the lock holds our PID");

  let secondAcquired = false;
  const second = acquireScheduleLock(lockPath).then(() => {
    secondAcquired = true;
  });
  // Several retry intervals pass: the live holder (this process) keeps the lock.
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(secondAcquired, false, "a live holder is never reclaimed");

  await releaseScheduleLock(lockPath);
  await second;
  assert.equal(secondAcquired, true, "the contender acquires after the release");
  await releaseScheduleLock(lockPath);
});

test("concurrent contenders never overlap inside the lock", async (t) => {
  const lockPath = join(await tempDir(t), "jobs.json.lock");
  let inside = 0;
  let maxInside = 0;
  const order: number[] = [];
  await Promise.all(
    Array.from({ length: 5 }, async (_, index) => {
      await acquireScheduleLock(lockPath);
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(index);
      inside--;
      await releaseScheduleLock(lockPath);
    }),
  );
  assert.equal(maxInside, 1, "exclusive create admits exactly one holder");
  assert.equal(order.length, 5, "every contender eventually acquired");
});

test("a lock left by a dead process is reclaimed", async (t) => {
  const lockPath = join(await tempDir(t), "jobs.json.lock");
  await writeFile(lockPath, String(await deadPid()));
  await acquireScheduleLock(lockPath);
  assert.equal(await readFile(lockPath, "utf-8"), String(process.pid));
  await releaseScheduleLock(lockPath);
});

test("two stores on one file lose no update and leave no temp or lock file", async (t) => {
  const dir = await tempDir(t);
  const path = resolveStorePath(dir, "session-1");
  // Two instances model two processes sharing the file through the PID lock.
  const [first, second] = await Promise.all([ScheduleStore.open(path), ScheduleStore.open(path)]);
  const added = await Promise.all([
    first.add(job("a")),
    second.add(job("b")),
    first.add(job("c")),
    second.add(job("d")),
  ]);
  assert.deepEqual(added, [true, true, true, true]);
  const stored = await readStore(path);
  assert.deepEqual(stored.jobs.map((j) => j.id).sort(), ["a", "b", "c", "d"]);
  assert.deepEqual((await readdir(join(dir, ".pi", "subagent-schedules"))).sort(), [
    "session-1.json",
  ]);
});

test("concurrent adds of one name admit exactly one, checked under the lock", async (t) => {
  const path = resolveStorePath(await tempDir(t), "session-2");
  const [first, second] = await Promise.all([ScheduleStore.open(path), ScheduleStore.open(path)]);
  const added = await Promise.all([
    first.add(job("x", "nightly")),
    second.add(job("y", "nightly")),
  ]);
  assert.deepEqual(added.filter(Boolean).length, 1);
  assert.equal((await readStore(path)).jobs.length, 1);
});

test("one store's mutations apply in call order and reload on open", async (t) => {
  const path = resolveStorePath(await tempDir(t), "session-3");
  const store = await ScheduleStore.open(path);
  await store.add(job("a"));
  const updates = await Promise.all(
    Array.from({ length: 10 }, (_, runCount) => store.update("a", { runCount })),
  );
  assert.deepEqual(
    updates.map((updated) => updated?.runCount),
    Array.from({ length: 10 }, (_, runCount) => runCount),
  );
  assert.equal((await readStore(path)).jobs[0]?.runCount, 9, "the last update wins on disk");

  const reopened = await ScheduleStore.open(path);
  assert.equal(reopened.get("a")?.runCount, 9);
  assert.equal(await reopened.remove("a"), true);
  await reopened.deleteFileIfEmpty();
  await assert.rejects(readFile(path, "utf-8"), { code: "ENOENT" });
});
