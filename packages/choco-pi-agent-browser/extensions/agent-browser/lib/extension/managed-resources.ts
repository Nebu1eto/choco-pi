import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  extractExplicitSessionName,
  getAgentBrowserSessionIdentityKey,
  isAgentBrowserSessionIdentityKeyInNamespace,
} from "../argv-grammar.ts";
import { getSuccessfulBatchCloseLifecycle } from "../batch-lifecycle.ts";
import { isCloseCommand } from "../command-taxonomy.ts";
import type { CompiledAgentBrowserElectron } from "../input-modes/types.ts";
import { ManagedSessionRestoreState } from "../managed-session-restore.ts";
import { closeManagedSession, getSessionContextKey } from "../orchestration/browser-run/index.ts";
import {
  findElectronLaunchRecordForSession,
  getActiveElectronRecords,
} from "../orchestration/browser-run/session-state.ts";
import type { ElectronLaunchRecord } from "../orchestration/electron-host/index.ts";
import { hasRuntimeType, isRecord } from "../parsing.ts";
import { extractUpstreamCommandTokens, type CompatibilityWorkaround } from "../runtime.ts";
import {
  detailsReportCloseAllApplied,
  getCleanupResultClosedManagedSessionIdentities,
  getCleanupResultsClosedManagedSessionIdentities,
  getManagedSessionOutcome,
  getRecognizedCompatibilityWorkaround,
  getSuccessfulToolResult,
  type ElectronClosedManagedSessionIdentity,
} from "./branch-restore.ts";

export {
  getCleanupResultClosedManagedSessionIdentities,
  getCleanupResultsClosedManagedSessionIdentities,
  type ElectronClosedManagedSessionIdentity,
};
export type OwnedManagedSession = {
  branchOwned: boolean;
  compatibilityWorkaround?: CompatibilityWorkaround;
  cwd: string;
  headedManagedAutosaveDisabled?: boolean;
  headedManagedAutosaveInterval?: string;
  namespace?: string;
  sessionName: string;
};

export interface BranchManagedResourceEvents {
  electronLaunchActiveRanks: Map<string, number>;
  electronLaunchCleanupRanks: Map<string, number>;
  managedSessionActiveIdentities: Map<string, { namespace?: string; sessionName: string }>;
  managedSessionActiveRanks: Map<string, number>;
  managedSessionCloseRanks: Map<string, number>;
}

export function trackOwnedManagedSession(
  sessions: Map<string, OwnedManagedSession>,
  sessionName: string | undefined,
  cwd: string,
  options: {
    branchOwned?: boolean;
    compatibilityWorkaround?: CompatibilityWorkaround;
    headedManagedAutosaveDisabled?: boolean;
    headedManagedAutosaveInterval?: string;
    namespace?: string;
  } = {},
): void {
  if (!sessionName) return;
  const key = getSessionContextKey(sessionName, options.namespace) ?? sessionName;
  const existing = sessions.get(key);
  const branchOwned = existing && !existing.branchOwned ? false : options.branchOwned === true;
  const compatibilityWorkaround = Object.hasOwn(options, "compatibilityWorkaround")
    ? options.compatibilityWorkaround
    : existing?.compatibilityWorkaround;
  const headedManagedAutosaveDisabled =
    options.headedManagedAutosaveDisabled ?? existing?.headedManagedAutosaveDisabled;
  const headedManagedAutosaveInterval =
    options.headedManagedAutosaveInterval ?? existing?.headedManagedAutosaveInterval;
  sessions.set(key, {
    branchOwned,
    compatibilityWorkaround,
    cwd,
    headedManagedAutosaveDisabled,
    headedManagedAutosaveInterval,
    namespace: options.namespace,
    sessionName,
  });
}

export function untrackOwnedManagedSession(
  sessions: Map<string, OwnedManagedSession>,
  sessionName: string | undefined,
  namespace?: string,
): void {
  if (!sessionName) return;
  if (sessionName.includes("\u0000")) sessions.delete(sessionName);
  else sessions.delete(getSessionContextKey(sessionName, namespace) ?? sessionName);
}

