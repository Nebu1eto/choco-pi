/**
 * stop-cancellation.ts — Internal AgentManager module extracted from agent-manager.ts.
 */

import { unregisterChildSessionId } from "../child-context.ts";
import { unregisterScratchRoot } from "@choco-pi/shared/scratch-path";
import { cleanupChildSessionOwner, emitChildSessionShutdown } from "../child-session-cleanup.ts";
import { releaseSessionFile } from "../session-file-ownership.ts";
import type { AgentRecord, StopWorkflowPort, UserStopResult } from "../types.ts";
import { pruneWorktrees } from "../worktree.ts";
import {
  MAX_TOMBSTONES,
  ownsUnsettledGeneration,
  type ManagerState,
  transition,
  publishTerminal,
  releaseTerminalWaiters,
  awaitTerminal,
  recordRoot,
  requestCancellation,
} from "./state.ts";
import { finishDeferredWorktree, finishDeferredWorktreeThen } from "./worktree-lifecycle.ts";
import { putDormant, retireJournal } from "./revival-journal.ts";
import { settleParked, cancelUsageLimitWaits } from "./usage-limit-park.ts";
import { stopQueuedRecord, publishStoppedQueued, drainQueue } from "./admission-queue.ts";
import { suspendNow } from "./suspend-revival.ts";

/**
 * Explicit stop (stop_subagent, UI, RPC). Marks the record `stoppedByUser`
 * so durable revival never restarts it.
 */
export function abort(mgr: ManagerState, id: string): boolean {
  const record = mgr.agents.get(id);
  if (!record) return false;
  return stopRecord(mgr, record, true);
}

/**
 * User `/stop` (all): cancel the root's running workflows first, then stop every queued,
 * parked and running record of that root, nested ones included. Everything that revokes
 * work happens synchronously; only `settled` is asynchronous. Never the shutdown path.
 */
export function stopAllForRoot(
  mgr: ManagerState,
  rootSessionId: string,
  workflows?: StopWorkflowPort,
): UserStopResult {
  const owned = [...mgr.agents.values()].filter(
    (record) => recordRoot(mgr, record) === rootSessionId,
  );
  const workflowIds = new Set(workflows?.runningFor(rootSessionId) ?? []);
  for (const record of owned)
    if (record.workflowId !== undefined) workflowIds.add(record.workflowId);
  return stopTargets(mgr, owned, workflowIds, workflows);
}

/**
 * User `/stop agent <ref>`: the record and every descendant. Nested refs are allowed here
 * (the LLM-facing `stop_subagent` keeps refusing them). A workflow step cancels its workflow.
 */
export function stopTreeForUser(
  mgr: ManagerState,
  record: AgentRecord,
  workflows?: StopWorkflowPort,
): UserStopResult {
  const tree = new Map<string, AgentRecord>([[record.id, record]]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of mgr.agents.values()) {
      if (
        !tree.has(candidate.id) &&
        candidate.parentAgentId !== undefined &&
        tree.has(candidate.parentAgentId)
      ) {
        tree.set(candidate.id, candidate);
        grew = true;
      }
    }
  }
  const targets = [...tree.values()];
  const workflowIds = new Set<string>();
  for (const target of targets)
    if (target.workflowId !== undefined) workflowIds.add(target.workflowId);
  return stopTargets(mgr, targets, workflowIds, workflows);
}

/** Resolve a user-typed id, handle or alias to a live record, nested records included. */
export function findRecordForStop(mgr: ManagerState, ref: string): AgentRecord | undefined {
  const byId = mgr.agents.get(ref);
  if (byId !== undefined) return byId;
  const wanted = ref.toLowerCase();
  let found: AgentRecord | undefined;
  for (const record of mgr.agents.values()) {
    if (record.handle?.toLowerCase() !== wanted && record.alias?.toLowerCase() !== wanted) continue;
    if (found === undefined || record.startedAt > found.startedAt) found = record;
  }
  return found;
}

