import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import {
  captureGitSnapshot,
  CheckpointError,
  CHECKPOINT_RETENTION_ENV,
  checkpointRetentionMs,
  openRepository,
  headDriftSince,
  pruneCheckpointRefs,
  restoreSnapshotFiles,
  sessionCheckpointRef,
  summarizeChanges,
} from "../.pi/extensions/checkpoints/git-snapshot.ts";
import { buildTurnTimeline, type SessionTurn } from "../.pi/extensions/checkpoints/turns.ts";

const execFileAsync = promisify(execFile);
const REF = sessionCheckpointRef("test-session");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-checkpoint-"));
  await git(root, "init", "-q", "-b", "main", ".");
  await writeFile(path.join(root, ".gitignore"), "ignored/\n");
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  await mkdir(path.join(root, "ignored"), { recursive: true });
  await writeFile(path.join(root, "ignored", "artifact.bin"), "keep me\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "base");
  return root;
}

function capture(root: string, previous?: Awaited<ReturnType<typeof captureGitSnapshot>>) {
  return captureGitSnapshot(root, { ref: REF, message: "test checkpoint", previous });
}

test("a snapshot restores staged, unstaged, untracked, and deleted state exactly", async (t) => {
  const root = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(path.join(root, "staged.txt"), "staged content\n");
  await git(root, "add", "staged.txt");
  await writeFile(path.join(root, "tracked.txt"), "modified after commit\n");
  await mkdir(path.join(root, "nested", "deep"), { recursive: true });
  await writeFile(path.join(root, "nested", "deep", "untracked.txt"), "untracked\n");

  const before = await capture(root);
  const beforeStatus = await git(root, "status", "--porcelain=v1");

  await writeFile(path.join(root, "tracked.txt"), "clobbered\n");
  await writeFile(path.join(root, "staged.txt"), "clobbered too\n");
  await git(root, "add", "-A");
  await rm(path.join(root, "nested"), { recursive: true, force: true });
  await writeFile(path.join(root, "appeared.txt"), "created later\n");
  await mkdir(path.join(root, "later"), { recursive: true });
  await writeFile(path.join(root, "later", "extra.txt"), "created later\n");

  const after = await capture(root, before);
  await restoreSnapshotFiles(root, before, after);

  assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "modified after commit\n");
  assert.equal(await readFile(path.join(root, "staged.txt"), "utf8"), "staged content\n");
  assert.equal(
    await readFile(path.join(root, "nested", "deep", "untracked.txt"), "utf8"),
    "untracked\n",
  );
  assert.equal(existsSync(path.join(root, "appeared.txt")), false);
  assert.equal(existsSync(path.join(root, "later")), false, "empty directories are pruned");
  assert.equal(await git(root, "status", "--porcelain=v1"), beforeStatus);
  assert.equal(
    await readFile(path.join(root, "ignored", "artifact.bin"), "utf8"),
    "keep me\n",
    "ignored files are never touched",
  );
});

test("capture succeeds while another Git process holds the index lock", async (t) => {
  const root = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await openRepository(root);
  const lockFile = `${repository.indexFile}.lock`;
  await writeFile(lockFile, "");
  t.after(() => rm(lockFile, { force: true }));

  await writeFile(path.join(root, "tracked.txt"), "changed under a lock\n");
  const snapshot = await capture(root);

  assert.ok(snapshot.commit, "a checkpoint commit is recorded");
  assert.equal(
    await git(root, "cat-file", "blob", `${snapshot.worktreeTree}:tracked.txt`),
    "changed under a lock",
  );
});

