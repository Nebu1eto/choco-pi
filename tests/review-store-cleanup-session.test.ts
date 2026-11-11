import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createReviewCleanupSession,
  nodeReviewCleanupFileSystem,
  type ReviewCleanupFileSystem,
  type ReviewCleanupSession,
} from "../.pi/extensions/review/core/store-cleanup.ts";
import {
  createReviewStore,
  isStoredReviewRecord,
  repoKey,
  targetKey,
} from "../.pi/extensions/review/core/store.ts";
import type { ReviewRecord, ReviewTarget } from "../.pi/extensions/review/core/types.ts";

const NOW = Date.parse("2026-03-10T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const REPO = repoKey("/work/alpha");
const OTHER = repoKey("/work/beta");

async function sandbox(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "review-store-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function target(branch: string): ReviewTarget {
  return { kind: "branch", base: branch };
}

async function writeRecord(
  base: string,
  repository: string,
  branch: string,
  ageMs: number,
): Promise<string> {
  const record: ReviewRecord = {
    version: 1,
    repoKey: repository,
    target: target(branch),
    baseSha: "base",
    headSha: "head",
    cursor: { reviewedHunkIds: [], lastHeadSha: "head" },
    comments: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  };
  await mkdir(join(base, repository), { recursive: true });
  const path = join(base, repository, `${targetKey(record.target)}.json`);
  await writeFile(path, JSON.stringify(record));
  const seconds = (NOW - ageMs) / 1000;
  await utimes(path, seconds, seconds);
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

type CountingFileSystem = {
  fileSystem: ReviewCleanupFileSystem;
  baseListings: () => number;
};

function counting(base: string): CountingFileSystem {
  let listings = 0;
  return {
    fileSystem: {
      ...nodeReviewCleanupFileSystem,
      async list(path, limit) {
        if (path === base) listings += 1;
        return nodeReviewCleanupFileSystem.list(path, limit);
      },
    },
    baseListings: () => listings,
  };
}

function session(fileSystem?: ReviewCleanupFileSystem): ReviewCleanupSession {
  return createReviewCleanupSession({
    isRecord: isStoredReviewRecord,
    now: () => NOW,
    fileSystem,
  });
}

// Runs first: this file's default (agent-directory) session must still be unused.
test("an explicitly placed store does not clean unless asked", async (t) => {
  const base = await sandbox(t);
  const old = await writeRecord(base, REPO, "old", 8 * DAY);
  const store = createReviewStore(base);
  await store.list(OTHER);
  await store.load(OTHER, targetKey(target("x")));
  // A scheduled pass would run on the next timer turn; give it several.
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await exists(old), true);
});

test("the store starts the pass on first use and keeps the record it loaded", async (t) => {
  const base = await sandbox(t);
  const opened = await writeRecord(base, REPO, "open", 8 * DAY);
  const sibling = await writeRecord(base, REPO, "sibling", 8 * DAY);
  const elsewhere = await writeRecord(base, OTHER, "elsewhere", 8 * DAY);
  const cleanup = session();
  const store = createReviewStore(base, undefined, { cleanup });
  const loaded = await store.load(REPO, targetKey(target("open")));
  assert.equal(loaded?.target.kind, "branch");
  const result = await cleanup.settled();
  assert.equal(result?.removed, 2);
  assert.equal(result?.protectedRecords, 1);
  assert.equal(await exists(opened), true);
  assert.equal(await exists(sibling), false);
  assert.equal(await exists(elsewhere), false);
});

test("listing a repository protects every record the resume picker may open", async (t) => {
  const base = await sandbox(t);
  const first = await writeRecord(base, REPO, "first", 8 * DAY);
  const second = await writeRecord(base, REPO, "second", 8 * DAY);
  const elsewhere = await writeRecord(base, OTHER, "elsewhere", 8 * DAY);
  const cleanup = session();
  const store = createReviewStore(base, undefined, { cleanup });
  const records = await store.list(REPO);
  assert.equal(records.length, 2);
  const result = await cleanup.settled();
  assert.equal(result?.protectedRecords, 2);
  assert.equal(await exists(first), true);
  assert.equal(await exists(second), true);
  assert.equal(await exists(elsewhere), false);
});

test("a saved record is protected for the rest of the session", async (t) => {
  const base = await sandbox(t);
  const saved = await writeRecord(base, REPO, "saved", 8 * DAY);
  const unrelated = await writeRecord(base, REPO, "unrelated", 8 * DAY);
  const loaded = await createReviewStore(base).load(REPO, targetKey(target("saved")));
  assert.ok(loaded);
  // Hold the pass at its first step until the saved file looks old again.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cleanup = session({
    ...nodeReviewCleanupFileSystem,
    async lstat(path) {
      await gate;
      return nodeReviewCleanupFileSystem.lstat(path);
    },
  });
  const store = createReviewStore(base, undefined, { cleanup });
  await store.save(loaded);
  const seconds = (NOW - 8 * DAY) / 1000;
  await utimes(saved, seconds, seconds);
  release();
  const result = await cleanup.settled();
  assert.equal(result?.removed, 1);
  assert.equal(result?.protectedRecords, 1);
  assert.equal(await exists(saved), true);
  assert.equal(await exists(unrelated), false);
});

