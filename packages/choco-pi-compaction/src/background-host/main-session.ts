import type { Api, Model } from "@earendil-works/pi-ai";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  publishChildCompactionProvider,
  type ChildCompactionProvider,
} from "../background/child-provider-contract.ts";
import { ANTHROPIC_BACKEND_ID } from "../anthropic/backend.ts";
import { readAnthropicCompactionMode, readOpaqueHistoryMode } from "../anthropic/mode.ts";
import { findActiveAnthropicCheckpoint } from "../anthropic/replay-rewrite.ts";
import type { BackgroundCompactionSettings, ProviderScope } from "../background/contract.ts";
import { ANCHOR_ENTRY_TYPE } from "../background/entry-types.ts";
import { type LaneProvider, REASONS } from "../background/lane-journal.ts";
import { release, setCoordinator } from "../background/registry.ts";
import {
  backgroundCompactionActive,
  backgroundSettingsPaths,
  deriveBackgroundLanes,
  isBackendEnabled,
  loadBackgroundSettings,
  type SettingsLocation,
  withDerivedDefaultLanes,
} from "../background/settings.ts";
import { isChildSession, mainOwnerKey, publishedCodexResponsesCompaction } from "../ownership.ts";
import type { CompactionSessionState } from "../session-state.ts";
import { readXaiCompactionMode } from "../xai/mode.ts";
import { findActiveXaiCheckpoint } from "../xai/replay.ts";
import { type BackgroundAdoptionSignal, getBackgroundAdoptionSignal } from "./adoption-signal.ts";
import { candidateRecordsOf } from "./branch.ts";
import { nativeLaneSwitches } from "./native-lanes.ts";
import { type NativeRefreshContext, registerSessionNativeRefresher } from "./native-refresh.ts";
import { announce, errorText } from "./notices.ts";
import { createOwnerCore, type OwnerCore } from "./owner-core.ts";
import type { OwnerSpec } from "./owner-spec.ts";
import { resolveProviderScope } from "./provider-scope.ts";
import { ownerApi } from "./routes.ts";
import {
  detachReplayUnbinds,
  type HostRuntime,
  isCurrent,
  type MainOwner,
  REGISTRY_CONFLICT_NOTICE,
  registryUsable,
  releaseOtherSessionCaptures,
  runCleanup,
  runUnbinds,
  shutdown,
  teardownMain,
} from "./runtime.ts";

const RELAY_CONSUMER_ID = "choco-pi-compaction:adoption-relay";

export interface MainSessionStart {
  readonly reloadSettings: boolean;
  readonly childProvider: ChildCompactionProvider;
}

interface SessionSnapshot {
  readonly generation: number;
  readonly sessionManager: ExtensionContext["sessionManager"];
  readonly sessionId: string;
  readonly location: SettingsLocation;
  readonly model: Model<Api> | undefined;
  readonly registry: ExtensionContext["modelRegistry"];
  readonly thinkingLevel: ExtensionContext["thinkingLevel"];
  readonly child: boolean;
}

interface MainBinding {
  readonly session: SessionSnapshot;
  readonly model: Model<Api>;
  readonly state: CompactionSessionState;
  readonly settings: Readonly<BackgroundCompactionSettings>;
}

interface MainOwnerIdentity {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly signal: BackgroundAdoptionSignal;
}