export function untrackOwnedManagedSessionFromBranchClose(
  sessions: Map<string, OwnedManagedSession>,
  sessionName: string | undefined,
  activeBranchRank: number | undefined,
  closeBranchRank: number | undefined,
): void {
  if (!sessionName || closeBranchRank === undefined) return;
  const ownedSession = sessions.get(sessionName);
  if (!ownedSession?.branchOwned) return;
  if (activeBranchRank !== undefined && closeBranchRank <= activeBranchRank) return;
  sessions.delete(sessionName);
}

export function syncOwnedManagedSessionsFromResult(
  sessions: Map<string, OwnedManagedSession>,
  result: AgentToolResult<unknown>,
  cwd: string,
): void {
  const details = isRecord(result.details) ? result.details : undefined;
  const outcome = isRecord(details?.managedSessionOutcome)
    ? details.managedSessionOutcome
    : undefined;
  if (!outcome) return;
  const succeeded = outcome.succeeded === true;
  const status = hasRuntimeType(outcome.status, "string") ? outcome.status : undefined;
  const currentSessionName = hasRuntimeType(outcome.currentSessionName, "string")
    ? outcome.currentSessionName
    : undefined;
  const attemptedSessionName = hasRuntimeType(outcome.attemptedSessionName, "string")
    ? outcome.attemptedSessionName
    : undefined;
  const namespace =
    isRecord(details) && hasRuntimeType(details.namespace, "string")
      ? details.namespace
      : undefined;
  if (
    outcome.activeAfter === true &&
    (status === "created" || status === "replaced" || status === "unchanged")
  ) {
    trackOwnedManagedSession(sessions, currentSessionName, cwd, {
      compatibilityWorkaround: getRecognizedCompatibilityWorkaround(
        details?.compatibilityWorkaround,
      ),
      headedManagedAutosaveDisabled: details?.managedSessionHeadedAutosaveDisabled === true,
      headedManagedAutosaveInterval: hasRuntimeType(
        details?.managedSessionHeadedAutosaveInterval,
        "string",
      )
        ? details.managedSessionHeadedAutosaveInterval
        : undefined,
      namespace,
    });
  }
  if (succeeded && status === "closed") {
    untrackOwnedManagedSession(sessions, attemptedSessionName ?? currentSessionName, namespace);
  }
}

export function getTouchedElectronLaunchIds(
  sessionName: string | undefined,
  records: Map<string, ElectronLaunchRecord>,
  namespace?: string,
): Set<string> | undefined {
  const record = findElectronLaunchRecordForSession(sessionName, records, namespace);
  return record ? new Set([record.launchId]) : undefined;
}

export function mergeActiveElectronLaunchRecords(
  target: Map<string, ElectronLaunchRecord>,
  source: Map<string, ElectronLaunchRecord>,
  options: {
    branchOwnedLaunchIds?: Set<string>;
    markBranchOwned?: boolean;
    touchedLaunchIds?: Set<string>;
  } = {},
): void {
  for (const record of getActiveElectronRecords(source)) {
    const alreadyRuntimeOwned =
      target.has(record.launchId) && options.branchOwnedLaunchIds?.has(record.launchId) === false;
    target.set(record.launchId, record);
    if (options.branchOwnedLaunchIds) {
      if (alreadyRuntimeOwned) {
      } else if (options.markBranchOwned === true) {
        options.branchOwnedLaunchIds.add(record.launchId);
      } else if (options.touchedLaunchIds?.has(record.launchId)) {
        options.branchOwnedLaunchIds.delete(record.launchId);
      }
    }
  }
}