export function stopTargets(
  mgr: ManagerState,
  targets: AgentRecord[],
  workflowIds: ReadonlySet<string>,
  workflows: StopWorkflowPort | undefined,
): UserStopResult {
  // Snapshot every child session id before anything settles or is disposed.
  const ownerSessionIds = new Set<string>();
  for (const record of targets) {
    let sessionId: string | undefined;
    try {
      sessionId = record.session?.sessionManager?.getSessionId?.();
    } catch {
      sessionId = undefined;
    }
    if (sessionId !== undefined && sessionId !== "") ownerSessionIds.add(sessionId);
  }
  // Workflows first, so no pending step can start while its agents are being stopped.
  let cancelledWorkflows = 0;
  if (workflows !== undefined) {
    for (const workflowId of workflowIds) if (workflows.cancel(workflowId)) cancelledWorkflows++;
  }
  // Deepest first: a child never outlives the stop of its parent by a scheduling accident.
  const ordered = [...targets].sort((a, b) => (b.depth ?? 1) - (a.depth ?? 1));
  const settling: AgentRecord[] = [];
  let stopped = 0;
  for (const record of ordered) {
    if (stopRecord(mgr, record, true)) {
      stopped++;
      settling.push(record);
    } else if (record.status === "stopped" && ownsUnsettledGeneration(record)) {
      // An earlier stop whose run has not published yet: not counted again, still awaited.
      settling.push(record);
    }
  }
  const settled = Promise.all(settling.map((record) => awaitTerminal(mgr, record))).then(() => {
    const retained = new Set<string>();
    for (const record of settling) {
      const result = record.worktreeResult;
      if (result?.retained === true && result.path !== undefined) retained.add(result.path);
    }
    return [...retained];
  });
  return {
    agents: stopped,
    workflows: cancelledWorkflows,
    ownerSessionIds: [...ownerSessionIds],
    records: settling,
    settled,
  };
}

export function stopRecord(mgr: ManagerState, record: AgentRecord, byUser: boolean): boolean {
  const id = record.id;
  // A parked record has no live run: cancel its wait and settle it now, with
  // a terminal usage status so exactly one final event follows the park.
  if (record.status === "waiting_for_reset") {
    if (byUser) record.stoppedByUser = true;
    settleParked(mgr, record, mgr.usageWaits.get(id), {
      status: "stopped",
      usageStatus: "exhausted",
      reason: "Stopped by user request.",
      cause: "user_stop",
      notify: true,
    });
    return true;
  }

  // Remove from queue if queued
  if (record.status === "queued") {
    if (byUser) record.stoppedByUser = true;
    const entry = mgr.queue.find((q) => q.id === id);
    mgr.queue = mgr.queue.filter((q) => q.id !== id);
    stopQueuedRecord(mgr, record, "user_stop", "Stopped by user request.");
    // A queued post-reset continuation still owes the parked task's promise,
    // its publication (after the deferred worktree cleanup) and its one final
    // notification.
    if (entry?.finalize !== undefined) {
      entry.finalize(true);
      return true;
    }
    publishStoppedQueued(mgr, record);
    return true;
  }

  if (record.status !== "running") return false;
  if (byUser) record.stoppedByUser = true;
  requestCancellation(
    mgr,
    record,
    record.resultGeneration ?? 1,
    "user_stop",
    "Stopped by user request.",
  );
  transition(mgr, record, "stopped");
  record.completedAt = Date.now();
  return true;
}

/**
 * Stop the nested children a settled parent owns. Nested records are hidden
 * from the UI and only their owner can consume them, so a child outliving its
 * parent would burn tokens unseen with no way to reach it. Grandchildren are
 * covered transitively — each abort lands in that child's own settle path.
 */
export function abortOwnedChildren(mgr: ManagerState, parentId: string): void {
  for (const [id, record] of mgr.agents) {
    if (record.parentAgentId === parentId && mgr.agents.get(id) === record) {
      stopRecord(mgr, record, false);
    }
  }
}