test("a session runs at most one pass", async (t) => {
  const base = await sandbox(t);
  await writeRecord(base, REPO, "old", 8 * DAY);
  const { fileSystem, baseListings } = counting(base);
  const cleanup = session(fileSystem);
  const store = createReviewStore(base, undefined, { cleanup });
  await store.load(OTHER, targetKey(target("x")));
  await store.list(OTHER);
  const first = await cleanup.settled();
  assert.equal(first?.removed, 1);
  const listingsAfterFirst = baseListings();
  await writeRecord(base, REPO, "later", 8 * DAY);
  await store.load(OTHER, targetKey(target("y")));
  cleanup.start(base, () => false);
  await cleanup.settled();
  assert.equal(baseListings(), listingsAfterFirst);
  assert.equal(await exists(join(base, REPO, `${targetKey(target("later"))}.json`)), true);
});

test("two sessions cleaning at once share the work without errors", async (t) => {
  const base = await sandbox(t);
  const paths: string[] = [];
  for (const name of ["a", "b", "c", "d", "e", "f"])
    paths.push(await writeRecord(base, name < "d" ? REPO : OTHER, name, 8 * DAY));
  const options = { isRecord: isStoredReviewRecord, now: () => NOW, random: () => 0 };
  const left = createReviewCleanupSession(options);
  const right = createReviewCleanupSession(options);
  left.start(base, () => false);
  right.start(base, () => false);
  const [leftResult, rightResult] = await Promise.all([left.settled(), right.settled()]);
  assert.equal((leftResult?.errors ?? 1) + (rightResult?.errors ?? 1), 0);
  assert.equal((leftResult?.removed ?? 0) + (rightResult?.removed ?? 0), 6);
  for (const path of paths) assert.equal(await exists(path), false);
  assert.equal(await exists(base), true);
});

test("shutdown before the deferred pass starts cancels it", async (t) => {
  const base = await sandbox(t);
  const old = await writeRecord(base, REPO, "old", 8 * DAY);
  const cleanup = session();
  cleanup.start(base, () => false);
  cleanup.stop();
  assert.equal(await cleanup.settled(), undefined);
  cleanup.start(base, () => false);
  assert.equal(await cleanup.settled(), undefined);
  assert.equal(await exists(old), true);
});

test("shutdown during a pass stops it at the next step", async (t) => {
  const base = await sandbox(t);
  const paths: string[] = [];
  for (const name of ["a", "b", "c"]) paths.push(await writeRecord(base, REPO, name, 8 * DAY));
  let cleanup: ReviewCleanupSession | undefined;
  const fileSystem: ReviewCleanupFileSystem = {
    ...nodeReviewCleanupFileSystem,
    async readFile(path) {
      cleanup?.stop();
      return nodeReviewCleanupFileSystem.readFile(path);
    },
  };
  cleanup = session(fileSystem);
  cleanup.start(base, () => false);
  const result = await cleanup.settled();
  assert.equal(result?.interrupted, true);
  assert.equal(result?.removed, 0);
  for (const path of paths) assert.equal(await exists(path), true);
});

