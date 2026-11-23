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

export function abort(mgr: ManagerState, id: string): boolean {
  const record = mgr.agents.get(id);
  if (!record) return false;
  return stopRecord(mgr, record, true);
}

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
  let cancelledWorkflows = 0;
  if (workflows !== undefined) {
    for (const workflowId of workflowIds) if (workflows.cancel(workflowId)) cancelledWorkflows++;
  }
  const ordered = [...targets].sort((a, b) => (b.depth ?? 1) - (a.depth ?? 1));
  const settling: AgentRecord[] = [];
  let stopped = 0;
  for (const record of ordered) {
    if (stopRecord(mgr, record, true)) {
      stopped++;
      settling.push(record);
    } else if (record.status === "stopped" && ownsUnsettledGeneration(record)) {
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

  if (record.status === "queued") {
    if (byUser) record.stoppedByUser = true;
    const entry = mgr.queue.find((q) => q.id === id);
    mgr.queue = mgr.queue.filter((q) => q.id !== id);
    stopQueuedRecord(mgr, record, "user_stop", "Stopped by user request.");
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

export function abortOwnedChildren(mgr: ManagerState, parentId: string): void {
  for (const [id, record] of mgr.agents) {
    if (record.parentAgentId === parentId && mgr.agents.get(id) === record) {
      stopRecord(mgr, record, false);
    }
  }
}

export function removeRecord(
  mgr: ManagerState,
  id: string,
  record: AgentRecord,
  options?: { suspended?: boolean },
): void {
  const suspended = options?.suspended === true;
  if (suspended) mgr.deferredWorktrees.delete(id);
  else tombstone(mgr, record);
  void finishDeferredWorktree(mgr, record);
  const dormant = retireJournal(mgr, record);
  const wait = mgr.usageWaits.get(id);
  if (wait?.timer !== undefined) clearTimeout(wait.timer);
  mgr.usageWaits.delete(id);
  releaseTerminalWaiters(mgr, record, true);
  mgr.usageScopes.delete(id);
  mgr.wakeRuns.delete(id);
  mgr.revivalArgs.delete(id);
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
    } catch {}
    cleanupChildSessionOwner(session);
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

export function clearCompleted(mgr: ManagerState, skipUnconsumed = false): void {
  for (const [id, record] of mgr.agents) {
    if (record.status === "running" || record.status === "queued") continue;
    if (record.terminalResultGeneration !== record.resultGeneration) continue;
    if (skipUnconsumed && !record.resultConsumed) continue;
    removeRecord(mgr, id, record);
  }
  mgr.tombstones.clear();
}

export function abortAll(mgr: ManagerState): number {
  let count = 0;
  count += cancelUsageLimitWaits(mgr, "Manager shutdown requested.");
  for (const queued of mgr.queue) {
    const record = mgr.agents.get(queued.id);
    if (record) {
      stopQueuedRecord(mgr, record, "shutdown", "Manager shutdown requested.");
      if (queued.finalize !== undefined) queued.finalize(false);
      else finishDeferredWorktreeThen(mgr, record, () => publishTerminal(mgr, record));
      count++;
    }
  }
  mgr.queue = [];
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

export async function waitForAll(mgr: ManagerState): Promise<void> {
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
  void pruneWorktrees(process.cwd());
  for (const repo of mgr.worktreeRepos) {
    void pruneWorktrees(repo);
  }
}