test("capture and restore survive an unmerged index", async (t) => {
  const root = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));

  await git(root, "checkout", "-qb", "other");
  await writeFile(path.join(root, "tracked.txt"), "other branch\n");
  await git(root, "commit", "-qam", "other");
  await git(root, "checkout", "-q", "main");
  await writeFile(path.join(root, "tracked.txt"), "main branch\n");
  await git(root, "commit", "-qam", "main");
  await git(root, "merge", "other").catch(() => undefined);
  assert.match(await git(root, "status", "--porcelain=v1"), /^UU /m);

  const conflicted = await capture(root);
  assert.equal(conflicted.indexTree, undefined, "an unmerged index has no tree");
  assert.ok(conflicted.indexBlob, "the raw index is still recorded");

  await writeFile(path.join(root, "tracked.txt"), "resolved\n");
  await git(root, "add", "tracked.txt");
  const resolved = await capture(root, conflicted);

  await restoreSnapshotFiles(root, conflicted, resolved);
  assert.match(
    await git(root, "status", "--porcelain=v1"),
    /^UU /m,
    "the conflict stages come back",
  );
});

test("an unchanged working tree reuses the previous checkpoint commit", async (t) => {
  const root = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await capture(root);
  const second = await capture(root, first);
  assert.equal(second.commit, first.commit);

  await writeFile(path.join(root, "tracked.txt"), "moved on\n");
  const third = await capture(root, second);
  assert.notEqual(third.commit, first.commit);
  assert.equal(await git(root, "rev-parse", REF), third.commit);
});

test("a resumed session keeps its earlier checkpoints reachable", async (t) => {
  const root = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(path.join(root, "tracked.txt"), "turn one\n");
  const first = await capture(root);
  await writeFile(path.join(root, "tracked.txt"), "turn two\n");
  const second = await capture(root, first);

  // Restarting Pi and resuming drops the in-memory chain, but the session's own
  // entries still point at both commits above.
  await writeFile(path.join(root, "tracked.txt"), "turn three\n");
  const resumed = await capture(root);

  for (const earlier of [first, second]) {
    await assert.doesNotReject(
      execFileAsync("git", ["merge-base", "--is-ancestor", earlier.commit ?? "", REF], {
        cwd: root,
      }),
      `${earlier.commit} must stay reachable from the session ref`,
    );
  }
  assert.equal(await git(root, "rev-parse", REF), resumed.commit);
  assert.equal(
    await git(root, "fsck", "--unreachable", "--no-reflogs"),
    "",
    "no checkpoint object is orphaned",
  );
});

test("two sessions in one working tree keep separate chains", async (t) => {
  const root = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const otherRef = sessionCheckpointRef("other-session");

  const options = (ref: string, message: string) => ({ ref, message });
  await writeFile(path.join(root, "tracked.txt"), "round one\n");
  const [a1, b1] = await Promise.all([
    captureGitSnapshot(root, options(REF, "a1")),
    captureGitSnapshot(root, options(otherRef, "b1")),
  ]);
  await writeFile(path.join(root, "tracked.txt"), "round two\n");
  const [a2, b2] = await Promise.all([
    captureGitSnapshot(root, { ...options(REF, "a2"), previous: a1 }),
    captureGitSnapshot(root, { ...options(otherRef, "b2"), previous: b1 }),
  ]);

  assert.equal(await git(root, "rev-parse", REF), a2.commit);
  assert.equal(await git(root, "rev-parse", otherRef), b2.commit);
  assert.notEqual(a2.commit, b2.commit);
  await assert.doesNotReject(
    execFileAsync("git", ["merge-base", "--is-ancestor", a1.commit ?? "", REF], { cwd: root }),
  );
  await assert.rejects(
    execFileAsync("git", ["merge-base", "--is-ancestor", b1.commit ?? "", REF], { cwd: root }),
    "one session's ref never picks up another session's chain",
  );
});

