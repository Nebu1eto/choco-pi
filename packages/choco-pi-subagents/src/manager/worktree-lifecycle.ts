/**
 * worktree-lifecycle.ts — Internal AgentManager module extracted from agent-manager.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../types.ts";
import { cleanupWorktree, type WorktreeDisposition } from "../worktree.ts";
import {
  retainedWorktreeNotice,
  removeHookWorktree,
  cancellationForGeneration,
  type AdoptedWorktree,
  type ManagerState,
} from "./state.ts";
import { recordsVerdict, recordRunVerdict } from "./verdict-recording.ts";

/**
 * Point a revived record at its original worktree (no new one is created);
 * returns the working path inside it. Idempotent.
 */
export function applyAdoptedWorktree(
  mgr: ManagerState,
  record: AgentRecord,
  adopt: AdoptedWorktree,
): string {
  const workPath = adopt.workPath ?? adopt.path;
  record.worktree = {
    path: adopt.path,
    branch: adopt.branch,
    baseSha: adopt.baseSha,
    workPath,
    hookManaged: adopt.hookManaged,
  };
  record.worktreeRepo = adopt.repo;
  mgr.worktreeRepos.add(adopt.repo);
  return workPath;
}

/** Take the worktree cleanup a parked spawn deferred, exactly once. */
export function takeDeferredWorktree(
  mgr: ManagerState,
  record: AgentRecord,
): (() => Promise<void>) | undefined {
  const finish = mgr.deferredWorktrees.get(record.id);
  if (finish === undefined) return undefined;
  mgr.deferredWorktrees.delete(record.id);
  return finish;
}

/** Run the deferred worktree cleanup, if any; never rejects (like the spawn settle path). */
export async function finishDeferredWorktree(
  mgr: ManagerState,
  record: AgentRecord,
): Promise<void> {
  const finish = takeDeferredWorktree(mgr, record);
  if (finish === undefined) return;
  try {
    await finish();
  } catch {
    /* ignore cleanup errors, like the spawn settle path */
  }
}

/**
 * For settle paths that never reach a runner (stopped while queued or
 * parked, refused at admission, failed to start): run `publish` immediately
 * when nothing is owed, otherwise after the deferred worktree cleanup (which
 * may append the branch note to `record.result`) and, for a verdict-role
 * run not yet recorded, after its verdict record (whose line is appended to
 * `record.result`). A record awaiting publication stays terminal-unpublished
 * meanwhile, which `resumeBlockedByRun` already treats as busy. `publish`
 * runs exactly once.
 */
export function finishDeferredWorktreeThen(
  mgr: ManagerState,
  record: AgentRecord,
  publish: () => void,
): void {
  const finish = takeDeferredWorktree(mgr, record);
  const generation = record.resultGeneration ?? 1;
  const recordVerdict =
    !mgr.disposed && recordsVerdict(mgr, record) && record.verdictRecordedGeneration !== generation;
  if (finish === undefined && !recordVerdict) {
    publish();
    return;
  }
  const settle = async (): Promise<void> => {
    if (finish !== undefined) await finish().catch(() => undefined);
    if (recordVerdict) {
      const line = await recordRunVerdict(
        mgr,
        record,
        generation,
        undefined,
        record.status,
        // A queued stop sets only the cancellation; its reason is the error.
        record.error ?? cancellationForGeneration(record, generation)?.reason,
      );
      if (line !== undefined) {
        record.result = record.result ? `${record.result}\n\n${line}` : line;
      }
    }
    try {
      publish();
    } catch (error) {
      console.warn("[choco-pi-subagents] Settling after worktree cleanup failed:", error);
    }
  };
  void settle();
}

/**
 * Worktree cleanup for a spawn's final outcome. Awaited before the result
 * is published; hook-managed removal completes in the background, as it
 * reports no branch.
 */
export async function cleanupRecordWorktree(
  mgr: ManagerState,
  pi: ExtensionAPI,
  record: AgentRecord,
  baseCwd: string,
  customCwd: string | undefined,
  description: string,
): Promise<void> {
  const worktree = record.worktree;
  if (worktree === undefined) return;
  const disposition = worktreeDispositionFor(mgr, record, record.resultGeneration ?? 1);
  if (worktree.hookManaged === true) {
    if (disposition === "retain") {
      record.worktreeResult = { hasChanges: false, path: worktree.path, retained: true };
      record.result =
        (record.result ?? "") + retainedWorktreeNotice(worktree, record.cancellation?.cause);
      return;
    }
    record.worktreeResult = { hasChanges: false };
    void removeHookWorktree(pi, worktree.path).catch(() => undefined);
    return;
  }
  const wtResult = await cleanupWorktree(baseCwd, worktree, description, disposition);
  record.worktreeResult = wtResult;
  if (wtResult.retained === true) {
    record.result =
      (record.result ?? "") + retainedWorktreeNotice(worktree, record.cancellation?.cause);
  } else if (wtResult.hasChanges && wtResult.branch) {
    const repoNote = customCwd === undefined ? "" : ` in \`${baseCwd}\``;
    record.result =
      (record.result ?? "") +
      `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd === undefined ? "" : ` (run in \`${baseCwd}\`)`}`;
  }
}

/**
 * A cancelled run (any cause but suspend) keeps its worktree untouched; every
 * other settle commits changes to a branch and removes it.
 */
export function worktreeDispositionFor(
  mgr: ManagerState,
  record: AgentRecord,
  generation: number,
): WorktreeDisposition {
  const cancellation = record.cancellation;
  return cancellation?.generation === generation && cancellation.cause !== "suspend"
    ? "retain"
    : "settle";
}