export function removeInactiveOwnedElectronLaunchRecords(
  target: Map<string, ElectronLaunchRecord>,
  branchOwnedLaunchIds: Set<string>,
  source: Map<string, ElectronLaunchRecord>,
  activeBranchRanks: Map<string, number>,
  cleanupBranchRanks: Map<string, number>,
): void {
  const activeLaunchIds = new Set(
    getActiveElectronRecords(source).map((record) => record.launchId),
  );
  const launchIds = new Set([...source.keys(), ...cleanupBranchRanks.keys()]);
  for (const launchId of launchIds) {
    if (!target.has(launchId) || !branchOwnedLaunchIds.has(launchId)) continue;
    const activeBranchRank = activeBranchRanks.get(launchId);
    const cleanupBranchRank = cleanupBranchRanks.get(launchId);
    const restoredInactiveRecord = source.has(launchId) && !activeLaunchIds.has(launchId);
    const cleanupIsLatest =
      cleanupBranchRank !== undefined &&
      (activeBranchRank === undefined || cleanupBranchRank > activeBranchRank);
    if (!restoredInactiveRecord && !cleanupIsLatest) continue;
    target.delete(launchId);
    branchOwnedLaunchIds.delete(launchId);
  }
}

export function mergeElectronLaunchRecordMaps(
  ...maps: Array<Map<string, ElectronLaunchRecord>>
): Map<string, ElectronLaunchRecord> {
  const merged = new Map<string, ElectronLaunchRecord>();
  for (const map of maps) {
    for (const [launchId, record] of map) merged.set(launchId, record);
  }
  return merged;
}

export function replaceWithActiveElectronLaunchRecords(
  target: Map<string, ElectronLaunchRecord>,
  source: Map<string, ElectronLaunchRecord>,
  branchOwnedLaunchIds?: Set<string>,
  cleanedLaunchIds?: Set<string>,
): void {
  target.clear();
  if (branchOwnedLaunchIds) {
    if (cleanedLaunchIds) {
      for (const launchId of cleanedLaunchIds) branchOwnedLaunchIds.delete(launchId);
    } else {
      branchOwnedLaunchIds.clear();
    }
  }
  mergeActiveElectronLaunchRecords(
    target,
    source,
    branchOwnedLaunchIds ? { branchOwnedLaunchIds } : {},
  );
}

export function shouldSerializeElectronHostInput(
  compiledElectron: CompiledAgentBrowserElectron | undefined,
): boolean {
  return (
    compiledElectron?.action === "status" ||
    compiledElectron?.action === "probe" ||
    compiledElectron?.action === "cleanup"
  );
}

export function getElectronHostLaunchRecordsForInput(options: {
  branchRecords: Map<string, ElectronLaunchRecord>;
  compiledElectron: CompiledAgentBrowserElectron | undefined;
  ownedRecords: Map<string, ElectronLaunchRecord>;
}): Map<string, ElectronLaunchRecord> {
  if (
    options.compiledElectron?.action === "status" ||
    options.compiledElectron?.action === "cleanup" ||
    (options.compiledElectron?.action === "probe" && options.compiledElectron.launchId)
  ) {
    return mergeElectronLaunchRecordMaps(options.branchRecords, options.ownedRecords);
  }
  return options.branchRecords;
}

export function isElectronLaunchRecord<Value>(value: Value): value is Value & ElectronLaunchRecord {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    value.launchedByWrapper === true &&
    (value.namespace === undefined || hasRuntimeType(value.namespace, "string")) &&
    hasRuntimeType(value.launchId, "string") &&
    hasRuntimeType(value.appName, "string") &&
    hasRuntimeType(value.executablePath, "string") &&
    hasRuntimeType(value.userDataDir, "string") &&
    hasRuntimeType(value.port, "number") &&
    hasRuntimeType(value.createdAtMs, "number")
  );
}

export function getCleanupResultsElectronRecords(
  cleanupResults: unknown[],
): ElectronLaunchRecord[] {
  return cleanupResults
    .map((result) => (isRecord(result) ? result.record : undefined))
    .filter(isElectronLaunchRecord);
}

export function mergeElectronCleanupRecords(
  target: Map<string, ElectronLaunchRecord>,
  cleanupResults: unknown[],
): void {
  for (const record of getCleanupResultsElectronRecords(cleanupResults)) {
    target.set(record.launchId, record);
  }
}

function setBranchRankForString<Value>(map: Map<string, number>, value: Value, rank: number): void {
  if (hasRuntimeType(value, "string") && value.length > 0) map.set(value, rank);
}

