import type { Api, Model } from "@earendil-works/pi-ai";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  publishChildCompactionProvider,
  type ChildCompactionProvider,
} from "../../../choco-pi-subagents/src/child-compaction-bridge.ts";
import { ANTHROPIC_BACKEND_ID } from "../anthropic/backend.ts";
import { readAnthropicCompactionMode } from "../anthropic/mode.ts";
import type { BackgroundCompactionSettings, ProviderScope } from "../background/contract.ts";
import { ANCHOR_ENTRY_TYPE } from "../background/entry-types.ts";
import { release, setCoordinator } from "../background/registry.ts";
import {
  backgroundCompactionActive,
  backgroundSettingsPaths,
  isBackendEnabled,
  loadBackgroundSettings,
  type SettingsLocation,
} from "../background/settings.ts";
import { isChildSession, mainOwnerKey } from "../ownership.ts";
import type { CompactionSessionState } from "../session-state.ts";
import { type BackgroundAdoptionSignal, getBackgroundAdoptionSignal } from "./adoption-signal.ts";
import { candidateRecordsOf } from "./branch.ts";
import { errorText } from "./notices.ts";
import { createOwnerCore, type OwnerCore } from "./owner-core.ts";
import type { OwnerSpec } from "./owner-spec.ts";
import { resolveProviderScope } from "./provider-scope.ts";
import { ownerApi } from "./routes.ts";
import {
  type HostRuntime,
  isCurrent,
  type MainOwner,
  runCleanup,
  shutdown,
  teardownMain,
  unbindReplay,
} from "./runtime.ts";

// ---------------------------------------------------------------------------
// Main-session lifecycle: one owner per owned main session
// ---------------------------------------------------------------------------

const RELAY_CONSUMER_ID = "choco-pi-compaction:adoption-relay";

export interface MainSessionStart {
  /** Reload the settings sidecar (session_start) or keep the loaded settings (model_select). */
  readonly reloadSettings: boolean;
  readonly childProvider: ChildCompactionProvider;
}

/** Host scalars snapshotted before the first await of a session start. */
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

/** A main session with an active background feature and a model to bind. */
interface MainBinding {
  readonly session: SessionSnapshot;
  readonly model: Model<Api>;
  readonly state: CompactionSessionState;
  readonly settings: Readonly<BackgroundCompactionSettings>;
}

/** Owner identity under which a main session's coordinator registers. */
interface MainOwnerIdentity {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly signal: BackgroundAdoptionSignal;
}

/**
 * session_start / model_select: replace the main owner. Invalidates the
 * previous owner synchronously, then rechecks the lifecycle after each await.
 */
export async function startMainSession(
  rt: HostRuntime,
  ctx: ExtensionContext,
  start: MainSessionStart,
): Promise<void> {
  // Invalidate synchronously, then snapshot every scalar before awaiting.
  const generation = ++rt.lifecycle;
  teardownMain(rt);
  unbindReplay(rt);
  const session = snapshotSession(ctx, generation);
  if (start.reloadSettings) {
    const paths =
      rt.options.settingsPaths?.(session.location) ?? backgroundSettingsPaths(session.location);
    const readMode = rt.options.anthropic?.readMode ?? readAnthropicCompactionMode;
    const [loaded, mode] = await Promise.all([
      loadBackgroundSettings(paths),
      readMode(session.location.agentDir),
    ]);
    if (generation !== rt.lifecycle) return;
    rt.loaded = loaded;
    rt.anthropicMode = mode;
    if (rt.loaded.diagnostic !== undefined) rt.notify(ctx, rt.loaded.diagnostic);
  }
  // Inside a child the runner's bridge owns attachment; stay inert.
  if (session.child) return;
  const state = bindParentSession(rt, ctx, session, start.childProvider);
  const settings = rt.loaded.settings;
  rt.serverSide.bind(session.sessionId);
  bindAnthropicReplay(rt, session, settings);
  const model = session.model;
  if (!backgroundCompactionActive(settings) || model === undefined) return;
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

/** Register session cleanup, record the parent host and publish the child provider. */
function bindParentSession(
  rt: HostRuntime,
  ctx: ExtensionContext,
  session: SessionSnapshot,
  childProvider: ChildCompactionProvider,
): CompactionSessionState {
  // A session disposed without session_shutdown still releases its owner.
  rt.unregisterResourceCleanup?.();
  rt.unregisterResourceCleanup = registerSessionResourceCleanup((cleanupSessionId) => {
    if (cleanupSessionId === undefined || cleanupSessionId === session.sessionId) shutdown(rt);
  });
  const state = rt.readState();
  rt.parent = { modelRegistry: session.registry, state, ctx };
  rt.unpublishProvider ??= publishChildCompactionProvider(childProvider);
  return state;
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

/**
 * Capture and project this main session for Anthropic replay whenever either
 * native path can produce a checkpoint: server-side mode (foreground) or the
 * background `anthropic-native` backend. Unbound at the next session start,
 * model change or shutdown.
 */
function bindAnthropicReplay(
  rt: HostRuntime,
  session: SessionSnapshot,
  settings: Readonly<BackgroundCompactionSettings>,
): void {
  const serverSide = rt.anthropicMode === "server-side";
  if (!serverSide && !isBackendEnabled(ANTHROPIC_BACKEND_ID, settings)) return;
  rt.unbindReplay = rt.replay.bindSession(session.sessionId, session.sessionManager);
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
    allowAnthropic: true,
    allowForeign: true,
    report: (message) => rt.notify(rt.main?.lastCtx ?? ctx, message),
  };
}

interface CoreRegistration {
  readonly core: OwnerCore;
  readonly identity: MainOwnerIdentity;
  readonly cleanup: readonly (() => void)[];
}

/** Publish the coordinator under the owner key; a refusal disposes and releases everything. */
function registerMainCoordinator(
  rt: HostRuntime,
  ctx: ExtensionContext,
  registration: CoreRegistration,
): boolean {
  try {
    setCoordinator(registration.identity.ownerKey, registration.core.coordinator);
    return true;
  } catch (cause) {
    rt.notify(ctx, `coordinator registration refused: ${errorText(cause)}`);
    registration.core.dispose();
    runCleanup(registration.cleanup);
    return false;
  }
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

/** Forward a committed adoption of the current owner to the process-global signal. */
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
    // Binds only a compatible record; recovery never calls Backend.prepare.
    await owner.core.coordinator.recover(records);
  } catch (cause) {
    if (isCurrent(rt, owner)) rt.notify(ctx, `candidate recovery failed: ${errorText(cause)}`);
  }
}
