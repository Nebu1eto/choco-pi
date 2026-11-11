import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TestContext } from "node:test";
import {
  cleanupReviewRecords,
  nodeReviewCleanupFileSystem,
  REVIEW_RECORD_MAX_AGE_MS,
  type ReviewCleanupFileSystem,
  type ReviewCleanupOptions,
  type ReviewCleanupResult,
} from "../.pi/extensions/review/core/store-cleanup.ts";
import { isStoredReviewRecord, repoKey, targetKey } from "../.pi/extensions/review/core/store.ts";
import type { ReviewRecord, ReviewTarget } from "../.pi/extensions/review/core/types.ts";
import test from "node:test";

const NOW = Date.parse("2026-03-10T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

async function sandbox(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "review-store-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = join(directory, "reviews");
  await mkdir(base);
  return base;
}

function record(repository: string, target: ReviewTarget, updatedAt: string): ReviewRecord {
  return {
    version: 1,
    repoKey: repository,
    target,
    baseSha: "base",
    headSha: "head",
    cursor: { reviewedHunkIds: [], lastHeadSha: "head" },
    comments: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

async function age(path: string, ageMs: number): Promise<void> {
  const seconds = (NOW - ageMs) / 1000;
  await utimes(path, seconds, seconds);
}

/** Write a store-shaped record whose file mtime is `ageMs` before NOW. */
async function writeRecord(
  base: string,
  repository: string,
  branch: string,
  ageMs: number,
  updatedAt = "2026-03-01T00:00:00.000Z",
): Promise<string> {
  const target: ReviewTarget = { kind: "branch", base: branch };
  const directory = join(base, repository);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${targetKey(target)}.json`);
  await writeFile(path, JSON.stringify(record(repository, target, updatedAt)));
  await age(path, ageMs);
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

function run(
  base: string,
  options: Partial<ReviewCleanupOptions> = {},
): Promise<ReviewCleanupResult> {
  return cleanupReviewRecords({
    baseDirectory: base,
    isRecord: isStoredReviewRecord,
    now: NOW,
    ...options,
  });
}

function hooked(hooks: Partial<ReviewCleanupFileSystem>): ReviewCleanupFileSystem {
  return { ...nodeReviewCleanupFileSystem, ...hooks };
}

function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const REPO = repoKey("/work/alpha");
const OTHER = repoKey("/work/beta");

test("removes records older than seven days and keeps those at or under it", async (t) => {
  const base = await sandbox(t);
  const old = await writeRecord(base, REPO, "eight", 8 * DAY);
  const justOver = await writeRecord(base, REPO, "just-over", REVIEW_RECORD_MAX_AGE_MS + 1000);
  const exactly = await writeRecord(base, REPO, "exactly", REVIEW_RECORD_MAX_AGE_MS);
  const recent = await writeRecord(base, REPO, "six", 6 * DAY);
  const result = await run(base);
  assert.equal(result.removed, 2);
  assert.equal(result.young, 2);
  assert.equal(result.errors, 0);
  assert.equal(await exists(old), false);
  assert.equal(await exists(justOver), false);
  assert.equal(await exists(exactly), true);
  assert.equal(await exists(recent), true);
  assert.equal(REVIEW_RECORD_MAX_AGE_MS, 7 * DAY);
});

test("a future mtime is not old", async (t) => {
  const base = await sandbox(t);
  const future = await writeRecord(base, REPO, "future", -30 * DAY);
  const result = await run(base);
  assert.equal(result.removed, 0);
  assert.equal(result.young, 1);
  assert.equal(await exists(future), true);
});

test("file mtime decides age even when the record's updatedAt disagrees", async (t) => {
  const base = await sandbox(t);
  const freshFileOldStamp = await writeRecord(base, REPO, "a", DAY, "2020-01-01T00:00:00.000Z");
  const oldFileFreshStamp = await writeRecord(base, REPO, "b", 9 * DAY, "2026-03-09T00:00:00.000Z");
  const result = await run(base);
  assert.equal(result.removed, 1);
  assert.equal(await exists(freshFileOldStamp), true);
  assert.equal(await exists(oldFileFreshStamp), false);
});

test("a record modified or replaced after listing is kept", async (t) => {
  const base = await sandbox(t);
  const touched = await writeRecord(base, REPO, "touched", 8 * DAY);
  const replaced = await writeRecord(base, REPO, "replaced", 8 * DAY);
  const fileSystem = hooked({
    async readFile(path) {
      const text = await nodeReviewCleanupFileSystem.readFile(path);
      if (path === touched) await age(touched, 0);
      if (path === replaced) {
        // Another session's atomic save: new inode, then an old mtime again.
        await writeFile(`${replaced}.tmp`, text);
        await rename(`${replaced}.tmp`, replaced);
        await age(replaced, 8 * DAY);
      }
      return text;
    },
    async rename(from, to) {
      moves += 1;
      return nodeReviewCleanupFileSystem.rename(from, to);
    },
  });
  let moves = 0;
  const result = await run(base, { fileSystem });
  assert.equal(result.removed, 0);
  assert.equal(result.changed, 2);
  // The re-check stops before the file is even moved aside.
  assert.equal(moves, 0);
  assert.equal(await exists(touched), true);
  assert.equal(await exists(replaced), true);
});

test("a save that lands between the re-check and the removal is put back", async (t) => {
  const base = await sandbox(t);
  const path = await writeRecord(base, REPO, "raced", 8 * DAY);
  const fileSystem = hooked({
    async rename(from, to) {
      if (from === path) {
        // Another session's atomic save wins the race; its mtime even looks old.
        await writeFile(`${path}.tmp`, "saved by another session");
        await rename(`${path}.tmp`, path);
        await age(path, 8 * DAY);
      }
      return nodeReviewCleanupFileSystem.rename(from, to);
    },
  });
  const result = await run(base, { fileSystem });
  assert.equal(result.removed, 0);
  assert.equal(result.changed, 1);
  assert.equal(result.errors, 0);
  assert.equal(await readFile(path, "utf8"), "saved by another session");
  assert.equal((await readdir(join(base, REPO))).length, 1);
});

test("an even newer save is never overwritten when a raced save is put back", async (t) => {
  const base = await sandbox(t);
  const path = await writeRecord(base, REPO, "raced", 8 * DAY);
  const fileSystem = hooked({
    async rename(from, to) {
      if (from !== path) return nodeReviewCleanupFileSystem.rename(from, to);
      await writeFile(`${path}.tmp`, "first save");
      await rename(`${path}.tmp`, path);
      await nodeReviewCleanupFileSystem.rename(from, to);
      await writeFile(path, "newest save");
    },
  });
  const result = await run(base, { fileSystem });
  assert.equal(result.removed, 0);
  assert.equal(result.changed, 1);
  assert.equal(result.errors, 0);
  assert.equal(await readFile(path, "utf8"), "newest save");
  assert.equal((await readdir(join(base, REPO))).length, 1);
});

test("a record that vanishes during the pass is fine", async (t) => {
  const base = await sandbox(t);
  const gone = await writeRecord(base, REPO, "gone", 8 * DAY);
  const fileSystem = hooked({
    async readFile(path) {
      const text = await nodeReviewCleanupFileSystem.readFile(path);
      await unlink(path);
      return text;
    },
  });
  const result = await run(base, { fileSystem });
  assert.equal(result.vanished, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.removed, 0);
  assert.equal(await exists(gone), false);
});

test("the open review's record is never removed, even when it is old", async (t) => {
  const base = await sandbox(t);
  const open = await writeRecord(base, REPO, "open", 8 * DAY);
  const other = await writeRecord(base, REPO, "other", 8 * DAY);
  const openName = open.slice(open.lastIndexOf("/") + 1);
  const result = await run(base, {
    isProtected: (repository, fileName) => repository === REPO && fileName === openName,
  });
  assert.equal(result.protectedRecords, 1);
  assert.equal(result.removed, 1);
  assert.equal(await exists(open), true);
  assert.equal(await exists(other), false);
});

test("a record protected after listing is kept by the pre-removal check", async (t) => {
  const base = await sandbox(t);
  const open = await writeRecord(base, REPO, "open", 8 * DAY);
  let opened = false;
  const fileSystem = hooked({
    async readFile(path) {
      opened = true;
      return nodeReviewCleanupFileSystem.readFile(path);
    },
  });
  const result = await run(base, { fileSystem, isProtected: () => opened });
  assert.equal(result.protectedRecords, 1);
  assert.equal(await exists(open), true);
});

test("an unreadable record is left alone and counted", async (t) => {
  const base = await sandbox(t);
  const locked = await writeRecord(base, REPO, "locked", 8 * DAY);
  await chmod(locked, 0o000);
  t.after(() => chmod(locked, 0o600).catch(() => undefined));
  await age(locked, 8 * DAY);
  const result = await run(base);
  assert.equal(result.errors, 1);
  assert.equal(result.removed, 0);
  assert.equal(await exists(locked), true);
});

test("record-named files that are not records of this store are left alone", async (t) => {
  const base = await sandbox(t);
  const directory = join(base, REPO);
  await mkdir(directory, { recursive: true });
  const target: ReviewTarget = { kind: "branch", base: "main" };
  const name = `${targetKey(target)}.json`;
  const broken = join(directory, name);
  await writeFile(broken, "{ not json");
  await age(broken, 8 * DAY);
  const foreignJson = join(directory, `${targetKey({ kind: "pr", number: 7 })}.json`);
  await writeFile(foreignJson, JSON.stringify({ hello: "world" }));
  await age(foreignJson, 8 * DAY);
  // A valid record stored under another repository's directory.
  const misplaced = join(base, OTHER, name);
  await mkdir(join(base, OTHER));
  await writeFile(misplaced, JSON.stringify(record(REPO, target, "2026-01-01T00:00:00.000Z")));
  await age(misplaced, 8 * DAY);
  const result = await run(base);
  assert.equal(result.invalid, 3);
  assert.equal(result.removed, 0);
  assert.equal(await exists(broken), true);
  assert.equal(await exists(foreignJson), true);
  assert.equal(await exists(misplaced), true);
});

test("unknown names, nested directories and temporary files are left alone", async (t) => {
  const base = await sandbox(t);
  const recordPath = await writeRecord(base, REPO, "main", 8 * DAY);
  const directory = join(base, REPO);
  const notes = join(directory, "notes.json");
  await writeFile(notes, "{}");
  await age(notes, 30 * DAY);
  const temporary = `${recordPath}.123.abc.tmp`;
  await writeFile(temporary, "{}");
  await age(temporary, 30 * DAY);
  const nested = join(directory, "worktrees", "pr-7");
  await mkdir(nested, { recursive: true });
  const nestedRecord = join(
    directory,
    "worktrees",
    recordPath.slice(recordPath.lastIndexOf("/") + 1),
  );
  await writeFile(nestedRecord, "{}");
  await age(nestedRecord, 30 * DAY);
  const directoryNamedLikeRecord = join(directory, `${targetKey({ kind: "pr", number: 9 })}.json`);
  await mkdir(directoryNamedLikeRecord);
  const unknownTop = join(base, "README");
  await writeFile(unknownTop, "x");
  await age(unknownTop, 30 * DAY);
  const unknownDirectory = join(base, "not-a-repo-key");
  await mkdir(unknownDirectory);
  const result = await run(base);
  assert.equal(result.removed, 1);
  // notes, temporary, worktrees, record-named directory, README, not-a-repo-key
  assert.equal(result.foreign, 6);
  assert.equal(result.removedDirectories, 0);
  for (const path of [
    notes,
    temporary,
    nested,
    nestedRecord,
    directoryNamedLikeRecord,
    unknownTop,
    unknownDirectory,
  ])
    assert.equal(await exists(path), true, path);
});

test("a symlink in place of a record is neither followed nor removed", async (t) => {
  const base = await sandbox(t);
  // A valid, old record of the same repository, outside the base.
  const outside = await writeRecord(join(base, "..", "outside-base"), REPO, "main", 8 * DAY);
  const directory = join(base, REPO);
  await mkdir(directory);
  const link = join(directory, outside.slice(outside.lastIndexOf("/") + 1));
  await symlink(outside, link);
  const result = await run(base);
  assert.equal(result.foreign, 1);
  assert.equal(result.removed, 0);
  assert.equal(await exists(link), true);
  assert.equal(await exists(outside), true);
});

test("a symlink in place of a repository directory is not followed", async (t) => {
  const base = await sandbox(t);
  const outsideBase = join(base, "..", "outside-base");
  const outside = await writeRecord(outsideBase, REPO, "main", 8 * DAY);
  await symlink(join(outsideBase, REPO), join(base, REPO));
  const result = await run(base);
  assert.equal(result.foreign, 1);
  assert.equal(result.removed, 0);
  assert.equal(await exists(outside), true);
});

test("a symlinked base directory stops the pass", async (t) => {
  const base = await sandbox(t);
  const real = await writeRecord(base, REPO, "main", 8 * DAY);
  const link = join(base, "..", "linked-reviews");
  await symlink(base, link);
  const result = await run(link);
  assert.equal(result.skippedBase, "symlink");
  assert.equal(result.examined, 0);
  assert.equal(await exists(real), true);
});

test("a missing base directory is a quiet no-op", async (t) => {
  const base = await sandbox(t);
  const result = await run(join(base, "absent"));
  assert.equal(result.skippedBase, "missing");
  assert.equal(result.errors, 0);
});

test("the entry cap bounds a pass and later passes handle the rest", async (t) => {
  const base = await sandbox(t);
  for (const name of ["a", "b", "c", "d", "e"]) await writeRecord(base, REPO, name, 8 * DAY);
  const first = await run(base, { maxEntries: 3 });
  assert.equal(first.examined, 3);
  assert.equal(first.capped, true);
  assert.equal(first.removed, 2);
  assert.equal((await readdir(join(base, REPO))).length, 3);
  let passes = 1;
  while ((await exists(join(base, REPO))) && passes < 10) {
    await run(base, { maxEntries: 3 });
    passes += 1;
  }
  assert.equal(await exists(join(base, REPO)), false);
  assert.equal(await exists(base), true);
});

test("an emptied repository directory is removed; a non-empty one and the base are kept", async (t) => {
  const base = await sandbox(t);
  await writeRecord(base, REPO, "old", 8 * DAY);
  const kept = await writeRecord(base, OTHER, "young", DAY);
  await writeRecord(base, OTHER, "old", 8 * DAY);
  const alreadyEmpty = join(base, repoKey("/work/empty"));
  await mkdir(alreadyEmpty);
  const result = await run(base);
  assert.equal(result.removed, 2);
  assert.equal(result.removedDirectories, 1);
  assert.equal(await exists(join(base, REPO)), false);
  assert.equal(await exists(kept), true);
  // Only directories this pass emptied are removed.
  assert.equal(await exists(alreadyEmpty), true);
  assert.equal(await exists(base), true);
});

test("two sessions cleaning the same directory at once neither fail nor over-remove", async (t) => {
  const base = await sandbox(t);
  const old: string[] = [];
  for (const name of ["a", "b", "c", "d"]) old.push(await writeRecord(base, REPO, name, 8 * DAY));
  const young = await writeRecord(base, REPO, "young", DAY);
  // The same visiting order makes the two passes contend for every record.
  const [left, right] = await Promise.all([
    run(base, { random: () => 0 }),
    run(base, { random: () => 0 }),
  ]);
  assert.equal(left.errors + right.errors, 0);
  assert.equal(left.removed + right.removed, 4);
  for (const path of old) assert.equal(await exists(path), false);
  assert.equal(await exists(young), true);
});

test("a pass stops at its next step once the session is no longer current", async (t) => {
  const base = await sandbox(t);
  const paths: string[] = [];
  for (const name of ["a", "b", "c"]) paths.push(await writeRecord(base, REPO, name, 8 * DAY));
  let current = true;
  const fileSystem = hooked({
    async readFile(path) {
      current = false;
      return nodeReviewCleanupFileSystem.readFile(path);
    },
  });
  const result = await run(base, { fileSystem, isCurrent: () => current });
  assert.equal(result.interrupted, true);
  assert.equal(result.removed, 0);
  for (const path of paths) assert.equal(await exists(path), true);
});

test("filesystem errors are contained per entry and never thrown", async (t) => {
  const base = await sandbox(t);
  const statFails = await writeRecord(base, REPO, "stat", 8 * DAY);
  const readFails = await writeRecord(base, REPO, "read", 8 * DAY);
  const unlinkFails = await writeRecord(base, REPO, "unlink", 8 * DAY);
  const removable = await writeRecord(base, REPO, "ok", 8 * DAY);
  let unlinkFailed = false;
  const fileSystem = hooked({
    async lstat(path) {
      if (path === statFails) throw failure("EIO");
      return nodeReviewCleanupFileSystem.lstat(path);
    },
    async readFile(path) {
      if (path === readFails) throw failure("EIO");
      return nodeReviewCleanupFileSystem.readFile(path);
    },
    async unlink(path) {
      // The first delete of that record fails; the restore that follows succeeds.
      if (path.includes(basename(unlinkFails)) && !unlinkFailed) {
        unlinkFailed = true;
        throw failure("EPERM");
      }
      return nodeReviewCleanupFileSystem.unlink(path);
    },
  });
  const result = await run(base, { fileSystem });
  assert.equal(result.errors, 3);
  assert.equal(result.removed, 1);
  assert.equal(await exists(removable), false);
  assert.equal(await exists(statFails), true);
  assert.equal(await exists(readFails), true);
  assert.equal(await exists(unlinkFails), true);
  // The failed delete was rolled back: no private (hidden) name is left over.
  assert.equal((await readdir(join(base, REPO))).length, 3);

  const listing = await run(base, {
    fileSystem: hooked({
      async list() {
        throw failure("EIO");
      },
    }),
  });
  assert.equal(listing.skippedBase, "error");
  const throwingCallbacks = await run(base, {
    isRecord: () => {
      throw new Error("validator failed");
    },
  });
  assert.equal(throwingCallbacks.errors, 3);
});

test("a record protected while the pass moves it aside is put back, not removed", async (t) => {
  const base = await sandbox(t);
  const path = await writeRecord(base, REPO, "opened-during-rename", 8 * DAY);
  const original = await readFile(path, "utf8");
  let opened = false;
  const fileSystem = hooked({
    async rename(from, to) {
      // The review opens the record while the rename to the quarantine name is pending.
      if (from === path) opened = true;
      return nodeReviewCleanupFileSystem.rename(from, to);
    },
  });
  const result = await run(base, { fileSystem, isProtected: () => opened });
  assert.equal(result.removed, 0);
  assert.equal(result.protectedRecords, 1);
  assert.equal(result.errors, 0);
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal((await readdir(join(base, REPO))).length, 1, "no quarantine file left");
});

test("a record protected during the quarantine check is put back, not removed", async (t) => {
  const base = await sandbox(t);
  const path = await writeRecord(base, REPO, "opened-during-lstat", 8 * DAY);
  let opened = false;
  const fileSystem = hooked({
    async lstat(target) {
      if (target.endsWith(".cleanup")) opened = true;
      return nodeReviewCleanupFileSystem.lstat(target);
    },
  });
  const result = await run(base, { fileSystem, isProtected: () => opened });
  assert.equal(result.removed, 0);
  assert.equal(result.protectedRecords, 1);
  assert.equal(await exists(path), true);
  assert.equal((await readdir(join(base, REPO))).length, 1);
});

test("protection that arrives during the unlink is too late; the record is removed", async (t) => {
  const base = await sandbox(t);
  const path = await writeRecord(base, REPO, "opened-during-unlink", 8 * DAY);
  let opened = false;
  const fileSystem = hooked({
    async unlink(target) {
      if (target.endsWith(".cleanup")) opened = true;
      return nodeReviewCleanupFileSystem.unlink(target);
    },
  });
  const result = await run(base, { fileSystem, isProtected: () => opened });
  assert.equal(result.removed, 1);
  assert.equal(result.protectedRecords, 0);
  assert.equal(await exists(path), false);
});

test("a changed mtime of the moved record still puts it back", async (t) => {
  const base = await sandbox(t);
  const path = await writeRecord(base, REPO, "touched", 8 * DAY);
  const fileSystem = hooked({
    async rename(from, to) {
      await nodeReviewCleanupFileSystem.rename(from, to);
      if (from === path) await age(to, 9 * DAY);
    },
  });
  const result = await run(base, { fileSystem });
  assert.equal(result.removed, 0);
  assert.equal(result.changed, 1);
  assert.equal(await exists(path), true);
  assert.equal((await readdir(join(base, REPO))).length, 1);
});