function setBranchManagedSessionActive<SessionName>(
  events: BranchManagedResourceEvents,
  sessionName: SessionName,
  namespace: string | undefined,
  rank: number,
): void {
  if (!hasRuntimeType(sessionName, "string") || sessionName.length === 0) return;
  const key = getSessionContextKey(sessionName, namespace) ?? sessionName;
  events.managedSessionActiveIdentities.set(key, { namespace, sessionName });
  events.managedSessionActiveRanks.set(key, rank);
}

export function collectBranchManagedResourceEvents(branch: unknown[]): BranchManagedResourceEvents {
  const events: BranchManagedResourceEvents = {
    electronLaunchActiveRanks: new Map<string, number>(),
    electronLaunchCleanupRanks: new Map<string, number>(),
    managedSessionActiveIdentities: new Map<string, { namespace?: string; sessionName: string }>(),
    managedSessionActiveRanks: new Map<string, number>(),
    managedSessionCloseRanks: new Map<string, number>(),
  };
  let eventRank = 0;
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = isRecord(entry.message) ? entry.message : undefined;
    if (!message || message.toolName !== "agent_browser") continue;
    const details = isRecord(message.details) ? message.details : undefined;
    if (!details) continue;
    eventRank += 1;
    const succeeded = getSuccessfulToolResult(details, message);
    const args =
      Array.isArray(details.args) && details.args.every((arg) => hasRuntimeType(arg, "string"))
        ? details.args
        : [];
    const command = hasRuntimeType(details.command, "string")
      ? details.command
      : extractUpstreamCommandTokens(args)[0];
    const sessionName = hasRuntimeType(details.sessionName, "string")
      ? details.sessionName
      : undefined;
    const namespace = hasRuntimeType(details.namespace, "string") ? details.namespace : undefined;
    const sessionMode =
      details.sessionMode === "fresh" || details.sessionMode === "auto"
        ? details.sessionMode
        : undefined;
    const usedImplicitSession = details.usedImplicitSession === true;
    const explicitSessionName = extractExplicitSessionName(args);
    const batchCloseLifecycle = getSuccessfulBatchCloseLifecycle(details.batchSteps);
    const closeAllApplied = detailsReportCloseAllApplied(details, succeeded);
    const outcome = getManagedSessionOutcome(details);
    const outcomeSucceeded = outcome?.succeeded === true;
    const outcomeStatus = hasRuntimeType(outcome?.status, "string") ? outcome.status : undefined;
    const outcomeCurrentSessionName = hasRuntimeType(outcome?.currentSessionName, "string")
      ? outcome.currentSessionName
      : undefined;
    const outcomeAttemptedSessionName = hasRuntimeType(outcome?.attemptedSessionName, "string")
      ? outcome.attemptedSessionName
      : undefined;
    if (
      outcome?.activeAfter === true &&
      (outcomeStatus === "created" || outcomeStatus === "replaced" || outcomeStatus === "unchanged")
    ) {
      setBranchManagedSessionActive(events, outcomeCurrentSessionName, namespace, eventRank);
    }
    if (outcomeSucceeded && outcomeStatus === "closed") {
      setBranchRankForString(
        events.managedSessionCloseRanks,
        getSessionContextKey(
          outcomeAttemptedSessionName ?? outcomeCurrentSessionName ?? sessionName,
          namespace,
        ),
        eventRank,
      );
    }
    if (outcome && outcomeStatus === "replaced" && outcome.replacedSessionClosed !== false) {
      const replacedSessionNamespace = hasRuntimeType(outcome.replacedSessionNamespace, "string")
        ? outcome.replacedSessionNamespace
        : namespace;
      setBranchRankForString(
        events.managedSessionCloseRanks,
        getSessionContextKey(
          hasRuntimeType(outcome.replacedSessionName, "string")
            ? outcome.replacedSessionName
            : undefined,
          replacedSessionNamespace,
        ),
        eventRank,
      );
    }
    if (
      succeeded &&
      !isCloseCommand(command) &&
      sessionName &&
      (usedImplicitSession ||
        sessionMode === "fresh" ||
        details.managedSessionHeadedAutosaveDisabled === true ||
        hasRuntimeType(details.managedSessionHeadedAutosaveInterval, "string"))
    ) {
      setBranchManagedSessionActive(events, sessionName, namespace, eventRank);
    }
    if (succeeded && isCloseCommand(command)) {
      setBranchRankForString(
        events.managedSessionCloseRanks,
        getSessionContextKey(
          explicitSessionName ??
            sessionName ??
            outcomeAttemptedSessionName ??
            outcomeCurrentSessionName,
          namespace,
        ),
        eventRank,
      );
    }
    if (closeAllApplied) {
      const retainedSessionKey =
        batchCloseLifecycle?.endsClosed === false
          ? getSessionContextKey(sessionName, namespace)
          : undefined;
      for (const sessionKey of events.managedSessionActiveIdentities.keys()) {
        if (
          sessionKey !== retainedSessionKey &&
          isAgentBrowserSessionIdentityKeyInNamespace(sessionKey, namespace)
        ) {
          events.managedSessionCloseRanks.set(sessionKey, eventRank);
        }
      }
    }

    const electron = isRecord(details.electron) ? details.electron : undefined;
    const launch =
      electron && isElectronLaunchRecord(electron.launch) ? electron.launch : undefined;
    if (launch && getActiveElectronRecords(new Map([[launch.launchId, launch]])).length > 0) {
      events.electronLaunchActiveRanks.set(launch.launchId, eventRank);
    }
    const cleanup = isRecord(electron?.cleanup) ? electron.cleanup : undefined;
    const cleanupRecords = Array.isArray(cleanup?.records) ? cleanup.records : [];
    for (const cleanupRecord of cleanupRecords) {
      if (isElectronLaunchRecord(cleanupRecord))
        events.electronLaunchCleanupRanks.set(cleanupRecord.launchId, eventRank);
    }
    const cleanupResults = Array.isArray(cleanup?.results) ? cleanup.results : [];
    for (const cleanupResult of cleanupResults) {
      if (isRecord(cleanupResult) && isElectronLaunchRecord(cleanupResult.record)) {
        events.electronLaunchCleanupRanks.set(cleanupResult.record.launchId, eventRank);
      }
      for (const identity of getCleanupResultClosedManagedSessionIdentities(
        cleanupResult,
        namespace,
      )) {
        events.managedSessionCloseRanks.set(
          getSessionContextKey(identity.sessionName, identity.namespace) ?? identity.sessionName,
          eventRank,
        );
      }
    }
  }
  return events;
}

