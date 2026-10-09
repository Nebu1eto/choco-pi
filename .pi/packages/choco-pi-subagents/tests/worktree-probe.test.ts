import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { probeWorktree } from "../src/worktree-probe.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

test("probeWorktree reports present, unregistered, and missing worktrees", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-wt-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const worktree = join(root, "wt");
  await execFileAsync("git", ["init", "-q", repo]);
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "test");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "file.txt"), "x\n");
  await git(repo, "add", "file.txt");
  await git(repo, "commit", "-q", "-m", "init");
  await git(repo, "worktree", "add", "-q", "--detach", worktree, "HEAD");

  const branch = "pi-agent-abc";
  assert.deepEqual(await probeWorktree({ path: worktree, branch, repo }), { present: true });

  // git cannot run in a missing repo: a `.git` file in the directory suffices.
  assert.deepEqual(await probeWorktree({ path: worktree, branch, repo: join(root, "no-repo") }), {
    present: true,
  });

  // A plain directory git does not list is not the agent's worktree.
  const plain = await mkdtemp(join(root, "plain-"));
  const unregistered = await probeWorktree({ path: plain, branch, repo });
  assert.equal(unregistered.present, false);
  if (!unregistered.present) {
    assert.match(unregistered.message, /no longer registered/);
    assert.ok(unregistered.message.includes(branch));
  }

  await rm(worktree, { recursive: true, force: true });
  const missing = await probeWorktree({ path: worktree, branch, repo });
  assert.equal(missing.present, false);
  if (!missing.present) {
    assert.match(missing.message, /no longer exists/);
    assert.ok(missing.message.includes(branch));
    assert.ok(missing.message.includes(repo));
  }
});
