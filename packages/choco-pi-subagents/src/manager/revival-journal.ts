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

export function setJournalLookup(
  mgr: ManagerState,
  lookup: SubagentJournalLookup | undefined,
): void {
  mgr.journalLookup = lookup;
}

export function getJournalHealth(mgr: ManagerState): SubagentJournalHealth {
  return { failures: mgr.journalFailures, lastError: mgr.lastJournalError };
}

export function journalRecord(mgr: ManagerState, id: string): boolean {
  const record = mgr.agents.get(id);
  if (record === undefined) return false;
  scheduleJournal(mgr, record);
  return true;
}

export function setRevivals(mgr: ManagerState, id: string, revivals: number): boolean {
  const record = mgr.agents.get(id);
  if (record === undefined || !Number.isInteger(revivals) || revivals < 0) return false;
  record.revivals = revivals;
  scheduleJournal(mgr, record);
  return true;
}

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

export function isRevivalPending(mgr: ManagerState, id: string): boolean {
  return mgr.revivalReservations.has(id);
}

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

export function flushJournal(mgr: ManagerState): void {
  const pending = [...mgr.pendingJournal.values()];
  mgr.pendingJournal.clear();
  for (const entry of pending) {
    if (mgr.agents.get(entry.id) === entry) writeJournal(mgr, entry);
  }
}

export function journalSinkFor(
  mgr: ManagerState,
  record: AgentRecord,
): SubagentJournalSink | undefined {
  const sink = mgr.journalSink;
  if (sink === undefined || mgr.disposed || mgr.unjournaled.has(record.id)) return undefined;
  const owner = mgr.usageScopes.get(record.id)?.owner;
  if (owner !== undefined && owner !== sink.rootSessionId) return undefined;
  const generation = record.resultGeneration ?? 1;
  if (
    record.cancellation?.generation === generation &&
    (record.cancellation.cause === "shutdown" || record.cancellation.cause === "suspend")
  ) {
    return undefined;
  }
  return sink;
}

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
  } catch {}
}

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

export function forgetJournalState(mgr: ManagerState, id: string): void {
  mgr.pendingJournal.delete(id);
  mgr.lastJournaled.delete(id);
  mgr.sessionFileConfirmed.delete(id);
  mgr.unjournaled.delete(id);
  mgr.journalFailureReported.delete(id);
}

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
