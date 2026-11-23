import type { ChildProcess } from "node:child_process";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentBrowserSessionIdentityKey } from "../argv-grammar.ts";
import { isCloseCommand } from "../command-taxonomy.ts";
import type { AgentBrowserCompatibilityProfile } from "../compatibility-contract.ts";
import { canRegisterWebSearchTool, loadAgentBrowserConfig } from "../config.ts";
import {
  getAgentBrowserExecutableFingerprintKey,
  resolveAgentBrowserExecutable,
} from "../executable-resolution.ts";
import {
  AGENT_BROWSER_SCRIPT_NAMESPACE,
  isAgentBrowserScriptSessionName,
} from "../input-modes/script.ts";
import { ManagedSessionRestoreState } from "../managed-session-restore.ts";
import type { AllowedDomainsPolicy } from "../navigation-policy.ts";
import {
  closeManagedSession,
  getSessionContextKey,
  type AgentBrowserToolResult,
  type TraceOwner,
} from "../orchestration/browser-run/index.ts";
import { getActiveElectronRecords } from "../orchestration/browser-run/session-state.ts";
import {
  restoreElectronLaunchRecordsFromBranch,
  type ElectronLaunchRecord,
} from "../orchestration/electron-host/index.ts";
import {
  appendScriptSessionLease,
  getScriptSessionLeasesFromBranch,
} from "../orchestration/script-mode.ts";
import { hasRuntimeType, isRecord, isString } from "../parsing.ts";
import { getAgentBrowserExecutableContext, runAgentBrowserProcess } from "../process.ts";
import {
  getAgentBrowserProcessEnvironment,
  withIsolatedAgentBrowserEnvironment,
} from "../process-environment.ts";
import {
  appendRecordingReservationTransition,
  applyRecordingArtifactsToReservations,
  restoreRecordingReservationStateFromBranch,
  retireRecordingReservation,
  type ActiveRecordingReservation,
} from "../recording-reservations.ts";
import { retirePendingRecordingManifestEntries } from "../results/artifact-manifest.ts";
import type { NetworkRouteRecord, SessionArtifactManifest } from "../results/contracts.ts";
import {
  appendUniqueAgentBrowserNextActions,
  applyNamespaceToNextActions,
  applySessionToNextActions,
  buildNextToolAction,
  type AgentBrowserNextAction,
} from "../results/next-actions.ts";
import {
  createEphemeralSessionSeed,
  createFreshSessionName,
  createImplicitSessionName,
  extractUpstreamCommandTokens,
  getImplicitSessionCloseTimeoutMs,
  getImplicitSessionIdleTimeoutMs,
  isRestorableManagedSessionName,
  redactSensitiveText,
  restoreManagedSessionStateFromBranch,
  type CompatibilityWorkaround,
} from "../runtime.ts";
import { SessionPageState } from "../session-page-state.ts";
import { SnapshotRevisionStore } from "../snapshot-revisions.ts";
import { createDeferredAgentBrowserWebSearchTool } from "../web-search-registration.ts";
import { WebMcpInvocationRegistry, type WebMcpOwner } from "../webmcp-policy.ts";
import {
  batchStepReportsNoRecordingInProgress,
  getResultFileArtifacts,
  isResultFileArtifact,
} from "./artifacts.ts";
import {
  restoreAllowedDomainsBySessionFromBranch,
  restoreArtifactManifestFromBranch,
  restoreAttachedSessionKeysFromBranch,
  restoreManagedSessionCompatibilityWorkaroundFromBranch,
  restoreManagedSessionHeadedAutosaveDisabledFromBranch,
  restoreManagedSessionHeadedAutosaveIntervalFromBranch,
  type RestoredBranchSnapshot,
} from "./branch-restore.ts";
import { probeAgentBrowserCompatibility, shouldIncludeProjectConfig } from "./compatibility.ts";
import {
  AsyncExecutionQueue,
  KeyedAsyncExecutionQueue,
  collectBranchManagedResourceEvents,
  mergeActiveElectronLaunchRecords,
  removeInactiveOwnedElectronLaunchRecords,
  trackOwnedManagedSession,
  untrackOwnedManagedSession,
  untrackOwnedManagedSessionFromBranchClose,
  type OwnedManagedSession,
} from "./managed-resources.ts";

export type AgentBrowserConfigState = Awaited<ReturnType<typeof loadAgentBrowserConfig>>;