/** Dispose a record's session and remove it from the map. */
export function removeRecord(
  mgr: ManagerState,
  id: string,
  record: AgentRecord,
  options?: { suspended?: boolean },
): void {
  const suspended = options?.suspended === true;
  // A suspended record is revived or kept dormant from the journal; its
  // worktree is kept for the revival and its name stays with the journal.
  if (suspended) mgr.deferredWorktrees.delete(id);
  else tombstone(mgr, record);
  // The record leaves the map now; its deferred cleanup only affects disk.
  void finishDeferredWorktree(mgr, record);
  // Before the scope and session go: the final snapshot reads both.
  const dormant = retireJournal(mgr, record);
  const wait = mgr.usageWaits.get(id);
  if (wait?.timer !== undefined) clearTimeout(wait.timer);
  mgr.usageWaits.delete(id);
  // The record leaves the map: a user stop waiting on it has nothing more to wait for.
  releaseTerminalWaiters(mgr, record, true);
  mgr.usageScopes.delete(id);
  mgr.wakeRuns.delete(id);
  mgr.revivalArgs.delete(id);
  // Captured now: a revival may claim this id again before disposal ends.
  const claim = mgr.sessionClaims.get(id);
  mgr.sessionClaims.delete(id);
  const releaseClaim = () => {
    if (claim !== undefined) releaseSessionFile(claim.file, claim.token);
  };
  if (record.session) {
    const session = record.session;
    try {
      unregisterChildSessionId(session.sessionManager.getSessionId());
      unregisterScratchRoot(session.sessionManager.getSessionId());
    } catch {
      /* a stub or retired session manager has no id to release */
    }
    cleanupChildSessionOwner(session);
    // Pi's own runtime emits session_shutdown before dispose(); a bare dispose() skips
    // it, so extensions that own per-session processes (the Codex code-mode host and
    // exec bridge, MCP clients) never release them and the children leak. Emit it the
    // same way, then dispose regardless of handler failures.
    const shutdown = emitChildSessionShutdown(session);
    if (shutdown) {
      void shutdown
        .then(() => session.dispose?.())
        .catch(() => undefined)
        .finally(releaseClaim);
    } else {
      try {
        session.dispose?.();
      } finally {
        releaseClaim();
      }
    }
  } else {
    releaseClaim();
  }
  record.session = undefined;
  mgr.agents.delete(id);
  if (dormant !== undefined) putDormant(mgr, dormant);
}

/**
 * Preserve enough of a departing record for `@handle` to reopen its
 * conversation later. Nothing to keep unless it has both a handle to be
 * addressed by and a session file to reopen — an in-memory session leaves no
 * transcript, so the mention would have nothing to continue from.
 */
export function tombstone(mgr: ManagerState, record: AgentRecord): void {
  if (record.parentAgentId !== undefined || !record.handle || !record.sessionFile) return;
  mgr.tombstones.set(record.handle, {
    handle: record.handle,
    alias: record.alias,
    id: record.id,
    type: record.type,
    description: record.description,
    sessionFile: record.sessionFile,
    completedAt: record.completedAt ?? Date.now(),
  });
  // Bound the memory a long session can accumulate. Oldest first, since the
  // agent someone still wants to reach is the one they used most recently.
  while (mgr.tombstones.size > MAX_TOMBSTONES) {
    const oldest = [...mgr.tombstones.values()].reduce((a, b) =>
      a.completedAt <= b.completedAt ? a : b,
    );
    mgr.tombstones.delete(oldest.handle);
  }
}

export function cleanup(mgr: ManagerState) {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [id, record] of mgr.agents) {
    if (record.status === "running" || record.status === "queued") continue;
    if (record.terminalResultGeneration !== record.resultGeneration) continue;
    if ((record.completedAt ?? 0) >= cutoff) continue;
    removeRecord(mgr, id, record);
  }
}

