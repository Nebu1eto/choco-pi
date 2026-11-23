/**
 * revival-journal.ts — Internal AgentManager module extracted from agent-manager.ts.
 */

import {
  buildJournalData,
  journalClassificationOf,
  isJournalAgentSnapshot,
  type JournalAgentSnapshot,
  type JournalRunOptions,
  type SubagentJournalData,
} from "../revival-journal.ts";
import type { AgentRecord } from "../types.ts";
import {
  type UsageWait,
  type SubagentJournalSink,
  type SubagentJournalLookup,
  type SubagentJournalHealth,
  MAX_DORMANT,
  isUnsettledStatus,
  sessionHasAssistantMessage,
  modelRefOf,
  type ManagerState,
} from "./state.ts";

/**
 * Install or remove the journal writer. A different root session clears the
 * dormant map, the lookup, and the dedupe state: they describe another
 * session's file. Removing the sink keeps them, but hides dormant entries.
 */
export function setJournalSink(mgr: ManagerState, sink: SubagentJournalSink | undefined): void {
  const root = sink?.rootSessionId;
  if (root !== undefined && root !== mgr.journalRoot) {
    mgr.dormant.clear();
    mgr.lastJournaled.clear();
    mgr.journalLookup = undefined;
    mgr.journalRoot = root;
    mgr.revivalEpoch++;
  }
  mgr.journalSink = sink;
}

/** Fallback consulted by `getDormant` when the in-memory map misses. */
export function setJournalLookup(
  mgr: ManagerState,
  lookup: SubagentJournalLookup | undefined,
): void {
  mgr.journalLookup = lookup;
}

/** Journaling failures since construction, for diagnostics and tests. */
export function getJournalHealth(mgr: ManagerState): SubagentJournalHealth {
  return { failures: mgr.journalFailures, lastError: mgr.lastJournalError };
}

/**
 * Re-journal a live record after a change made outside the manager (a
 * result read flipping `resultConsumed`). Returns false for an unknown id.
 */
export function journalRecord(mgr: ManagerState, id: string): boolean {
  const record = mgr.agents.get(id);
  if (record === undefined) return false;
  scheduleJournal(mgr, record);
  return true;
}

/** Set a live record's consecutive unclean-revival count and journal it. */
export function setRevivals(mgr: ManagerState, id: string, revivals: number): boolean {
  const record = mgr.agents.get(id);
  if (record === undefined || !Number.isInteger(revivals) || revivals < 0) return false;
  record.revivals = revivals;
  scheduleJournal(mgr, record);
  return true;
}

/**
 * Load dormant snapshots (startup: terminal snapshots of the current root).
 * Call after `setJournalSink` for that root. Invalid snapshots and ids that
 * are live are skipped. Returns how many were stored.
 */
export function hydrateDormant(
  mgr: ManagerState,
  snapshots: Iterable<JournalAgentSnapshot>,
): number {
  let stored = 0;
  for (const snapshot of snapshots) {
    if (!isJournalAgentSnapshot(snapshot)) continue;
    if (putDormant(mgr, snapshot)) stored++;
  }
  return stored;
}

/** Dormant snapshot by id; undefined while a live record holds the id or no sink is set. */
export function getDormant(mgr: ManagerState, id: string): JournalAgentSnapshot | undefined {
  if (mgr.journalSink === undefined || mgr.agents.has(id)) return undefined;
  const stored = mgr.dormant.get(id);
  if (stored !== undefined) return stored;
  let found: JournalAgentSnapshot | undefined;
  try {
    found = mgr.journalLookup?.(id);
  } catch {
    return undefined;
  }
  return found !== undefined && found.id === id && isJournalAgentSnapshot(found)
    ? found
    : undefined;
}

/**
 * Newest top-level dormant snapshot whose handle or alias matches
 * case-insensitively, or whose id matches exactly. In-memory map only.
 */