export interface ExtensionRuntimeState {
  pi: ExtensionAPI;
  ephemeralSessionSeed: string;
  implicitSessionIdleTimeoutMs: string;
  implicitSessionCloseTimeoutMs: number;
  webSearchToolRegistered: boolean;
  managedSessionActive: boolean;
  managedSessionBaseName: string;
  managedSessionCompatibilityWorkaround: CompatibilityWorkaround | undefined;
  managedSessionHeadedAutosaveDisabled: boolean;
  managedSessionHeadedAutosaveInterval: string | undefined;
  managedSessionName: string;
  managedSessionCwd: string;
  managedSessionNamespace: string | undefined;
  freshSessionOrdinal: number;
  sessionPageState: SessionPageState;
  snapshotRevisionStore: SnapshotRevisionStore;
  snapshotIdentityBySession: Map<string, { documentGeneration: number; tabGeneration: number }>;
  traceOwners: Map<string, TraceOwner>;
  artifactManifest: SessionArtifactManifest | undefined;
  activeRecordingReservations: Map<string, ActiveRecordingReservation>;
  recordingSessionTombstones: Map<string, ActiveRecordingReservation>;
  recordingSessionTombstonesToPersist: Map<string, ActiveRecordingReservation>;
  allowedDomainsBySession: Map<string, AllowedDomainsPolicy>;
  attachedSessionKeys: Set<string>;
  networkRoutesBySession: Map<string, NetworkRouteRecord[]>;
  electronLaunchRecords: Map<string, ElectronLaunchRecord>;
  ownedElectronLaunchRecords: Map<string, ElectronLaunchRecord>;
  branchOwnedElectronLaunchIds: Set<string>;
  electronChildProcesses: Map<string, ChildProcess>;
  managedSessionRestoreState: ManagedSessionRestoreState;
  ownedManagedSessions: Map<string, OwnedManagedSession>;
  managedSessionExecutionQueue: AsyncExecutionQueue;
  artifactExecutionQueue: AsyncExecutionQueue;
  callerOwnedSessionExecutionQueues: KeyedAsyncExecutionQueue;
  activeScriptControllers: Set<AbortController>;
  activeScriptExecutions: Set<Promise<void>>;
  branchRestoreGeneration: number;
  branchStateGeneration: number;
  warnedUpstreamFingerprints: Set<string>;
  compatibilityByFingerprint: Map<string, AgentBrowserCompatibilityProfile>;
  webMcpInvocations: WebMcpInvocationRegistry;
  webMcpOwnersByInvocation: Map<string, WebMcpOwner>;
  webMcpGenerationBySession: Map<string, number>;
}

export function createExtensionRuntimeState(pi: ExtensionAPI): ExtensionRuntimeState {
  const ephemeralSessionSeed = createEphemeralSessionSeed();
  const managedSessionBaseName = createImplicitSessionName(
    undefined,
    process.cwd(),
    ephemeralSessionSeed,
  );
  return {
    pi,
    ephemeralSessionSeed,
    implicitSessionIdleTimeoutMs: String(getImplicitSessionIdleTimeoutMs()),
    implicitSessionCloseTimeoutMs: getImplicitSessionCloseTimeoutMs(),
    webSearchToolRegistered: false,
    managedSessionActive: false,
    managedSessionBaseName,
    managedSessionCompatibilityWorkaround: undefined,
    managedSessionHeadedAutosaveDisabled: false,
    managedSessionHeadedAutosaveInterval: undefined,
    managedSessionName: managedSessionBaseName,
    managedSessionCwd: process.cwd(),
    managedSessionNamespace: undefined,
    freshSessionOrdinal: 0,
    sessionPageState: new SessionPageState(),
    snapshotRevisionStore: new SnapshotRevisionStore(),
    snapshotIdentityBySession: new Map(),
    traceOwners: new Map(),
    artifactManifest: undefined,
    activeRecordingReservations: new Map(),
    recordingSessionTombstones: new Map(),
    recordingSessionTombstonesToPersist: new Map(),
    allowedDomainsBySession: new Map(),
    attachedSessionKeys: new Set(),
    networkRoutesBySession: new Map(),
    electronLaunchRecords: new Map(),
    ownedElectronLaunchRecords: new Map(),
    branchOwnedElectronLaunchIds: new Set(),
    electronChildProcesses: new Map(),
    managedSessionRestoreState: new ManagedSessionRestoreState(),
    ownedManagedSessions: new Map(),
    managedSessionExecutionQueue: new AsyncExecutionQueue(),
    artifactExecutionQueue: new AsyncExecutionQueue(),
    callerOwnedSessionExecutionQueues: new KeyedAsyncExecutionQueue(),
    activeScriptControllers: new Set(),
    activeScriptExecutions: new Set(),
    branchRestoreGeneration: 0,
    branchStateGeneration: 0,
    warnedUpstreamFingerprints: new Set(),
    compatibilityByFingerprint: new Map(),
    webMcpInvocations: new WebMcpInvocationRegistry(),
    webMcpOwnersByInvocation: new Map(),
    webMcpGenerationBySession: new Map(),
  };
}

