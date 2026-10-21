/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { pathExists } from "./fs-async.ts";

const execFileAsync = promisify(execFile);

/** Run git with argv (no shell) and resolve its trimmed stdout; rejects on a non-zero exit or timeout. */
async function git(args: string[], cwd: string, timeout: number): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout, encoding: "utf8" });
  return stdout.trim();
}

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
  /** Worktree path supplied by a Claude-compatible WorktreeCreate hook. */
  hookManaged?: boolean;
}

export async function adoptHookWorktree(
  cwd: string,
  worktreePath: string,
  agentId: string,
): Promise<WorktreeInfo | undefined> {
  try {
    if (!(await pathExists(worktreePath))) return undefined;
    const [baseSha, resolved] = await Promise.all([
      git(["rev-parse", "HEAD"], cwd, 5000),
      realpath(worktreePath),
    ]);
    return {
      path: resolved,
      workPath: resolved,
      branch: `pi-agent-${agentId}`,
      baseSha,
      hookManaged: true,
    };
  } catch {
    return undefined;
  }
}

/**
 * Project-wide switch for worktree isolation (`worktreeIsolation` in
 * subagents.json). Default `true` — unchanged behaviour.
 *
 * The `"off"` isolation value gives a model a legal way to decline a worktree,
 * but it still depends on the model choosing it. This is the deterministic half
 * of the same fix: on a large repo where every worktree costs real time and
 * disk (#184), turning it off means no caller can create one, whatever it
 * passes.
 */
let worktreeIsolationEnabled = true;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export interface WorktreeCleanupResult {
  /** Whether changes were found in the worktree. */
  hasChanges: boolean;
  /** Branch name if changes were committed. */
  branch?: string;
  /** Worktree path if it was kept. */
  path?: string;
}

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export async function createWorktree(
  cwd: string,
  agentId: string,
): Promise<WorktreeInfo | undefined> {
  // Verify we're in a git repo with at least one commit (HEAD must exist)
  let baseSha: string;
  let subdir: string;
  try {
    await git(["rev-parse", "--is-inside-work-tree"], cwd, 5000);
    baseSha = await git(["rev-parse", "HEAD"], cwd, 5000);
    // Where cwd sits inside the repo ("" at the root): the agent must work at
    // the same subdirectory inside the copy, or a monorepo-package cwd would
    // silently widen to the whole repo. realpath both sides — git emits
    // resolved paths while cwd may arrive through a symlink (macOS /tmp).
    const topLevel = await git(["rev-parse", "--show-toplevel"], cwd, 5000);
    const [realTop, realCwd] = await Promise.all([realpath(topLevel), realpath(cwd)]);
    subdir = relative(realTop, realCwd);
  } catch {
    return undefined;
  }

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

  try {
    // Create detached worktree at HEAD
    await git(["worktree", "add", "--detach", worktreePath, "HEAD"], cwd, 30000);
    return {
      path: worktreePath,
      branch,
      baseSha,
      workPath: subdir ? join(worktreePath, subdir) : worktreePath,
    };
  } catch {
    // If worktree creation fails, return undefined (agent runs in normal cwd)
    return undefined;
  }
}

/**
 * Clean up a worktree after agent completion.
 * - If no changes: remove worktree entirely.
 * - If changes exist: create a branch, commit changes, return branch info.
 */
export async function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): Promise<WorktreeCleanupResult> {
  if (!(await pathExists(worktree.path))) {
    return { hasChanges: false };
  }

  try {
    // Check for uncommitted changes in the worktree
    const status = await git(["status", "--porcelain"], worktree.path, 10000);

    if (status) {
      // Changes exist — stage, commit, and create a branch
      await git(["add", "-A"], worktree.path, 10000);
      // Truncate description for commit message (no shell sanitization needed — execFile uses argv)
      const safeDesc = agentDescription.slice(0, 200);
      const commitMsg = `pi-agent: ${safeDesc}`;
      await git(["commit", "--no-verify", "-m", commitMsg], worktree.path, 10000);
    } else {
      const currentSha = await git(["rev-parse", "HEAD"], worktree.path, 5000);

      if (currentSha === worktree.baseSha) {
        // No changes — remove worktree
        await removeWorktree(cwd, worktree.path);
        return { hasChanges: false };
      }
    }

    // Create a branch pointing to the worktree's HEAD.
    // If the branch already exists, append a suffix to avoid overwriting previous work.
    let branchName = worktree.branch;
    try {
      await git(["branch", branchName], worktree.path, 5000);
    } catch {
      // Branch already exists — use a unique suffix
      branchName = `${worktree.branch}-${Date.now()}`;
      await git(["branch", branchName], worktree.path, 5000);
    }
    // Update branch name in worktree info for the caller
    worktree.branch = branchName;

    // Remove the worktree (branch persists in main repo)
    await removeWorktree(cwd, worktree.path);

    return {
      hasChanges: true,
      branch: worktree.branch,
      path: worktree.path,
    };
  } catch {
    // Best effort cleanup on error
    try {
      await removeWorktree(cwd, worktree.path);
    } catch {
      /* ignore */
    }
    return { hasChanges: false };
  }
}

/**
 * Force-remove a worktree.
 */
async function removeWorktree(cwd: string, worktreePath: string): Promise<void> {
  try {
    await git(["worktree", "remove", "--force", worktreePath], cwd, 10000);
  } catch {
    // If git worktree remove fails, try pruning
    try {
      await git(["worktree", "prune"], cwd, 5000);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export async function pruneWorktrees(cwd: string): Promise<void> {
  try {
    await git(["worktree", "prune"], cwd, 5000);
  } catch {
    /* ignore */
  }
}