export function getCleanupResultsPreservedUserDataDirs(cleanupResults: unknown[]): string[] {
  const userDataDirs = new Set<string>();
  for (const result of cleanupResults) {
    if (!isRecord(result) || !Array.isArray(result.steps) || !isElectronLaunchRecord(result.record))
      continue;
    const userDataDirStep = result.steps.find(
      (step) => isRecord(step) && step.resource === "user-data-dir",
    );
    if (!isRecord(userDataDirStep)) continue;
    if (userDataDirStep.state === "skipped" || userDataDirStep.state === "failed")
      userDataDirs.add(result.record.userDataDir);
  }
  return [...userDataDirs];
}

export function syncElectronCleanupManagedSessions(
  sessions: Map<string, OwnedManagedSession>,
  cleanupResults: unknown[],
  fallbackNamespace?: string,
): void {
  for (const identity of getCleanupResultsClosedManagedSessionIdentities(
    cleanupResults,
    fallbackNamespace,
  )) {
    untrackOwnedManagedSession(sessions, identity.sessionName, identity.namespace);
  }
}

export async function closeOwnedManagedSessionsExcept(
  sessions: Map<string, OwnedManagedSession>,
  restoreState: ManagedSessionRestoreState,
  keepSessionName: string | undefined,
  timeoutMs: number,
  attachedSessionKeys: ReadonlySet<string>,
  keepNamespace?: string,
  onClosed?: (owner: OwnedManagedSession) => void,
): Promise<void> {
  const keepKey = getSessionContextKey(keepSessionName, keepNamespace);
  for (const [key, owner] of Array.from(sessions)) {
    if (key === keepKey) continue;
    const error = await closeManagedSession({
      cwd: owner.cwd,
      headedManagedAutosaveInterval: owner.headedManagedAutosaveInterval,
      namespace: owner.namespace,
      preserveAttachedBrowserSession: attachedSessionKeys.has(key),
      restoreState,
      sessionName: owner.sessionName,
      timeoutMs,
    });
    if (!error) {
      sessions.delete(key);
      onClosed?.(owner);
    }
  }
}