export async function startMainSession(
  rt: HostRuntime,
  ctx: ExtensionContext,
  start: MainSessionStart,
): Promise<void> {
  const generation = ++rt.lifecycle;
  teardownMain(rt);
  detachReplayUnbinds(rt);
  const session = snapshotSession(ctx, generation);
  if (start.reloadSettings) {
    const paths =
      rt.options.settingsPaths?.(session.location) ?? backgroundSettingsPaths(session.location);
    const readMode = rt.options.anthropic?.readMode ?? readAnthropicCompactionMode;
    const readXaiMode = rt.options.xai?.readMode ?? readXaiCompactionMode;
    const readOpaqueHistory = rt.options.readOpaqueHistoryMode ?? readOpaqueHistoryMode;
    const openaiServerSide =
      publishedCodexResponsesCompaction() ??
      rt.readState().codexCompaction?.responsesCompaction ??
      false;
    const [loaded, mode, xaiMode, opaqueHistory] = await Promise.all([
      loadBackgroundSettings(paths),
      readMode(session.location.agentDir),
      readXaiMode(session.location.agentDir),
      readOpaqueHistory(session.location.agentDir),
    ]);
    if (generation !== rt.lifecycle) return;
    rt.loaded = withDerivedDefaultLanes(
      loaded,
      deriveBackgroundLanes({ openaiServerSide, anthropicServerSide: mode === "server-side" }),
    );
    rt.anthropicMode = mode;
    rt.xaiMode = xaiMode;
    rt.opaqueHistory = opaqueHistory;
    if (rt.loaded.diagnostic !== undefined) rt.notify(ctx, rt.loaded.diagnostic);
  }
  const settings = rt.loaded.settings;
  rt.foregroundGate.setCooldownMs(settings.cooldownMs);
  rt.xaiGate.setCooldownMs(settings.cooldownMs);
  registerSessionCleanup(rt, session);
  bindNativeSession(rt, session, settings, ctx);
  runUnbinds(rt.detachedUnbinds.splice(0));
  releaseOtherSessionCaptures(rt, session.sessionId);
  if (session.child) return;
  const state = bindParentSession(rt, ctx, session, start.childProvider);
  const model = session.model;
  if (!backgroundCompactionActive(settings) || model === undefined) return;
  if (!registryUsable(rt, ctx)) return;
  await attachMainOwner(rt, ctx, { session, model, state, settings });
}

function snapshotSession(ctx: ExtensionContext, generation: number): SessionSnapshot {
  const sessionManager = ctx.sessionManager;
  const sessionId = sessionManager.getSessionId();
  return {
    generation,
    sessionManager,
    sessionId,
    location: {
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      projectTrusted: ctx.isProjectTrusted(),
    },
    model: ctx.model,
    registry: ctx.modelRegistry,
    thinkingLevel: ctx.thinkingLevel,
    child: isChildSession(sessionId),
  };
}

function registerSessionCleanup(rt: HostRuntime, session: SessionSnapshot): void {
  rt.unregisterResourceCleanup?.();
  rt.unregisterResourceCleanup = registerSessionResourceCleanup((cleanupSessionId) => {
    if (cleanupSessionId === undefined || cleanupSessionId === session.sessionId) shutdown(rt);
  });
}

function bindParentSession(
  rt: HostRuntime,
  ctx: ExtensionContext,
  session: SessionSnapshot,
  childProvider: ChildCompactionProvider,
): CompactionSessionState {
  const state = rt.readState();
  rt.parent = { modelRegistry: session.registry, state, ctx };
  rt.unpublishProvider ??= publishChildCompactionProvider(childProvider);
  return state;
}

function bindNativeSession(
  rt: HostRuntime,
  session: SessionSnapshot,
  settings: Readonly<BackgroundCompactionSettings>,
  ctx: ExtensionContext,
): void {
  const { sessionId, generation } = session;
  rt.nativeSessions.add(sessionId);
  rt.serverSide.bind(sessionId);
  rt.xaiServerSide.bind(sessionId);
  bindAnthropicReplay(rt, { sessionId, sessionManager: session.sessionManager, ctx }, settings);
  bindXaiReplay(rt, { sessionId, sessionManager: session.sessionManager, ctx });
  rt.unregisterNativeRefresher = registerSessionNativeRefresher(
    sessionId,
    NATIVE_REFRESHER_ID,
    (refreshCtx) => refreshNativeSession(rt, { sessionId, generation }, refreshCtx),
  );
}

const NATIVE_REFRESHER_ID = "choco-pi-compaction:replay";

function refreshNativeSession(
  rt: HostRuntime,
  bound: { readonly sessionId: string; readonly generation: number },
  ctx: NativeRefreshContext,
): void {
  if (rt.lifecycle !== bound.generation) return;
  const sessionManager = ctx.sessionManager;
  if (sessionManager.getSessionId() !== bound.sessionId) return;
  rt.nativeSessions.add(bound.sessionId);
  rt.serverSide.bind(bound.sessionId);
  rt.xaiServerSide.bind(bound.sessionId);
  const target = { sessionId: bound.sessionId, sessionManager, ctx: undefined };
  bindAnthropicReplay(rt, target, rt.loaded.settings);
  bindXaiReplay(rt, target);
}