/**
 * Remove all completed/stopped/errored records immediately.
 * Called on session start/switch so tasks from a prior session don't persist.
 * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
 * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
 */
export function clearCompleted(mgr: ManagerState, skipUnconsumed = false): void {
  for (const [id, record] of mgr.agents) {
    if (record.status === "running" || record.status === "queued") continue;
    if (record.terminalResultGeneration !== record.resultGeneration) continue;
    if (skipUnconsumed && !record.resultConsumed) continue;
    removeRecord(mgr, id, record);
  }
  // Unconditional: both callers are session boundaries (`session_start` and
  // `session_before_switch`), and `skipUnconsumed` only spares records whose
  // results the LLM has yet to read — it does not make the sweep partial in
  // the sense that matters here. A new session means new handles, or
  // `@explore` would silently reach an agent the user never started. Claude
  // Code resets its registry on `/clear` for the same reason.
  mgr.tombstones.clear();
}

/** Abort all running and queued agents immediately. */
export function abortAll(mgr: ManagerState): number {
  let count = 0;
  // Parked records settle as stopped; nothing will read a notification now.
  count += cancelUsageLimitWaits(mgr, "Manager shutdown requested.");
  // Clear queued agents first
  for (const queued of mgr.queue) {
    const record = mgr.agents.get(queued.id);
    if (record) {
      stopQueuedRecord(mgr, record, "shutdown", "Manager shutdown requested.");
      // A post-reset continuation publishes through its finalizer, once.
      if (queued.finalize !== undefined) queued.finalize(false);
      else finishDeferredWorktreeThen(mgr, record, () => publishTerminal(mgr, record));
      count++;
    }
  }
  mgr.queue = [];
  // Abort running agents
  for (const record of mgr.agents.values()) {
    if (record.status === "running") {
      requestCancellation(
        mgr,
        record,
        record.resultGeneration ?? 1,
        "shutdown",
        "Manager shutdown requested.",
      );
      transition(mgr, record, "stopped");
      record.completedAt = Date.now();
      count++;
    }
  }
  return count;
}

/** Wait for all running and queued agents to complete (including queued ones). */
export async function waitForAll(mgr: ManagerState): Promise<void> {
  // Loop because drainQueue respects the concurrency limit — as running
  // agents finish they start queued ones, which need awaiting too.
  while (true) {
    drainQueue(mgr);
    const pending = [...mgr.agents.values()]
      .filter(ownsUnsettledGeneration)
      .map((r) => r.promise)
      .filter(Boolean);
    if (pending.length === 0) break;
    await Promise.allSettled(pending);
  }
}

/**
 * Shut the manager down. With `suspend: true`, journaled live records are
 * suspended first (journaled, cancelled without an outcome, worktrees kept);
 * everything else is stopped as before. Suspended runs dispose their
 * sessions and release their files when they settle.
 */
export function dispose(mgr: ManagerState, options?: { suspend?: boolean }) {
  if (options?.suspend === true && !mgr.disposed) suspendNow(mgr);
  mgr.revivalEpoch++;
  mgr.disposed = true;
  for (const record of mgr.agents.values()) releaseTerminalWaiters(mgr, record, true);
  clearInterval(mgr.cleanupInterval);
  for (const controller of mgr.activeRunBudgets) controller.dispose();
  mgr.activeRunBudgets.clear();
  abortAll(mgr);
  for (const [id, record] of mgr.agents) {
    if (
      record.resultGeneration === undefined ||
      record.terminalResultGeneration === record.resultGeneration
    ) {
      removeRecord(mgr, id, record);
    }
  }
  // Prune any orphaned git worktrees (crash recovery). Background git
  // processes: pruneWorktrees never rejects, and dispose() stays synchronous.
  void pruneWorktrees(process.cwd());
  // Also prune repos that caller-supplied cwds created worktrees in — a clean
  // exit with in-flight agents would otherwise leave stale registrations there.
  for (const repo of mgr.worktreeRepos) {
    void pruneWorktrees(repo);
  }
}