export function appendRecordingTransitions(
  state: ExtensionRuntimeState,
  transitions: ReturnType<typeof applyRecordingArtifactsToReservations>,
): void {
  for (const transition of transitions) {
    const key = getAgentBrowserSessionIdentityKey(
      transition.reservation.sessionName,
      transition.reservation.namespace,
    );
    if (transition.state === "active") {
      state.recordingSessionTombstones.delete(key);
      state.recordingSessionTombstonesToPersist.delete(key);
    } else {
      state.recordingSessionTombstones.set(key, transition.reservation);
    }
    try {
      appendRecordingReservationTransition(state.pi, transition);
      state.recordingSessionTombstonesToPersist.delete(key);
    } catch {
      if (transition.state === "closed")
        state.recordingSessionTombstonesToPersist.set(key, transition.reservation);
    }
  }
}

export function appendActiveRecordingCleanupAction(
  result: AgentBrowserToolResult,
  reservation: ActiveRecordingReservation,
): AgentBrowserToolResult {
  if (result.isError !== true) return result;
  const details = isRecord(result.details) ? result.details : {};
  // SAFETY: agent_browser result builders own details.nextActions and emit only AgentBrowserNextAction entries.
  const nextActions = Array.isArray(details.nextActions)
    ? ([...details.nextActions] as AgentBrowserNextAction[])
    : [];
  if (nextActions.some((action) => action.id === "stop-pending-recording")) return result;
  const stopActions = applyNamespaceToNextActions(
    applySessionToNextActions(
      [
        buildNextToolAction({
          args: ["record", "stop"],
          id: "stop-pending-recording",
          reason:
            "Stop the active recording so the requested video can be finalized and verified on disk.",
          safety:
            "The file remains pending until record stop succeeds; verify details.artifactVerification afterward.",
        }),
      ],
      reservation.sessionName,
    ),
    reservation.namespace,
  );
  appendUniqueAgentBrowserNextActions(nextActions, stopActions);
  const cleanupNotice =
    "An active recording remains open. Use the exact stop-pending-recording payload in details.nextActions before leaving this session.";
  let noticeAppended = false;
  const content = result.content.map((item) => {
    if (noticeAppended || item.type !== "text") return item;
    noticeAppended = true;
    return { ...item, text: `${item.text}\n\n${cleanupNotice}` };
  });
  if (!noticeAppended) content.push({ type: "text", text: cleanupNotice });
  return { ...result, content, details: { ...details, nextActions } };
}

export function retireRecordingSession(
  state: ExtensionRuntimeState,
  sessionName: string,
  namespace?: string,
  retireManifest = true,
): void {
  const reservation = retireRecordingReservation(
    state.activeRecordingReservations,
    sessionName,
    namespace,
  );
  const previousManifest = state.artifactManifest;
  if (retireManifest && state.artifactManifest)
    state.artifactManifest = retirePendingRecordingManifestEntries(
      state.artifactManifest,
      sessionName,
      namespace,
    );
  if (!reservation && state.artifactManifest === previousManifest) return;
  const terminalReservation = reservation ?? {
    absolutePath: "",
    cwd: state.managedSessionCwd,
    namespace,
    path: "",
    sessionName,
  };
  const terminalKey = getAgentBrowserSessionIdentityKey(sessionName, namespace);
  state.recordingSessionTombstones.set(terminalKey, terminalReservation);
  try {
    appendRecordingReservationTransition(state.pi, {
      reservation: terminalReservation,
      state: "closed",
    });
    state.recordingSessionTombstonesToPersist.delete(terminalKey);
  } catch {
    state.recordingSessionTombstonesToPersist.set(terminalKey, terminalReservation);
  }
}