async function attachMainOwner(
  rt: HostRuntime,
  ctx: ExtensionContext,
  binding: MainBinding,
): Promise<void> {
  const { session } = binding;
  const generation = session.generation;
  const cleanup: (() => void)[] = [];
  const scope = await resolveScopeOrRelease(rt, ctx, binding, cleanup);
  if (scope === undefined) return;
  if (generation !== rt.lifecycle) {
    runCleanup(cleanup);
    return;
  }
  const signal = getBackgroundAdoptionSignal();
  const identity: MainOwnerIdentity = {
    ownerKey: mainOwnerKey(session.sessionId),
    ownerGeneration: signal.nextGeneration(),
    signal,
  };
  const core = await createOwnerCore(
    mainOwnerSpec(rt, ctx, { binding, scope, identity }),
    rt.options,
  );
  if (core === undefined || generation !== rt.lifecycle) {
    core?.dispose();
    runCleanup(cleanup);
    return;
  }
  if (!registerMainCoordinator(rt, ctx, { core, identity, cleanup })) return;
  const owner = installMainOwner(rt, ctx, { binding, core, identity, cleanup });
  await recoverMainCandidates(rt, ctx, { owner, sessionManager: session.sessionManager });
}

interface ReplayTarget {
  readonly sessionId: string;
  readonly sessionManager: ExtensionContext["sessionManager"];
  readonly ctx: ExtensionContext | undefined;
}

function bindAnthropicReplay(
  rt: HostRuntime,
  target: ReplayTarget,
  settings: Readonly<BackgroundCompactionSettings>,
): void {
  const { sessionId, sessionManager, ctx } = target;
  const producing =
    rt.anthropicMode === "server-side" || isBackendEnabled(ANTHROPIC_BACKEND_ID, settings);
  const checkpoint = producing
    ? undefined
    : findActiveAnthropicCheckpoint(sessionManager.getBranch());
  if (!producing && checkpoint === undefined) return;
  rt.replayUnbinds.set(
    sessionId,
    rt.replay.bindSession(sessionId, sessionManager, ctx?.modelRegistry),
  );
  if (checkpoint !== undefined) announceReplayKept(rt, target, "anthropic", checkpoint.entryId);
}

function bindXaiReplay(rt: HostRuntime, target: ReplayTarget): void {
  const { sessionId, sessionManager } = target;
  const producing = rt.xaiMode === "server-side";
  const lookup = producing ? undefined : findActiveXaiCheckpoint(sessionManager.getBranch());
  if (!producing && (lookup === undefined || lookup.kind === "none")) return;
  rt.xaiReplayUnbinds.set(sessionId, rt.xaiReplay.bindSession(sessionId, sessionManager));
  if (lookup === undefined || lookup.kind === "none") return;
  const entryId = lookup.kind === "active" ? lookup.checkpoint.entryId : lookup.entryId;
  announceReplayKept(rt, target, "xai", entryId);
}

function announceReplayKept(
  rt: HostRuntime,
  target: ReplayTarget,
  provider: Extract<LaneProvider, "anthropic" | "xai">,
  checkpointEntryId: string,
): void {
  announce(
    rt,
    target.ctx,
    {
      at: rt.options.clock?.now() ?? Date.now(),
      sessionId: target.sessionId,
      provider,
      route: "mode-change",
      event: "yield",
      from: provider === "anthropic" ? "anthropic-native" : "xai-native",
      reason: REASONS.modeOff,
      checkpointEntryId,
    },
    `replay of checkpoint ${checkpointEntryId} stays active until a local compaction replaces it`,
    "info",
    "per-session-reason",
  );
}

async function resolveScopeOrRelease(
  rt: HostRuntime,
  ctx: ExtensionContext,
  binding: MainBinding,
  cleanup: readonly (() => void)[],
): Promise<ProviderScope | undefined> {
  try {
    return await resolveProviderScope(binding.model, binding.session.registry, binding.settings);
  } catch (cause) {
    if (binding.session.generation === rt.lifecycle) {
      rt.notify(ctx, `provider scope unavailable: ${errorText(cause)}`);
    }
    runCleanup(cleanup);
    return undefined;
  }
}