test("clean-up failures never reach the store's callers", async (t) => {
  const base = await sandbox(t);
  await writeRecord(base, REPO, "open", 8 * DAY);
  const broken = session({
    ...nodeReviewCleanupFileSystem,
    async lstat() {
      throw new Error("disk on fire");
    },
  });
  const store = createReviewStore(base, undefined, { cleanup: broken });
  assert.ok(await store.load(REPO, targetKey(target("open"))));
  const result = await broken.settled();
  assert.equal(result?.skippedBase, "error");

  const throwing: ReviewCleanupSession = {
    start() {
      throw new Error("start failed");
    },
    stop() {},
    settled: async () => undefined,
  };
  const guarded = createReviewStore(base, undefined, { cleanup: throwing });
  assert.equal((await guarded.list(REPO)).length, 1);
});

test("a load or list racing the quarantine waits and sees the record after it is put back", async (t) => {
  const base = await sandbox(t);
  const raced = await writeRecord(base, REPO, "raced", 8 * DAY);
  await writeRecord(base, OTHER, "unrelated", 8 * DAY);
  const turns = async () => {
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  let loading: Promise<ReviewRecord | undefined> | undefined;
  let listing: Promise<ReviewRecord[]> | undefined;
  let missedWhileHeld = false;
  const fileSystem: ReviewCleanupFileSystem = {
    ...nodeReviewCleanupFileSystem,
    async rename(from, to) {
      await nodeReviewCleanupFileSystem.rename(from, to);
      if (from !== raced) return;
      // Opened and listed while the record sits under its quarantine name.
      loading = store.load(REPO, targetKey(target("raced")));
      listing = store.list(REPO);
      await turns();
      missedWhileHeld = !(await exists(raced));
    },
  };
  const cleanup = session(fileSystem);
  const store = createReviewStore(base, undefined, { cleanup });
  // Starts the pass; protects only a record that does not exist.
  await store.load(OTHER, targetKey(target("none")));
  const result = await cleanup.settled();
  assert.equal(missedWhileHeld, true, "the reads ran while the file was away");
  assert.equal(result?.protectedRecords, 1);
  assert.equal(result?.removed, 1, "only the unrelated record");
  assert.equal((await loading)?.target.kind, "branch", "load sees the restored record");
  assert.equal((await listing)?.length, 1, "list sees the restored record");
  assert.equal(await exists(raced), true);
});

test("a read waiting on a record the pass holds returns once the pass is stopped, and later reads do not wait", async (t) => {
  const base = await sandbox(t);
  await writeRecord(base, REPO, "held", 8 * DAY);
  let heldUp = false;
  const neverSettles = new Promise<void>(() => {});
  const fileSystem: ReviewCleanupFileSystem = {
    ...nodeReviewCleanupFileSystem,
    async rename(from, to) {
      await nodeReviewCleanupFileSystem.rename(from, to);
      // The pass's next step never finishes (a stuck file system).
      heldUp = true;
      await neverSettles;
    },
  };
  const cleanup = session(fileSystem);
  const store = createReviewStore(base, undefined, { cleanup });
  await store.load(OTHER, targetKey(target("none")));
  for (let waited = 0; waited < 2000 && !heldUp; waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(heldUp, true, "the record is held in quarantine");
  let loaded = false;
  const loading = store.load(REPO, targetKey(target("held"))).then((record) => {
    loaded = true;
    return record;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loaded, false, "the read waits while the pass holds the record");
  cleanup.stop();
  const within = await Promise.race([
    loading.then(() => "returned"),
    new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 1000)),
  ]);
  assert.equal(within, "returned", "stop releases the waiting read");
  const later = await Promise.race([
    store.list(REPO).then(() => "returned"),
    new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 1000)),
  ]);
  assert.equal(later, "returned", "a read after stop proceeds at once");
});