export function findDormantByHandle(
  mgr: ManagerState,
  handleOrAlias: string,
): JournalAgentSnapshot | undefined {
  if (mgr.journalSink === undefined) return undefined;
  const wanted = handleOrAlias.toLowerCase();
  let match: JournalAgentSnapshot | undefined;
  for (const entry of mgr.dormant.values()) {
    if (entry.parentAgentId !== undefined || mgr.agents.has(entry.id)) continue;
    if (
      entry.handle?.toLowerCase() === wanted ||
      entry.alias?.toLowerCase() === wanted ||
      entry.id === handleOrAlias
    ) {
      match = entry;
    }
  }
  return match;
}

/** Record that a dormant agent's result was read, and journal it. */
export function markDormantResultConsumed(mgr: ManagerState, id: string): boolean {
  const sink = mgr.journalSink;
  const entry = getDormant(mgr, id);
  if (sink === undefined || entry === undefined) return false;
  if (entry.resultConsumed) return true;
  const updated: JournalAgentSnapshot = { ...entry, resultConsumed: true };
  putDormant(mgr, updated);
  try {
    sink.append(
      buildJournalData({ rootSessionId: sink.rootSessionId, suspended: false, agent: updated }),
    );
  } catch (err) {
    noteJournalFailure(mgr, sink, id, err instanceof Error ? err : new Error(String(err)));
  }
  return true;
}

/**
 * Explicit stop of a dormant agent that has no run (interrupted, parked or
 * never revived): journal it `stopped` with `stoppedByUser` so no startup
 * revives it. Returns the stopped snapshot, or undefined when the id is
 * live, being revived, unknown, or already terminal.
 */
export function stopDormant(mgr: ManagerState, id: string): JournalAgentSnapshot | undefined {
  const sink = mgr.journalSink;
  if (sink === undefined || mgr.disposed || mgr.revivalReservations.has(id)) return undefined;
  const entry = getDormant(mgr, id);
  if (entry === undefined || !isUnsettledStatus(entry.status)) return undefined;
  const stopped: JournalAgentSnapshot = {
    ...entry,
    status: "stopped",
    stoppedByUser: true,
    error: entry.error ?? "Stopped by user request while not running.",
    usageWait: undefined,
    steers: undefined,
  };
  putDormant(mgr, stopped);
  try {
    sink.append(
      buildJournalData({ rootSessionId: sink.rootSessionId, suspended: false, agent: stopped }),
    );
  } catch (err) {
    noteJournalFailure(mgr, sink, id, err instanceof Error ? err : new Error(String(err)));
  }
  return stopped;
}

/** Whether a startup revival or dormant resume currently holds `id`. */
export function isRevivalPending(mgr: ManagerState, id: string): boolean {
  return mgr.revivalReservations.has(id);
}

/**
 * Queue a journal write. Writes are coalesced in one microtask so a settle
 * path that sets status, then error/result/consumption synchronously, lands
 * as one complete entry. The microtask runs before any I/O callback, so the
 * entry precedes the run's first provider call.
 */
export function scheduleJournal(mgr: ManagerState, record: AgentRecord): void {
  if (mgr.journalSink === undefined || mgr.disposed) return;
  mgr.pendingJournal.set(record.id, record);
  if (mgr.journalFlushQueued) return;
  mgr.journalFlushQueued = true;
  queueMicrotask(() => {
    mgr.journalFlushQueued = false;
    flushJournal(mgr);
  });
}

/**
 * Write every coalesced journal entry now (e.g. inside `session_shutdown`,
 * where a pending microtask may never run before the process exits).
 */
export function flushJournal(mgr: ManagerState): void {
  const pending = [...mgr.pendingJournal.values()];
  mgr.pendingJournal.clear();
  for (const entry of pending) {
    if (mgr.agents.get(entry.id) === entry) writeJournal(mgr, entry);
  }
}