function mainOwnerSpec(
  rt: HostRuntime,
  ctx: ExtensionContext,
  parts: {
    readonly binding: MainBinding;
    readonly scope: ProviderScope;
    readonly identity: MainOwnerIdentity;
  },
): OwnerSpec {
  const { binding, scope, identity } = parts;
  const { session, state } = binding;
  const ownerCurrent = (): boolean => session.generation === rt.lifecycle;
  return {
    ownerKey: identity.ownerKey,
    ownerGeneration: identity.ownerGeneration,
    sessionId: session.sessionId,
    sessionManager: session.sessionManager,
    model: binding.model,
    modelRegistry: session.registry,
    thinkingLevel: session.thinkingLevel,
    retryPolicy: state.retryPolicy,
    compactionPolicy: state.compactionPolicy,
    codexCompaction: state.codexCompaction,
    settings: binding.settings,
    scope,
    appendRecord: (record) => {
      if (!ownerCurrent()) throw new Error("Background compaction owner is no longer current");
      rt.pi.appendEntry(record.customType, record);
    },
    appendAnchor: () => {
      if (!ownerCurrent()) return "";
      rt.pi.appendEntry(ANCHOR_ENTRY_TYPE, { schemaVersion: 1 });
      return session.sessionManager.getLeafId() ?? "";
    },
    isOwnerCurrent: ownerCurrent,
    ...nativeLaneSwitches(rt, binding.model),
    report: (message) => rt.notify(rt.main?.lastCtx ?? ctx, message),
    journal: (record) => {
      if (ownerCurrent()) rt.journal(record);
    },
    announce: (text, level, policy, record) => {
      if (!ownerCurrent()) return;
      announce(rt, rt.main?.lastCtx ?? ctx, record, text, level, policy);
    },
    anthropicDisabled: () => rt.serverSide.isDisabled(session.sessionId),
    anthropicGate: rt.foregroundGate,
  };
}

interface CoreRegistration {
  readonly core: OwnerCore;
  readonly identity: MainOwnerIdentity;
  readonly cleanup: readonly (() => void)[];
}

function registerMainCoordinator(
  rt: HostRuntime,
  ctx: ExtensionContext,
  registration: CoreRegistration,
): boolean {
  try {
    if (setCoordinator(registration.identity.ownerKey, registration.core.coordinator)) return true;
    rt.notify(ctx, REGISTRY_CONFLICT_NOTICE);
  } catch (cause) {
    rt.notify(ctx, `coordinator registration refused: ${errorText(cause)}`);
  }
  registration.core.dispose();
  runCleanup(registration.cleanup);
  return false;
}

function installMainOwner(
  rt: HostRuntime,
  ctx: ExtensionContext,
  parts: {
    readonly binding: MainBinding;
    readonly core: OwnerCore;
    readonly identity: MainOwnerIdentity;
    readonly cleanup: (() => void)[];
  },
): MainOwner {
  const { binding, core, identity, cleanup } = parts;
  const sessionId = binding.session.sessionId;
  const owner: MainOwner = {
    core,
    generation: binding.session.generation,
    decisions: new WeakMap(),
    refusedIdle: new Set(),
    pendingRoute: undefined,
    manualCandidate: undefined,
    manualSerial: 0,
    manualNotice: undefined,
    hostCompactUnwinding: false,
    idlePending: undefined,
    idleRunning: undefined,
    lastCtx: ctx,
    cleanup,
  };
  cleanup.push(() => {
    release(identity.ownerKey, identity.ownerGeneration, core.coordinator);
    core.dispose();
  });
  cleanup.push(
    core.coordinator.registerConsumer({
      id: RELAY_CONSUMER_ID,
      onAdopted: (adoption) => relayAdoption(rt, owner, { sessionId, adoption }),
    }),
  );
  cleanup.push(identity.signal.registerOwner(sessionId, ownerApi(rt, owner)));
  rt.main = owner;
  return owner;
}

interface CommittedAdoption {
  readonly committedEntryId: string;
  readonly candidateId: string;
  readonly backendId: string;
}

function relayAdoption(
  rt: HostRuntime,
  owner: MainOwner,
  committed: { readonly sessionId: string; readonly adoption: CommittedAdoption },
): void {
  if (!isCurrent(rt, owner)) return;
  const { adoption } = committed;
  getBackgroundAdoptionSignal().publish(
    {
      sessionId: committed.sessionId,
      committedEntryId: adoption.committedEntryId,
      candidateId: adoption.candidateId,
      backendId: adoption.backendId,
      route: owner.core.proposals.get(adoption.candidateId) ?? "recovered",
    },
    owner.lastCtx,
  );
}

async function recoverMainCandidates(
  rt: HostRuntime,
  ctx: ExtensionContext,
  recovery: {
    readonly owner: MainOwner;
    readonly sessionManager: ExtensionContext["sessionManager"];
  },
): Promise<void> {
  const { owner } = recovery;
  const records = candidateRecordsOf(recovery.sessionManager.getBranch());
  if (records.length === 0) return;
  try {
    await owner.core.coordinator.recover(records);
  } catch (cause) {
    if (isCurrent(rt, owner)) rt.notify(ctx, `candidate recovery failed: ${errorText(cause)}`);
  }
}