export function syncRecordingReservationsFromResult(
  state: ExtensionRuntimeState,
  result: AgentBrowserToolResult,
): Set<string> {
  const handledClosedSessionKeys = new Set<string>();
  const details = isRecord(result.details) ? result.details : undefined;
  const batchSteps = Array.isArray(details?.batchSteps) ? details.batchSteps : undefined;
  const resultSessionName = hasRuntimeType(details?.sessionName, "string")
    ? details.sessionName
    : undefined;
  const resultNamespace = hasRuntimeType(details?.namespace, "string")
    ? details.namespace
    : undefined;
  if (!batchSteps) {
    appendRecordingTransitions(
      state,
      applyRecordingArtifactsToReservations(
        state.activeRecordingReservations,
        getResultFileArtifacts(result),
      ),
    );
    return handledClosedSessionKeys;
  }
  let sessionClosed = false;
  for (const step of batchSteps) {
    if (!isRecord(step)) continue;
    const command =
      Array.isArray(step.command) && step.command.every(isString) ? step.command : undefined;
    const commandTokens = command ? extractUpstreamCommandTokens(command) : [];
    const commandName = commandTokens[0];
    if (resultSessionName && batchStepReportsNoRecordingInProgress(step)) {
      const sessionKey = getAgentBrowserSessionIdentityKey(resultSessionName, resultNamespace);
      retireRecordingSession(state, resultSessionName, resultNamespace, false);
      handledClosedSessionKeys.add(sessionKey);
      continue;
    }
    if (step.success === true && commandName && isCloseCommand(commandName) && resultSessionName) {
      const sessionKey = getAgentBrowserSessionIdentityKey(resultSessionName, resultNamespace);
      retireRecordingSession(state, resultSessionName, resultNamespace, false);
      handledClosedSessionKeys.add(sessionKey);
      sessionClosed = true;
      continue;
    }
    if (sessionClosed && commandName === "record") continue;
    if (step.success === true && sessionClosed) sessionClosed = false;
    const artifacts = Array.isArray(step.artifacts)
      ? step.artifacts.filter(isResultFileArtifact)
      : [];
    appendRecordingTransitions(
      state,
      applyRecordingArtifactsToReservations(state.activeRecordingReservations, artifacts),
    );
  }
  for (const sessionKey of handledClosedSessionKeys) {
    if (
      !state.activeRecordingReservations.has(sessionKey) &&
      state.artifactManifest &&
      resultSessionName
    ) {
      state.artifactManifest = retirePendingRecordingManifestEntries(
        state.artifactManifest,
        resultSessionName,
        resultNamespace,
      );
    }
  }
  return handledClosedSessionKeys;
}

export async function inspectUpstreamVersion(
  state: ExtensionRuntimeState,
  cwd: string,
  signal?: AbortSignal,
): Promise<{
  profile?: AgentBrowserCompatibilityProfile;
  warnings: readonly string[];
}> {
  const processEnvironment = getAgentBrowserProcessEnvironment();
  const fingerprint =
    getAgentBrowserExecutableContext() ??
    (await resolveAgentBrowserExecutable({
      cwd,
      path: processEnvironment.PATH ?? processEnvironment.Path,
      pathExt: processEnvironment.PATHEXT,
    }));
  if (!fingerprint || signal?.aborted) return { warnings: [] };
  const fingerprintKey = getAgentBrowserExecutableFingerprintKey(fingerprint);
  const cached = state.compatibilityByFingerprint.get(fingerprintKey);
  if (cached) {
    const warnings = state.warnedUpstreamFingerprints.has(fingerprintKey)
      ? []
      : cached.warnings.map((warning) => warning.message);
    return { profile: cached, warnings };
  }
  const profile = await probeAgentBrowserCompatibility({
    fingerprint,
    runVersion: () =>
      runAgentBrowserProcess({ args: ["--version"], cwd, signal, timeoutMs: 5_000 }),
    signal,
  });
  if (!profile) return { warnings: [] };
  state.compatibilityByFingerprint.set(fingerprintKey, profile);
  return { profile, warnings: profile.warnings.map((warning) => warning.message) };
}

