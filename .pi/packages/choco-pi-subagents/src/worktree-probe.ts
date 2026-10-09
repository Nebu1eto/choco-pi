/**
 * worktree-probe.ts — async check that a journaled agent worktree still exists.
 *
 * A revived isolated agent must run in its original worktree. Temp
 * directories are swept and `git worktree prune` forgets missing ones, so the
 * probe verifies both the directory and git's registration before revival.
 */

import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;

export type WorktreeProbeResult = { present: true } | { present: false; message: string };

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** Worktree paths from `git worktree list --porcelain`, or undefined if git failed. */
async function listedWorktrees(repo: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: repo,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf8",
    });
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  } catch {
    return undefined;
  }
}

function recoveryHint(info: { branch: string; repo: string }): string {
  return (
    `Work from this agent survives only if branch "${info.branch}" exists in ${info.repo} ` +
    `(check with \`git -C ${info.repo} branch --list ${info.branch}\`); ` +
    "uncommitted changes in a deleted worktree cannot be recovered."
  );
}

/**
 * Present means the directory exists and git in `repo` lists it as a
 * worktree; when git itself fails, a `.git` file in the directory suffices.
 * The missing message names the branch so the user can recover the work.
 */
export async function probeWorktree(info: {
  path: string;
  branch: string;
  repo: string;
}): Promise<WorktreeProbeResult> {
  if (!(await isDirectory(info.path))) {
    return {
      present: false,
      message: `Isolated worktree ${info.path} no longer exists. ${recoveryHint(info)}`,
    };
  }
  const listed = await listedWorktrees(info.repo);
  if (listed === undefined) {
    if (await isFile(join(info.path, ".git"))) return { present: true };
    return {
      present: false,
      message:
        `Isolated worktree ${info.path} could not be verified: git failed in ${info.repo} ` +
        `and the directory is not a git worktree. ${recoveryHint(info)}`,
    };
  }
  const target = await canonical(info.path);
  const canonicalListed = await Promise.all(listed.map(canonical));
  if (canonicalListed.includes(target)) return { present: true };
  return {
    present: false,
    message:
      `Isolated worktree ${info.path} is no longer registered with git in ${info.repo}; ` +
      `its files may remain in that directory. ${recoveryHint(info)}`,
  };
}
