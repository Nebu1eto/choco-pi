// "Since a turn" source against real git: files edited before the checkpoint and unchanged since are not listed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createDiffStore } from "../.pi/extensions/lib/changes/git/store.ts";

const execFileAsync = promisify(execFile);
const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

async function git(cwd: string, env: Record<string, string>, ...args: string[]): Promise<string> {
  assert.ok(cwd.startsWith(tmpdir()) || cwd.startsWith(`/private${tmpdir()}`), cwd);
  const result = await execFileAsync("git", args, {
    cwd,
    env: { ...FIXTURE_ENV, ...env },
    encoding: "utf8",
  });
  return result.stdout;
}

test("since a turn lists only files changed after the checkpoint, even when they were dirty before it", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "diff-actions-turn-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, {}, "init", "-q", "-b", "main");
  await git(root, {}, "config", "user.name", "Diff Test");
  await git(root, {}, "config", "user.email", "diff@example.test");
  await git(root, {}, "config", "commit.gpgsign", "false");
  await writeFile(join(root, "before.txt"), "one\n");
  await writeFile(join(root, "after.txt"), "one\n");
  await writeFile(join(root, "bin.dat"), new Uint8Array([0, 1, 2]));
  await git(root, {}, "add", "-A");
  await git(root, {}, "commit", "-qm", "base");
  // Uncommitted edits made before the turn, captured by the checkpoint.
  await writeFile(join(root, "before.txt"), "one\ntwo\n");
  await writeFile(join(root, "bin.dat"), new Uint8Array([0, 1, 2, 3]));
  const index = join(root, ".git", "checkpoint-index");
  await git(root, { GIT_INDEX_FILE: index }, "add", "-A");
  const tree = (await git(root, { GIT_INDEX_FILE: index }, "write-tree")).trim();
  // The turn edits one more file.
  await writeFile(join(root, "after.txt"), "one\nchanged\n");

  const store = createDiffStore({
    cwd: root,
    checkpoints: { listTurns: async () => [{ turnIndex: 0, tree, label: "turn 1" }] },
  });
  t.after(() => store.dispose());
  await store.refreshNow();
  let state = store.getState();
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;
  assert.deepEqual(
    state.snapshot.files.map((file) => file.path),
    ["after.txt", "before.txt", "bin.dat"],
    "uncommitted lists every edit",
  );
  store.setSource({ kind: "since-checkpoint", checkpointId: tree, label: "turn 1" });
  await store.refreshNow();
  state = store.getState();
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;
  assert.deepEqual(
    state.snapshot.files.map((file) => [file.path, file.additions, file.deletions]),
    [["after.txt", 1, 0]],
  );
});