export function clearSessionScopedBrowserState(
  state: ExtensionRuntimeState,
  sessionName: string,
  namespace?: string,
): void {
  const key = getSessionContextKey(sessionName, namespace) ?? sessionName;
  state.allowedDomainsBySession = new Map(state.allowedDomainsBySession);
  state.allowedDomainsBySession.delete(key);
  state.attachedSessionKeys.delete(key);
  state.networkRoutesBySession = new Map(state.networkRoutesBySession);
  state.networkRoutesBySession.delete(key);
  state.traceOwners.delete(key);
  state.sessionPageState.clearSession(key);
  state.snapshotIdentityBySession.delete(key);
  state.snapshotRevisionStore.invalidateSession(namespace, sessionName);
  state.webMcpGenerationBySession.set(key, (state.webMcpGenerationBySession.get(key) ?? 0) + 1);
}

export async function closeScriptSessionLeaseWithinQueue(
  state: ExtensionRuntimeState,
  sessionName: string,
  cwd: string,
): Promise<string | undefined> {
  const closeError = await withIsolatedAgentBrowserEnvironment(() =>
    closeManagedSession({
      cwd,
      namespace: AGENT_BROWSER_SCRIPT_NAMESPACE,
      restoreState: state.managedSessionRestoreState,
      sessionName,
      timeoutMs: state.implicitSessionCloseTimeoutMs,
    }),
  );
  if (closeError) {
    try {
      appendScriptSessionLease(state.pi, sessionName, "failed");
    } catch {}
    return redactSensitiveText(closeError);
  }
  try {
    appendScriptSessionLease(state.pi, sessionName, "closed");
  } catch {
    state.managedSessionRestoreState.disable(sessionName);
    return "The isolated session closed, but its durable cleanup record could not be saved.";
  }
  untrackOwnedManagedSession(
    state.ownedManagedSessions,
    sessionName,
    AGENT_BROWSER_SCRIPT_NAMESPACE,
  );
  state.managedSessionRestoreState.clear(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
  retireRecordingSession(state, sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
  clearSessionScopedBrowserState(state, sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
  return undefined;
}

export async function recoverScriptSessionLeasesWithinQueue(
  state: ExtensionRuntimeState,
  branch: unknown[],
  cwd: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const pendingSessionNames = new Set(
    [...state.ownedManagedSessions.values()]
      .map((session) => session.sessionName)
      .filter(isAgentBrowserScriptSessionName),
  );
  for (const lease of getScriptSessionLeasesFromBranch(branch).values()) {
    if (lease.cleanup !== "closed") pendingSessionNames.add(lease.sessionName);
  }
  for (const sessionName of pendingSessionNames) {
    if (!isCurrent()) return;
    trackOwnedManagedSession(state.ownedManagedSessions, sessionName, cwd, {
      branchOwned: true,
      namespace: AGENT_BROWSER_SCRIPT_NAMESPACE,
    });
    state.managedSessionRestoreState.disable(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
    await closeScriptSessionLeaseWithinQueue(state, sessionName, cwd);
  }
}

export function restoreBranchBackedState(
  state: ExtensionRuntimeState,
  ctx: ExtensionContext,
  options: { resetRuntimeOwnership: boolean },
): RestoredBranchSnapshot {
  state.branchStateGeneration += 1;
  const previousManagedSessionActive = state.managedSessionActive;
  const previousManagedSessionName = state.managedSessionName;
  const previousFreshSessionOrdinal = state.freshSessionOrdinal;
  const previousAttachedSessionKeys = state.attachedSessionKeys;
  state.managedSessionBaseName = createImplicitSessionName(
    ctx.sessionManager.getSessionId(),
    ctx.cwd,
    state.ephemeralSessionSeed,
  );
  const branch = ctx.sessionManager.getBranch();
  const branchResourceEvents = collectBranchManagedResourceEvents(branch);
  const restoredState = restoreManagedSessionStateFromBranch(branch, state.managedSessionBaseName);
  state.managedSessionRestoreState.replace(restoredState.managedSessionRestoreDisabledIdentities, {
    preserveDaemonRestoreKeys: !options.resetRuntimeOwnership,
  });
  state.managedSessionActive = restoredState.active;
  const restoredFreshSessionOrdinal = options.resetRuntimeOwnership
    ? restoredState.freshSessionOrdinal
    : Math.max(previousFreshSessionOrdinal, restoredState.freshSessionOrdinal);
  const shouldReservePostCloseSession =
    !restoredState.active && restoredState.closedSessionName === restoredState.sessionName;
  const alreadyReservedPostCloseSession =
    shouldReservePostCloseSession &&
    !options.resetRuntimeOwnership &&
    !previousManagedSessionActive &&
    previousFreshSessionOrdinal > restoredState.freshSessionOrdinal &&
    previousFreshSessionOrdinal === restoredFreshSessionOrdinal &&
    previousManagedSessionName ===
      createFreshSessionName(
        state.managedSessionBaseName,
        state.ephemeralSessionSeed,
        restoredFreshSessionOrdinal,
      );
  const nextFreshSessionOrdinal =
    shouldReservePostCloseSession && !alreadyReservedPostCloseSession
      ? restoredFreshSessionOrdinal + 1
      : restoredFreshSessionOrdinal;
  state.managedSessionName = shouldReservePostCloseSession
    ? alreadyReservedPostCloseSession
      ? previousManagedSessionName
      : createFreshSessionName(
          state.managedSessionBaseName,
          state.ephemeralSessionSeed,
          nextFreshSessionOrdinal,
        )
    : restoredState.sessionName;
  state.managedSessionNamespace = shouldReservePostCloseSession
    ? undefined
    : restoredState.namespace;
  state.managedSessionCompatibilityWorkaround = state.managedSessionActive
    ? restoreManagedSessionCompatibilityWorkaroundFromBranch(
        branch,
        state.managedSessionName,
        state.managedSessionNamespace,
      )
    : undefined;
  state.managedSessionHeadedAutosaveDisabled =
    state.managedSessionActive &&
    restoreManagedSessionHeadedAutosaveDisabledFromBranch(
      branch,
      state.managedSessionName,
      state.managedSessionNamespace,
    );
  state.managedSessionHeadedAutosaveInterval = state.managedSessionActive
    ? restoreManagedSessionHeadedAutosaveIntervalFromBranch(
        branch,
        state.managedSessionName,
        state.managedSessionNamespace,
      )
    : undefined;
  state.managedSessionCwd = ctx.cwd;
  state.freshSessionOrdinal = nextFreshSessionOrdinal;
  state.sessionPageState = SessionPageState.fromBranch(branch);
  state.traceOwners = new Map<string, TraceOwner>();
  state.artifactManifest = restoreArtifactManifestFromBranch(branch);
  const restoredRecordingState = restoreRecordingReservationStateFromBranch(branch);
  for (const [key, reservation] of state.recordingSessionTombstones) {
    if (restoredRecordingState.terminal.has(key))
      state.recordingSessionTombstonesToPersist.delete(key);
    else state.recordingSessionTombstonesToPersist.set(key, reservation);
  }
  for (const [key, reservation] of restoredRecordingState.terminal) {
    if (!state.activeRecordingReservations.has(key))
      state.recordingSessionTombstones.set(key, reservation);
  }
  for (const key of state.recordingSessionTombstones.keys())
    restoredRecordingState.active.delete(key);
  for (const [key, reservation] of state.activeRecordingReservations)
    restoredRecordingState.active.set(key, reservation);
  state.activeRecordingReservations = restoredRecordingState.active;
  state.allowedDomainsBySession = restoreAllowedDomainsBySessionFromBranch(branch);
  state.attachedSessionKeys = restoreAttachedSessionKeysFromBranch(branch);
  state.networkRoutesBySession = new Map<string, NetworkRouteRecord[]>();
  state.electronLaunchRecords = restoreElectronLaunchRecordsFromBranch(branch);
  for (const record of getActiveElectronRecords(state.electronLaunchRecords)) {
    if (record.sessionName)
      state.attachedSessionKeys.add(
        getSessionContextKey(record.sessionName, record.namespace) ?? record.sessionName,
      );
  }
  if (options.resetRuntimeOwnership) {
    state.ownedManagedSessions.clear();
    state.ownedElectronLaunchRecords = new Map<string, ElectronLaunchRecord>();
    state.branchOwnedElectronLaunchIds = new Set<string>();
  } else {
    for (const [sessionName, closeRank] of branchResourceEvents.managedSessionCloseRanks) {
      untrackOwnedManagedSessionFromBranchClose(
        state.ownedManagedSessions,
        sessionName,
        branchResourceEvents.managedSessionActiveRanks.get(sessionName),
        closeRank,
      );
    }
    removeInactiveOwnedElectronLaunchRecords(
      state.ownedElectronLaunchRecords,
      state.branchOwnedElectronLaunchIds,
      state.electronLaunchRecords,
      branchResourceEvents.electronLaunchActiveRanks,
      branchResourceEvents.electronLaunchCleanupRanks,
    );
  }
  for (const [sessionKey, identity] of branchResourceEvents.managedSessionActiveIdentities) {
    const activeRank = branchResourceEvents.managedSessionActiveRanks.get(sessionKey);
    const closeRank = branchResourceEvents.managedSessionCloseRanks.get(sessionKey);
    if (activeRank === undefined || (closeRank !== undefined && closeRank >= activeRank)) continue;
    if (!isRestorableManagedSessionName(identity.sessionName, state.managedSessionBaseName))
      continue;
    trackOwnedManagedSession(state.ownedManagedSessions, identity.sessionName, ctx.cwd, {
      branchOwned: true,
      compatibilityWorkaround: restoreManagedSessionCompatibilityWorkaroundFromBranch(
        branch,
        identity.sessionName,
        identity.namespace,
      ),
      headedManagedAutosaveDisabled: restoreManagedSessionHeadedAutosaveDisabledFromBranch(
        branch,
        identity.sessionName,
        identity.namespace,
      ),
      headedManagedAutosaveInterval: restoreManagedSessionHeadedAutosaveIntervalFromBranch(
        branch,
        identity.sessionName,
        identity.namespace,
      ),
      namespace: identity.namespace,
    });
  }
  if (restoredState.active) {
    trackOwnedManagedSession(state.ownedManagedSessions, restoredState.sessionName, ctx.cwd, {
      branchOwned: true,
      compatibilityWorkaround: state.managedSessionCompatibilityWorkaround,
      headedManagedAutosaveDisabled: state.managedSessionHeadedAutosaveDisabled,
      headedManagedAutosaveInterval: state.managedSessionHeadedAutosaveInterval,
      namespace: restoredState.namespace,
    });
  }
  for (const record of getActiveElectronRecords(state.electronLaunchRecords)) {
    if (
      !record.sessionName ||
      !isRestorableManagedSessionName(record.sessionName, state.managedSessionBaseName)
    )
      continue;
    const sessionKey = getSessionContextKey(record.sessionName) ?? record.sessionName;
    const activeRank = branchResourceEvents.managedSessionActiveRanks.get(sessionKey);
    const closeRank = branchResourceEvents.managedSessionCloseRanks.get(sessionKey);
    if (activeRank === undefined || (closeRank !== undefined && closeRank >= activeRank)) continue;
    trackOwnedManagedSession(state.ownedManagedSessions, record.sessionName, ctx.cwd, {
      branchOwned: true,
      headedManagedAutosaveDisabled: restoreManagedSessionHeadedAutosaveDisabledFromBranch(
        branch,
        record.sessionName,
      ),
      headedManagedAutosaveInterval: restoreManagedSessionHeadedAutosaveIntervalFromBranch(
        branch,
        record.sessionName,
      ),
    });
  }
  mergeActiveElectronLaunchRecords(state.ownedElectronLaunchRecords, state.electronLaunchRecords, {
    branchOwnedLaunchIds: state.branchOwnedElectronLaunchIds,
    markBranchOwned: true,
  });
  if (!options.resetRuntimeOwnership) {
    for (const sessionKey of previousAttachedSessionKeys) {
      if (state.ownedManagedSessions.has(sessionKey)) state.attachedSessionKeys.add(sessionKey);
    }
    for (const record of state.ownedElectronLaunchRecords.values()) {
      const sessionKey = getSessionContextKey(record.sessionName);
      if (sessionKey && previousAttachedSessionKeys.has(sessionKey))
        state.attachedSessionKeys.add(sessionKey);
    }
  }
  return { branch, cwd: ctx.cwd };
}

export function registerWebSearchToolIfAvailable(
  state: ExtensionRuntimeState,
  configState: AgentBrowserConfigState,
): void {
  if (state.webSearchToolRegistered || !canRegisterWebSearchTool(configState)) return;
  state.pi.registerTool(
    createDeferredAgentBrowserWebSearchTool(configState, {
      loadConfigState(ctx) {
        const cwd = ctx.cwd;
        const includeProjectConfig = shouldIncludeProjectConfig(ctx);
        return loadAgentBrowserConfig({
          cwd,
          includeProjectConfig,
        });
      },
    }),
  );
  state.webSearchToolRegistered = true;
}