/** The sink this record journals to, or undefined when it must not be journaled. */
export function journalSinkFor(
  mgr: ManagerState,
  record: AgentRecord,
): SubagentJournalSink | undefined {
  const sink = mgr.journalSink;
  if (sink === undefined || mgr.disposed || mgr.unjournaled.has(record.id)) return undefined;
  // A record of another root session (spawned before a switch) is not this file's.
  const owner = mgr.usageScopes.get(record.id)?.owner;
  if (owner !== undefined && owner !== sink.rootSessionId) return undefined;
  // Host shutdown stops are not outcomes: the journal keeps the last real
  // state so startup can revive. A suspended record's suspend entry must
  // stay its latest, so nothing after it is journaled.
  const generation = record.resultGeneration ?? 1;
  if (
    record.cancellation?.generation === generation &&
    (record.cancellation.cause === "shutdown" || record.cancellation.cause === "suspend")
  ) {
    return undefined;
  }
  return sink;
}

/** Build and append one snapshot. Never throws; returns the snapshot built. */
export function writeJournal(
  mgr: ManagerState,
  record: AgentRecord,
): JournalAgentSnapshot | undefined {
  const sink = journalSinkFor(mgr, record);
  if (sink === undefined) return undefined;
  let data: SubagentJournalData;
  try {
    data = buildJournalData({
      rootSessionId: sink.rootSessionId,
      suspended: false,
      agent: journalSnapshot(mgr, record),
    });
  } catch (err) {
    noteJournalFailure(mgr, sink, record.id, err instanceof Error ? err : new Error(String(err)));
    return undefined;
  }
  const key = JSON.stringify(data.agent);
  if (mgr.lastJournaled.get(record.id) !== key) {
    try {
      sink.append(data);
      mgr.lastJournaled.set(record.id, key);
    } catch (err) {
      noteJournalFailure(mgr, sink, record.id, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return data.agent;
}

export function noteJournalFailure(
  mgr: ManagerState,
  sink: SubagentJournalSink,
  agentId: string,
  error: Error,
): void {
  mgr.journalFailures++;
  mgr.lastJournalError = error.message;
  if (mgr.journalFailureReported.has(agentId)) return;
  mgr.journalFailureReported.add(agentId);
  try {
    sink.reportError?.(agentId, error);
  } catch {
    /* a failing diagnostic must not break the run either */
  }
}

/**
 * Write the suspend entry (`suspended: true`) synchronously. `status` is
 * `interrupted`, or `waiting_for_reset` with the wait it continues.
 */
export function writeSuspendedJournal(
  mgr: ManagerState,
  record: AgentRecord,
  status: "interrupted" | "waiting_for_reset",
  wait: UsageWait | undefined,
): void {
  const sink = journalSinkFor(mgr, record);
  if (sink === undefined) return;
  mgr.pendingJournal.delete(record.id);
  try {
    const steers = status === "interrupted" ? [...(record.pendingSteers ?? [])] : undefined;
    const data = buildJournalData({
      rootSessionId: sink.rootSessionId,
      suspended: true,
      agent: journalSnapshot(mgr, record, { status, wait, steers }),
    });
    sink.append(data);
    mgr.lastJournaled.set(record.id, JSON.stringify(data.agent));
  } catch (err) {
    noteJournalFailure(mgr, sink, record.id, err instanceof Error ? err : new Error(String(err)));
  }
}

/** Plain snapshot of a record; `buildJournalData` copies, caps and validates it. */
export function journalSnapshot(
  mgr: ManagerState,
  record: AgentRecord,
  override?: {
    status: AgentRecord["status"];
    wait: UsageWait | undefined;
    steers: string[] | undefined;
  },
): JournalAgentSnapshot {
  const status = override?.status ?? record.status;
  const terminal = !isUnsettledStatus(status);
  const sessionFile =
    record.sessionFile !== undefined &&
    (mgr.sessionFileConfirmed.has(record.id) || sessionHasAssistantMessage(record.session))
      ? record.sessionFile
      : undefined;
  const wait =
    override === undefined
      ? record.status === "waiting_for_reset"
        ? mgr.usageWaits.get(record.id)
        : undefined
      : override.wait;
  const worktree = record.worktree;
  const repo = record.worktreeRepo;
  const spawnOptions: JournalRunOptions = record.runOptions ?? {};
  return {
    id: record.id,
    handle: record.handle,
    alias: record.alias,
    type: record.type,
    description: record.description,
    parentAgentId: record.parentAgentId,
    depth: record.depth ?? 1,
    status,
    sessionFile,
    model: modelRefOf(record.session?.model) ?? record.spawnModel,
    // Spawn-time options, with the fields the record carries forward (a
    // parked foreground child becomes background; fast/daybreak can change).
    options: {
      ...spawnOptions,
      isBackground: record.isBackground,
      fastModeRequested: record.fastModeRequested,
      daybreakRequested: record.daybreakRequested,
      outputFile: record.outputFile ?? spawnOptions.outputFile,
    },
    prompt: sessionFile === undefined ? record.spawnPrompt : undefined,
    usageWait:
      wait === undefined
        ? undefined
        : {
            providerKey: wait.providerKey,
            resetAt: wait.classification.resetAt ?? record.usageLimit?.resetAt,
            classification: journalClassificationOf(wait.classification),
            steers: [...wait.continuation, ...(record.pendingSteers ?? [])],
          },
    worktree:
      worktree === undefined || repo === undefined
        ? undefined
        : {
            path: worktree.path,
            branch: worktree.branch,
            baseSha: worktree.baseSha,
            repo,
            workPath: worktree.workPath,
            hookManaged: worktree.hookManaged,
          },
    revivals: record.revivals ?? 0,
    resultConsumed: record.resultConsumed === true,
    stoppedByUser: record.stoppedByUser,
    result: terminal ? record.result : undefined,
    error: terminal ? record.error : undefined,
    steers: override?.steers,
    inMemorySession: record.inMemorySession,
  };
}

/**
 * The child's session file now holds the conversation (first assistant
 * message, turn end, or tool activity of this generation), so the journal can
 * point at it instead of carrying the prompt. One-shot per record.
 */
export function confirmSessionFile(
  mgr: ManagerState,
  record: AgentRecord,
  generation: number,
): void {
  if (record.resultGeneration !== generation || record.sessionFile === undefined) return;
  if (mgr.sessionFileConfirmed.has(record.id)) return;
  mgr.sessionFileConfirmed.add(record.id);
  record.spawnPrompt = undefined;
  scheduleJournal(mgr, record);
}

/** Store a dormant snapshot as the newest entry; false when its id is live. */
export function putDormant(mgr: ManagerState, snapshot: JournalAgentSnapshot): boolean {
  if (mgr.agents.has(snapshot.id)) return false;
  mgr.dormant.delete(snapshot.id);
  mgr.dormant.set(snapshot.id, snapshot);
  while (mgr.dormant.size > MAX_DORMANT) {
    const oldest = mgr.dormant.keys().next();
    if (oldest.done === true) break;
    mgr.dormant.delete(oldest.value);
  }
  return true;
}

/** Drop a record's journal bookkeeping (eviction or a failed spawn). */
export function forgetJournalState(mgr: ManagerState, id: string): void {
  mgr.pendingJournal.delete(id);
  mgr.lastJournaled.delete(id);
  mgr.sessionFileConfirmed.delete(id);
  mgr.unjournaled.delete(id);
  mgr.journalFailureReported.delete(id);
}

/**
 * Final journal write for an evicted record, then keep its terminal snapshot
 * for the dormant map. Catches up on changes made outside the manager
 * (result reads). The caller stores it after the live record is gone.
 */
export function retireJournal(
  mgr: ManagerState,
  record: AgentRecord,
): JournalAgentSnapshot | undefined {
  mgr.pendingJournal.delete(record.id);
  const snapshot = writeJournal(mgr, record);
  forgetJournalState(mgr, record.id);
  if (snapshot === undefined || isUnsettledStatus(snapshot.status)) return undefined;
  return snapshot;
}
