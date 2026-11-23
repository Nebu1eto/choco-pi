import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { pathExists } from "./fs-async.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string, timeout: number): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout, encoding: "utf8" });
  return stdout.trim();
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseSha: string;
  workPath: string;
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

let worktreeIsolationEnabled = true;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export interface WorktreeCleanupResult {
  hasChanges: boolean;
  branch?: string;
  path?: string;
  retained?: true;
}

export type WorktreeDisposition = "settle" | "retain";

export async function createWorktree(
  cwd: string,
  agentId: string,
): Promise<WorktreeInfo | undefined> {
  let baseSha: string;
  let subdir: string;
  try {
    await git(["rev-parse", "--is-inside-work-tree"], cwd, 5000);
    baseSha = await git(["rev-parse", "HEAD"], cwd, 5000);
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
    await git(["worktree", "add", "--detach", worktreePath, "HEAD"], cwd, 30000);
    return {
      path: worktreePath,
      branch,
      baseSha,
      workPath: subdir ? join(worktreePath, subdir) : worktreePath,
    };
  } catch {
    return undefined;
  }
}

export async function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
  disposition: WorktreeDisposition = "settle",
): Promise<WorktreeCleanupResult> {
  if (!(await pathExists(worktree.path))) {
    return { hasChanges: false };
  }

  if (disposition === "retain") {
    let hasChanges = true;
    try {
      hasChanges = (await git(["status", "--porcelain"], worktree.path, 10000)) !== "";
    } catch {}
    return { hasChanges, path: worktree.path, retained: true };
  }

  try {
    const status = await git(["status", "--porcelain"], worktree.path, 10000);

    if (status) {
      await git(["add", "-A"], worktree.path, 10000);
      const safeDesc = agentDescription.slice(0, 200);
      const commitMsg = `pi-agent: ${safeDesc}`;
      await git(["commit", "--no-verify", "-m", commitMsg], worktree.path, 10000);
    } else {
      const currentSha = await git(["rev-parse", "HEAD"], worktree.path, 5000);

      if (currentSha === worktree.baseSha) {
        await removeWorktree(cwd, worktree.path);
        return { hasChanges: false };
      }
    }

    let branchName = worktree.branch;
    try {
      await git(["branch", branchName], worktree.path, 5000);
    } catch {
      branchName = `${worktree.branch}-${Date.now()}`;
      await git(["branch", branchName], worktree.path, 5000);
    }
    worktree.branch = branchName;

    await removeWorktree(cwd, worktree.path);

    return {
      hasChanges: true,
      branch: worktree.branch,
      path: worktree.path,
    };
  } catch {
    try {
      await removeWorktree(cwd, worktree.path);
    } catch {}
    return { hasChanges: false };
  }
}

async function removeWorktree(cwd: string, worktreePath: string): Promise<void> {
  try {
    await git(["worktree", "remove", "--force", worktreePath], cwd, 10000);
  } catch {
    try {
      await git(["worktree", "prune"], cwd, 5000);
    } catch {}
  }
}

export async function pruneWorktrees(cwd: string): Promise<void> {
  try {
    await git(["worktree", "prune"], cwd, 5000);
  } catch {}
}
