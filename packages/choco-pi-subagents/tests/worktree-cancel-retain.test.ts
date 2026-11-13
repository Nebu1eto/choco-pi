import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { cleanupWorktree, createWorktree } from "../src/worktree.ts";

const run = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function dirtyWorktree(t: TestContext) {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "worktree-retain-")));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = async (cwd: string, ...args: string[]) =>
    (
      await run(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
        { cwd },
      )
    ).stdout.trim();
  await git(repo, "init", "-q");
  await writeFile(join(repo, "README.md"), "fixture\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "init");
  const worktree = await createWorktree(repo, "retain");
  assert.ok(worktree, "worktree created");
  t.after(() => rm(worktree.path, { recursive: true, force: true }));
  await writeFile(join(worktree.path, "partial.txt"), "partial\n");
  return { repo, worktree, git };
}

test("retain leaves a dirty worktree untouched", async (t) => {
  const { repo, worktree, git } = await dirtyWorktree(t);
  const headBefore = await git(worktree.path, "rev-parse", "HEAD");
  const countBefore = await git(repo, "rev-list", "--all", "--count");
  const result = await cleanupWorktree(repo, worktree, "task", "retain");
  assert.deepEqual(result, { hasChanges: true, path: worktree.path, retained: true });
  assert.equal(await exists(join(worktree.path, "partial.txt")), true);
  assert.equal(await git(worktree.path, "rev-parse", "HEAD"), headBefore);
  assert.equal(await git(repo, "rev-list", "--all", "--count"), countBefore);
  assert.match(await git(worktree.path, "status", "--porcelain"), /\?\? partial\.txt/);
});

test("settle still commits to a branch and removes the worktree", async (t) => {
  const { repo, worktree } = await dirtyWorktree(t);
  const result = await cleanupWorktree(repo, worktree, "task", "settle");
  assert.equal(result.hasChanges, true);
  assert.equal(result.retained, undefined);
  assert.equal(result.branch, "pi-agent-retain");
  assert.equal(await exists(worktree.path), false);
});