test("captures racing on one ref all land in the same chain", async (t) => {
  const root = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(path.join(root, "tracked.txt"), "contended\n");
  const racers = Array.from({ length: 6 }, (_, index) =>
    captureGitSnapshot(root, { ref: REF, message: `racer ${index}` }),
  );
  const snapshots = await Promise.all(racers);

  for (const snapshot of snapshots) {
    await assert.doesNotReject(
      execFileAsync("git", ["merge-base", "--is-ancestor", snapshot.commit ?? "", REF], {
        cwd: root,
      }),
      "a lost compare-and-swap must retry rather than drop the checkpoint",
    );
  }
});

test("summarizeChanges counts files and lines between two snapshots", async (t) => {
  const root = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));

  const before = await capture(root);
  await writeFile(path.join(root, "tracked.txt"), "one\ntwo\nthree\n");
  await writeFile(path.join(root, "new.txt"), "added\n");
  const after = await capture(root, before);

  assert.deepEqual(await summarizeChanges(root, before, after), {
    added: 4,
    deleted: 1,
    files: 2,
  });
});

test("pruning drops aged checkpoint refs and keeps the active one", async (t) => {
  const root = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));

  const snapshot = await capture(root);
  const staleRef = sessionCheckpointRef("stale-session");
  await git(root, "update-ref", staleRef, snapshot.commit ?? "");

  assert.equal(await pruneCheckpointRefs(root, { maxAgeMs: 60_000, keepRef: REF }), 0);
  assert.equal(await pruneCheckpointRefs(root, { maxAgeMs: -1, keepRef: REF }), 1);
  assert.equal(await git(root, "rev-parse", "--verify", "--quiet", REF), snapshot.commit);
});

test("retention defaults to two weeks and honours the environment override", () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(checkpointRetentionMs({}), 14 * day);
  assert.equal(checkpointRetentionMs({ [CHECKPOINT_RETENTION_ENV]: "3" }), 3 * day);
  assert.equal(checkpointRetentionMs({ [CHECKPOINT_RETENTION_ENV]: "0" }), 0);
  assert.equal(checkpointRetentionMs({ [CHECKPOINT_RETENTION_ENV]: "nonsense" }), 14 * day);
});

test("head drift is reported only once commits land after the checkpoint", async (t) => {
  const root = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));

  const snapshot = await capture(root);
  assert.equal(await headDriftSince(root, snapshot.head), undefined, "HEAD has not moved yet");

  await writeFile(path.join(root, "tracked.txt"), "committed later\n");
  await git(root, "commit", "-qam", "later");
  assert.deepEqual(await headDriftSince(root, snapshot.head), { commits: 1 });
});

test("a directory without a Git repository reports an unsupported working tree", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-plain-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(capture(root), (error: RuntimeValue) => {
    assert.ok(error instanceof CheckpointError);
    assert.equal(error.kind, "unsupported");
    return true;
  });
});

test("the timeline charges each turn with the changes made until the next one", async (t) => {
  const root = await createRepository();
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await capture(root);
  await writeFile(path.join(root, "tracked.txt"), "one\ntwo\n");
  const second = await capture(root, first);
  await writeFile(path.join(root, "late.txt"), "still uncommitted\n");

  const turns: SessionTurn[] = [
    {
      entryId: "user-1",
      index: 1,
      label: "first",
      timestamp: first.commit ?? "",
      checkpoint: { ...first, version: 2, timestamp: "", turnIndex: 0, label: "first" },
    },
    { entryId: "user-2", index: 2, label: "uncheckpointed", timestamp: "" },
    {
      entryId: "user-3",
      index: 3,
      label: "second",
      timestamp: "",
      checkpoint: { ...second, version: 2, timestamp: "", turnIndex: 1, label: "second" },
    },
  ];

  const live = await capture(root, second);
  const timeline = await buildTurnTimeline(root, turns, live);

  assert.deepEqual(timeline[0]?.changes, { added: 2, deleted: 1, files: 1 });
  assert.equal(timeline[1]?.changes, undefined, "a turn without a checkpoint has no diff");
  assert.deepEqual(timeline[2]?.changes, { added: 1, deleted: 0, files: 1 });
});
