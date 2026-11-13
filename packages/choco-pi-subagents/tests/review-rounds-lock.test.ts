/**
 * The review-round ledger lock: stale recovery and release must never delete a
 * lock another writer created after the stale one was observed.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { acquireLock, releaseLock } from "../src/review-rounds.ts";

async function lockPath(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "review-rounds-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "ledger.json.lock");
}

async function makeStale(path: string): Promise<void> {
  await writeFile(path, "crashed-holder");
  const old = new Date(Date.now() - 60_000);
  await utimes(path, old, old);
}

test("a contender paused after judging a lock stale cannot delete the lock that replaced it", async (t) => {
  const path = await lockPath(t);
  await makeStale(path);
  let reached: () => void = () => undefined;
  const atRemoval = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  // B observes the stale lock, then pauses right before removing it.
  const contender = acquireLock(path, {
    timeoutMs: 300,
    beforeStaleRemoval: async () => {
      reached();
      await gate;
    },
  });
  await atRemoval;
  // Meanwhile A recovers the same stale lock and takes it.
  const holder = await acquireLock(path);
  assert.equal(await readFile(path, "utf-8"), holder);
  open();
  // B must not take the lock while A holds it: it times out instead.
  await assert.rejects(contender, /timed out waiting for the ledger lock/);
  assert.equal(await readFile(path, "utf-8"), holder, "A's lock is intact");
  await releaseLock(path, holder);
  await assert.rejects(readFile(path, "utf-8"), { code: "ENOENT" });
});

test("release removes only the caller's own lock", async (t) => {
  const path = await lockPath(t);
  const token = await acquireLock(path);
  await writeFile(path, "another-writer");
  await releaseLock(path, token);
  assert.equal(await readFile(path, "utf-8"), "another-writer");
  await releaseLock(path, "another-writer");
  await assert.rejects(readFile(path, "utf-8"), { code: "ENOENT" });
});

test("a stale lock is still recovered when nobody else contends", async (t) => {
  const path = await lockPath(t);
  await makeStale(path);
  const token = await acquireLock(path, { timeoutMs: 300 });
  assert.equal(await readFile(path, "utf-8"), token);
});