export async function closeOwnedManagedSessions(
  sessions: Map<string, OwnedManagedSession>,
  restoreState: ManagedSessionRestoreState,
  timeoutMs: number,
  attachedSessionKeys: ReadonlySet<string>,
  onClosed?: (owner: OwnedManagedSession) => void,
): Promise<void> {
  await closeOwnedManagedSessionsExcept(
    sessions,
    restoreState,
    undefined,
    timeoutMs,
    attachedSessionKeys,
    undefined,
    onClosed,
  );
}

export function getOffBranchOwnedElectronLaunchRecords(
  ownedRecords: Map<string, ElectronLaunchRecord>,
  branchRecords: Map<string, ElectronLaunchRecord>,
): Map<string, ElectronLaunchRecord> {
  const activeBranchLaunchIds = new Set(
    getActiveElectronRecords(branchRecords).map((record) => record.launchId),
  );
  const offBranchRecords = new Map<string, ElectronLaunchRecord>();
  for (const record of getActiveElectronRecords(ownedRecords)) {
    if (!activeBranchLaunchIds.has(record.launchId)) offBranchRecords.set(record.launchId, record);
  }
  return offBranchRecords;
}

export function shouldSerializeBrowserCommand(options: {
  explicitNamespace?: string;
  explicitSessionName?: string;
  managedSessionName: string;
  ownedElectronLaunchRecords: Map<string, ElectronLaunchRecord>;
  ownedManagedSessions: Map<string, OwnedManagedSession>;
}): boolean {
  if (!options.explicitSessionName) return true;
  if (options.explicitSessionName === options.managedSessionName) return true;
  if (
    options.ownedManagedSessions.has(
      getSessionContextKey(options.explicitSessionName, options.explicitNamespace) ??
        options.explicitSessionName,
    )
  )
    return true;
  return getActiveElectronRecords(options.ownedElectronLaunchRecords).some(
    (record) => record.sessionName === options.explicitSessionName,
  );
}

export class AsyncExecutionQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return (async () => {
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    })();
  }
}

export class KeyedAsyncExecutionQueue {
  private readonly barriers = new Map<string, Promise<void>>();
  private readonly entries = new Map<string, { queue: AsyncExecutionQueue; users: number }>();

  async run<T>(key: string, namespace: string | undefined, work: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key) ?? { queue: new AsyncExecutionQueue(), users: 0 };
    const barrier =
      this.barriers.get(getAgentBrowserSessionIdentityKey("", namespace)) ?? Promise.resolve();
    entry.users += 1;
    this.entries.set(key, entry);
    try {
      return await entry.queue.run(async () => {
        await barrier;
        return await work();
      });
    } finally {
      entry.users -= 1;
      if (entry.users === 0 && this.entries.get(key) === entry) this.entries.delete(key);
    }
  }

  async runExclusive<T>(namespace: string | undefined, work: () => Promise<T>): Promise<T> {
    const namespaceKey = getAgentBrowserSessionIdentityKey("", namespace);
    const previous = this.barriers.get(namespaceKey) ?? Promise.resolve();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = previous.then(() => blocked);
    this.barriers.set(namespaceKey, barrier);
    const drains = [...this.entries]
      .filter(([key]) => isAgentBrowserSessionIdentityKeyInNamespace(key, namespace))
      .map(([, { queue }]) => queue.run(async () => undefined));
    await previous;
    await Promise.all(drains);
    try {
      return await work();
    } finally {
      release();
      if (this.barriers.get(namespaceKey) === barrier) this.barriers.delete(namespaceKey);
    }
  }
}
