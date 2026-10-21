import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { ChildCompactionProvider } from "../../../choco-pi-subagents/src/child-compaction-bridge.ts";
import { ANTHROPIC_BACKEND_ID } from "../anthropic/backend.ts";
import {
  AnthropicCapabilityGate,
  type AnthropicSupportEntry,
  capturedProviders,
} from "../anthropic/capability.ts";
import { capturesFor } from "../anthropic/capture.ts";
import { createForegroundCompactHandler } from "../anthropic/foreground.ts";
import { isAnthropicDetails } from "../anthropic/details.ts";
import {
  AnthropicServerSideSession,
  type AnthropicCompactionMode,
  DEFAULT_ANTHROPIC_COMPACTION_MODE,
  DEFAULT_OPAQUE_HISTORY_MODE,
  readAnthropicCompactionMode,
  writeAnthropicCompactionMode,
} from "../anthropic/mode.ts";
import { createAnthropicReplayBinder } from "../anthropic/replay-binding.ts";
import type { ReplayDiagnostic } from "../anthropic/replay-rewrite.ts";
import {
  type CandidateState,
  DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
  type FailureReason,
} from "../background/contract.ts";
import {
  appendLaneRecord,
  type LaneReason,
  type LaneRecordInput,
  LaneTransitionMemo,
  ownedReasonOf,
  REASONS,
} from "../background/lane-journal.ts";
import {
  backgroundCompactionActive,
  type BackgroundLaneSwitches,
  backgroundSettingsPaths,
  deriveBackgroundLanes,
  type LoadedBackgroundSettings,
  type SettingsLocation,
  SidecarRefusedError,
  writeGlobalBackgroundSettings,
} from "../background/settings.ts";
import { isStaleContextError } from "../lifecycle.ts";
import {
  lossAuthorized,
  opaqueCheckpointOf,
  opaqueLaneOf,
  opaqueProviderOf,
  publishOpaqueConsent,
} from "../opaque-checkpoint.ts";
import { isChildSession } from "../ownership.ts";
import { publishBackgroundCompactionPreferences } from "../preferences-section.ts";
import { readCodexCompactionSnapshot, type SessionStateReader } from "../session-state.ts";
import { createXaiCapabilityGate, xaiCapturedProviders } from "../xai/capability.ts";
import { xaiCapturesFor } from "../xai/capture.ts";
import { createXaiForegroundCompactHandler } from "../xai/foreground.ts";
import {
  DEFAULT_XAI_COMPACTION_MODE,
  type XaiCompactionMode,
  writeXaiCompactionMode,
} from "../xai/mode.ts";
import {
  createXaiReplayBinder,
  findActiveXaiCheckpoint,
  type XaiReplayDiagnostic,
} from "../xai/replay.ts";
import {
  getBackgroundAdoptionSignal,
  publishBackgroundAdoptionSignalSlot,
} from "./adoption-signal.ts";
import { createChildProvider } from "./child-provider.ts";
import { watchCodexEligibility } from "./codex-eligibility.ts";
import {
  type CompactCommandHost,
  installCompactCommandBridge,
  releaseCompactCommandBridge,
} from "./host-command.ts";
import { startMainSession } from "./main-session.ts";
import { announce, createNotifier, errorText, tell } from "./notices.ts";
import type { BackgroundCompactionOptions } from "./owner-spec.ts";
import {
  adoptAtBoundary,
  adoptOnIdleInput,
  decide,
  idleCompactionActive,
  manualBypassesHost,
  manualLanes,
  observeSettled,
  reportHostRefused,
  scheduleIdleCompaction,
  startManualPreparation,
} from "./routes.ts";
import {
  type CompactionModes,
  type HostRuntime,
  isCurrent,
  type MainOwner,
  registryUsable,
  shutdown,
  touchCurrentOwner,
} from "./runtime.ts";
import {
  installSessionCompactBridge,
  releaseSessionCompactBridge,
  type SessionCompactOutcome,
  type SessionCompactHost,
} from "./session-compact.ts";

// ===========================================================================
// Background compaction host integration
// ===========================================================================
//
// Everything here is inert unless the background-compaction sidecar turns
// the feature on (it ships off). It wires the frozen coordinator, backends and
// child bridge into the real host:
//
// - one coordinator per owned main session, registered under
//   main-session:<sessionId> with a process-unique generation; child sessions
//   get theirs from the subagent runner's bridge, so this extension stays inert
//   inside a child;
// - preparation starts from boundary usage (prepareAt/hysteresis against the
//   host trigger point) and never blocks the foreground;
// - a ready candidate is adopted at a turn_end/agent_before_settle boundary
//   (draft return, no host event), from the idle input route (ctx.compact as a
//   trigger only, while idle), or when the host itself compacts;
// - adoption consumers (goal, hooks, context cap) learn about adoptions through
//   one process-global signal instead of a forged host event.

export interface BackgroundCompaction {
  /**
   * Answer session_before_compact with a ready candidate, or undefined to let
   * the existing summarizer (or the host) proceed.
   */
  beforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<SessionBeforeCompactResult | undefined>;
  /**
   * Whether a child session's runner bridge answers this compaction with an
   * adoption, so the summarizer must not run (and be paid for) at all.
   */
  childAdopts(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<boolean>;
  /**
   * Answer session_before_compact with Anthropic or xAI server-side
   * compaction, or undefined to let the local summarizer answer the same
   * compaction.
   */
  foregroundCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<SessionBeforeCompactResult | undefined>;
  /** Current settings load (for diagnostics and tests). */
  settings(): LoadedBackgroundSettings;
  /** Current vendor compaction modes and opaque-history setting. */
  modes(): CompactionModes;
}

/**
 * Wire background compaction into this extension instance. Must be called
 * once from the extension factory; registers its own handlers, with the
 * Anthropic replay rewrite as this extension's last before_provider_request
 * handler.
 */
export function registerBackgroundCompaction(
  pi: ExtensionAPI,
  readState: SessionStateReader,
  options: BackgroundCompactionOptions = {},
): BackgroundCompaction {
  publishBackgroundAdoptionSignalSlot();
  const rt = createRuntime(pi, readState, options);
  const childProvider = createChildProvider(rt);
  rt.childProvider = childProvider;
  publishConsent(rt);
  pi.registerCommand("compaction-allow-loss", {
    description:
      "Allow compaction to summarize without the latest opaque server-side checkpoint (this session only)",
    handler: (_args, ctx) => {
      allowOpaqueLoss(rt, ctx);
      return Promise.resolve();
    },
  });
  const clock = options.clock;
  const foreground = createForegroundCompactHandler({
    gate: rt.foregroundGate,
    session: rt.serverSide,
    mode: () => rt.anthropicMode,
    codexCompaction: () => rt.readState().codexCompaction,
    generation: () => rt.lifecycle,
    captures: capturesFor,
    fetch: options.anthropic?.fetch,
    stream: options.anthropic?.stream,
    now: clock === undefined ? undefined : () => clock.now(),
    announce: (ctx, record, text, level, policy) => announce(rt, ctx, record, text, level, policy),
  });
  const xaiForeground = createXaiForegroundCompactHandler({
    gate: rt.xaiGate,
    session: rt.xaiServerSide,
    mode: () => rt.xaiMode,
    codexCompaction: () => rt.readState().codexCompaction,
    generation: () => rt.lifecycle,
    captures: xaiCapturesFor,
    fetch: options.xai?.fetch,
    now: clock === undefined ? undefined : () => clock.now(),
    announce: (ctx, record, text, level, policy) => announce(rt, ctx, record, text, level, policy),
  });
  /** Bumped by every session_shutdown; a session start awaiting I/O stops when it moved. */
  const shutdowns = { count: 0 };

  // A typed /compact in the TUI continues in the background without the host's
  // "Compaction cancelled" line; every other case falls back to Pi's handler.
  const deferTypedCompact = async (
    host: CompactCommandHost,
    customInstructions?: string,
  ): Promise<boolean> => {
    const owner = rt.main;
    if (owner === undefined || owner.core.sessionId !== host.session.sessionId) return false;
    if (!manualBypassesHost(rt, owner, customInstructions)) return false;
    return startManualPreparation(rt, owner, customInstructions);
  };
  installCompactCommandBridge(deferTypedCompact);

  // A programmatic compact (RPC `compact`, SDK, `ctx.compact()`) on an idle
  // session continues in the background and resolves at once, without aborting
  // the agent or starting a host compaction. A busy session, the feature off,
  // a registry conflict, or a declined request runs the host's own compact().
  // An owner that retires while the preparation starts (shutdown, reload,
  // replacement) reports the request stale: it settles without any compaction.
  const deferSessionCompact = async (
    host: SessionCompactHost,
    customInstructions?: string,
  ): Promise<SessionCompactOutcome> => {
    // Snapshot before the first await: the window can close while deciding.
    const settling = rt.settling;
    if (!host.isIdle) return "declined";
    if (!backgroundCompactionActive(rt.loaded.settings)) return "declined";
    if (!registryUsable(rt, undefined)) return "declined";
    const owner = rt.main;
    if (owner === undefined || owner.core.sessionId !== host.sessionId) return "declined";
    if (settling && deferrableOwner(owner, customInstructions)) {
      // Inside the settling window (agent_end until the next input or turn_start).
      // A request here may come from any extension's agent_settled handler, before
      // or after this extension's own, or be an explicit idle RPC compact sent after
      // the emission ended: public events cannot tell those apart, so all of them
      // run at the next prompt's input hook. The caller is answered now (handled).
      scheduleIdleCompaction(owner, {
        kind: "foreground",
        customInstructions,
        onSettled: () => undefined,
      });
      return "handled";
    }
    if (!manualBypassesHost(rt, owner, customInstructions)) return "declined";
    if (await startManualPreparation(rt, owner, customInstructions)) return "handled";
    return isCurrent(rt, owner) ? "declined" : "stale";
  };
  installSessionCompactBridge(deferSessionCompact);

  /**
   * Whether a host compaction for this owner must wait for the next prompt: no
   * background lane serves it (Codex or xAI own its compaction, or none
   * applies), so it would be a host compaction, and starting one while
   * `agent_settled` is emitted makes Pi reject the prompt it defers meanwhile,
   * unanswered. The host compaction a deferred request itself started is the
   * host's to run.
   */
  const deferrableOwner = (owner: MainOwner, customInstructions?: string): boolean =>
    isCurrent(rt, owner) &&
    !idleCompactionActive(owner) &&
    manualLanes(owner.core, customInstructions).length === 0;

  const closeSettlingWindow = (): void => {
    rt.settling = false;
  };

  pi.on("session_start", async (_event, ctx) => {
    closeSettlingWindow();
    // Shutdown withdrew this registration's consent resolver; a reactivation publishes it again.
    publishConsent(rt);
    publishPreferences(rt, ctx, childProvider);
    // Stub watcher until the Codex eligibility unit fills it; disposed at shutdown.
    rt.unwatchCodexEligibility ??= watchCodexEligibility(rt, () => {});
    const shutdownCount = shutdowns.count;
    const lanes = await syncLanesAtSessionStart(rt, ctx);
    if (shutdownCount !== shutdowns.count) return;
    await startMainSession(rt, ctx, { reloadSettings: true, childProvider });
    if (lanes === undefined || shutdownCount !== shutdowns.count) return;
    warnOnProjectLanes(rt, ctx, lanes);
  });
  pi.on("model_select", async (_event, ctx) => {
    closeSettlingWindow();
    // A new model is a new provider scope: replace the owner, keep the settings.
    await startMainSession(rt, ctx, { reloadSettings: false, childProvider });
  });
  pi.on("session_tree", (_event, ctx) => onSessionTree(rt, ctx));
  pi.on("session_shutdown", () => {
    closeSettlingWindow();
    shutdowns.count += 1;
    releaseCompactCommandBridge(deferTypedCompact);
    releaseSessionCompactBridge(deferSessionCompact);
    shutdown(rt);
  });
  pi.on("turn_start", (_event, ctx) => {
    closeSettlingWindow();
    return settleCurrentOwner(rt, ctx);
  });
  pi.on("turn_end", (event, ctx) => adoptAtBoundary(rt, event, ctx));
  pi.on("agent_before_settle", (event, ctx) => adoptAtBoundary(rt, event, ctx));
  // Pi awaits agent_end before the run settles and emits agent_settled: the window is open
  // for every agent_settled handler, whichever extension loaded first.
  pi.on("agent_end", () => {
    rt.settling = true;
  });
  // The window stays open through the whole agent_settled emission, whatever the load order.
  pi.on("agent_settled", (_event, ctx) => observeSettled(rt, ctx));
  pi.on("input", async (event, ctx) => {
    // The settled emission and Pi's deferred actions are over once a prompt gets here.
    closeSettlingWindow();
    // Steer/follow-up input arrives while a run is active: never compact then.
    if (event.streamingBehavior !== undefined) return undefined;
    await adoptOnIdleInput(rt, ctx);
    return undefined;
  });
  // The compaction callback has completed; its entry is on the branch.
  pi.on("session_compact", (_event, ctx) => settleCurrentOwner(rt, ctx));
  pi.on("session_compact_failed", (_event, ctx) => onCompactFailed(rt, ctx));
  // Registered last among this extension's before_provider_request handlers.
  pi.on("before_provider_request", (event, ctx) => rt.replay.handler(event, ctx));
  pi.on("before_provider_request", (event, ctx) => rt.xaiReplay.handler(event, ctx));

  return {
    beforeCompact: (event, ctx) => answerBeforeCompact(rt, event, ctx),
    childAdopts: (event, ctx) => childAdopts(event, ctx),
    // The two owners are disjoint (anthropic-messages vs the xai provider), so at most one answers.
    foregroundCompact: async (event, ctx) =>
      (await foreground(event, ctx)) ?? (await xaiForeground(event, ctx)),
    settings: () => rt.loaded,
    modes: () => rt.modes(),
  };
}

/**
 * Publish this registration's opaque-loss consent on the process-global slot
 * unless it is published already. Shutdown removes it (`unpublishOpaqueConsent`),
 * so a shut-down registration and its runtime stay unreachable from the slot.
 * Consent is answered only for sessions bound to this registration.
 */
function publishConsent(rt: HostRuntime): void {
  rt.unpublishOpaqueConsent ??= publishOpaqueConsent(
    (sessionId, entryId) =>
      rt.nativeSessions.has(sessionId) && lossAuthorized(rt, sessionId, entryId),
  );
}

/**
 * What a replay request saw when it started: the lifecycle generation and the
 * session's replay binding (the unbind the binder returned for its newest
 * binding token, so it changes with every rebind).
 */
interface ReplayRequestStart {
  readonly lifecycle: number;
  readonly sessionId: string;
  readonly binding: (() => void) | undefined;
}

/**
 * Request starts keyed by the request's `ctx`: Pi creates one context per
 * event emission, and the binder hands that same object to the diagnostic and
 * disable callbacks of the request, including a late rejection's.
 */
type ReplayRequests = WeakMap<ExtensionContext, ReplayRequestStart>;

/**
 * Wrap a binder's `before_provider_request` handler so every request records
 * its start (generation and binding) before the binder sees it.
 */
function trackRequestStart<E, R>(
  track: {
    readonly requests: ReplayRequests;
    readonly lifecycle: () => number;
    readonly unbinds: () => Map<string, () => void>;
  },
  handler: (event: E, ctx: ExtensionContext) => R,
): (event: E, ctx: ExtensionContext) => R {
  return (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    track.requests.set(ctx, {
      lifecycle: track.lifecycle(),
      sessionId,
      binding: track.unbinds().get(sessionId),
    });
    return handler(event, ctx);
  };
}

/**
 * Whether the request behind a binder callback still belongs to the current
 * lifecycle generation and the session's current binding. Checked before the
 * callback touches `ctx`, journals or notifies: a late provider callback of a
 * request started before a shutdown, session or model change (rebind) is
 * dropped silently.
 */
function requestCurrent(
  rt: HostRuntime,
  requests: ReplayRequests,
  unbinds: Map<string, () => void>,
  ctx: ExtensionContext,
): boolean {
  const start = requests.get(ctx);
  return (
    start !== undefined &&
    start.binding !== undefined &&
    start.lifecycle === rt.lifecycle &&
    unbinds.get(start.sessionId) === start.binding
  );
}

function createRuntime(
  pi: ExtensionAPI,
  readState: SessionStateReader,
  options: BackgroundCompactionOptions,
): HostRuntime {
  const notify = createNotifier();
  const serverSide = new AnthropicServerSideSession();
  const xaiServerSide = new AnthropicServerSideSession();
  const clock = options.clock;
  const now = clock === undefined ? undefined : () => clock.now();
  const anthropicRequests: ReplayRequests = new WeakMap();
  const xaiRequests: ReplayRequests = new WeakMap();
  const anthropicCurrent = (ctx: ExtensionContext): boolean =>
    requestCurrent(rt, anthropicRequests, rt.replayUnbinds, ctx);
  const xaiCurrent = (ctx: ExtensionContext): boolean =>
    requestCurrent(rt, xaiRequests, rt.xaiReplayUnbinds, ctx);
  const replay = createAnthropicReplayBinder(pi, {
    providers: capturedProviders(options.anthropic?.allowList),
    capture: options.anthropic?.capture,
    session: serverSide,
    onDiagnostic: (ctx, diagnostic) => {
      if (anthropicCurrent(ctx)) reportReplayDiagnostic(rt, ctx, diagnostic);
    },
    onDisabled: (ctx, code) => {
      if (anthropicCurrent(ctx)) reportServerSideDisabled(rt, ctx, code);
    },
  });
  const xaiReplay = createXaiReplayBinder(pi, {
    providers: xaiCapturedProviders(options.xai?.allowList),
    capture: options.xai?.capture,
    session: xaiServerSide,
    onDiagnostic: (ctx, diagnostic) => {
      if (xaiCurrent(ctx)) reportXaiReplayDiagnostic(rt, ctx, diagnostic);
    },
    onDisabled: (ctx, code) => {
      if (xaiCurrent(ctx)) reportXaiServerSideDisabled(rt, ctx, code);
    },
    announce: (ctx, record, text, level, policy) => {
      if (xaiCurrent(ctx)) announce(rt, ctx, record, text, level, policy);
    },
  });
  const rt: HostRuntime = {
    pi,
    readState,
    options,
    notify,
    journal: (record) => {
      // No session bound to this registration (before the first start, after shutdown).
      if (rt.nativeSessions.size === 0) return;
      appendLaneRecord(
        (customType, data) => pi.appendEntry(customType, data),
        record,
        (message) => notify(rt.main?.lastCtx ?? rt.parent?.ctx, message),
      );
    },
    transitions: new LaneTransitionMemo(),
    opaqueHistory: DEFAULT_OPAQUE_HISTORY_MODE,
    opaqueConsent: new Map(),
    unpublishOpaqueConsent: undefined,
    onReplayDisabled: undefined,
    childProvider: undefined,
    unwatchCodexEligibility: undefined,
    modes: () => ({
      anthropic: rt.anthropicMode,
      xai: rt.xaiMode,
      opaqueHistory: rt.opaqueHistory,
    }),
    lifecycle: 0,
    main: undefined,
    loaded: {
      settings: { ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS },
      source: undefined,
      diagnostic: undefined,
    },
    unpublishProvider: undefined,
    unpublishPreferences: undefined,
    unregisterResourceCleanup: undefined,
    parent: undefined,
    anthropicMode: DEFAULT_ANTHROPIC_COMPACTION_MODE,
    serverSide,
    foregroundGate: new AnthropicCapabilityGate({
      enabled: true,
      cooldownMs: DEFAULT_BACKGROUND_COMPACTION_SETTINGS.cooldownMs,
      allowList: options.anthropic?.allowList,
      now: clock === undefined ? undefined : () => clock.now(),
      onCooldown: (entry, reason, until) =>
        announceCooldown(rt, "anthropic", { entry, reason, until }),
    }),
    replay: {
      ...replay,
      handler: trackRequestStart(
        {
          requests: anthropicRequests,
          lifecycle: () => rt.lifecycle,
          unbinds: () => rt.replayUnbinds,
        },
        replay.handler,
      ),
    },
    replayUnbinds: new Map(),
    xaiMode: DEFAULT_XAI_COMPACTION_MODE,
    xaiServerSide,
    xaiGate: createXaiCapabilityGate({
      cooldownMs: DEFAULT_BACKGROUND_COMPACTION_SETTINGS.cooldownMs,
      allowList: options.xai?.allowList,
      now,
      onCooldown: (entry, reason, until) => announceCooldown(rt, "xai", { entry, reason, until }),
    }),
    xaiReplay: {
      ...xaiReplay,
      handler: trackRequestStart(
        {
          requests: xaiRequests,
          lifecycle: () => rt.lifecycle,
          unbinds: () => rt.xaiReplayUnbinds,
        },
        xaiReplay.handler,
      ),
    },
    xaiReplayUnbinds: new Map(),
    detachedUnbinds: [],
    nativeSessions: new Set(),
    unregisterNativeRefresher: undefined,
    settling: false,
  };
  rt.onReplayDisabled = (sessionId, provider) => cancelDisabledCandidate(rt, sessionId, provider);
  return rt;
}

/** Candidate states a replay disable cancels; an `adopting` proposal is the host's already. */
const CANCELABLE_ON_DISABLE: ReadonlySet<CandidateState> = new Set<CandidateState>([
  "queued",
  "preparing",
  "ready",
]);

/**
 * A replay rejection turned Anthropic server-side off for `sessionId` (D7):
 * the main owner's outstanding `anthropic-native` candidate for that session
 * is cancelled (`disabled`); later threshold work selects the text lane.
 */
function cancelDisabledCandidate(
  rt: HostRuntime,
  sessionId: string,
  provider: "anthropic" | "xai",
): void {
  if (provider !== "anthropic") return;
  const owner = rt.main;
  if (owner === undefined || !isCurrent(rt, owner) || owner.core.sessionId !== sessionId) return;
  const status = owner.core.coordinator.status();
  if (status.backendId !== ANTHROPIC_BACKEND_ID || !CANCELABLE_ON_DISABLE.has(status.state)) return;
  owner.core.coordinator.cancel("disabled");
}

/** The session a registration-wide event (a gate cooldown) is journaled under, if one is bound. */
function boundSessionId(rt: HostRuntime): string | undefined {
  const main = rt.main;
  if (main !== undefined && isCurrent(rt, main)) return main.core.sessionId;
  return [...rt.nativeSessions].at(-1);
}

/**
 * A capability gate started a cooldown for a provider scope: journal it once
 * per session and reason, with its end, and notice it (no host context: journal only).
 */
function announceCooldown(
  rt: HostRuntime,
  provider: "anthropic" | "xai",
  cooldown: {
    readonly entry: AnthropicSupportEntry;
    readonly reason: FailureReason;
    readonly until: number;
  },
): void {
  const sessionId = boundSessionId(rt);
  if (sessionId === undefined) return;
  const label = provider === "anthropic" ? "Anthropic" : "xAI";
  announce(
    rt,
    rt.main?.lastCtx ?? rt.parent?.ctx,
    {
      at: nowOf(rt),
      sessionId,
      provider,
      route: "foreground",
      event: "cooldown",
      from: provider === "anthropic" ? "anthropic-native" : "xai-native",
      reason: ownedReasonOf(cooldown.reason),
      cooldownUntil: cooldown.until,
    },
    `${label} server-side compaction for ${cooldown.entry.model} is cooling down after a failure (${cooldown.reason}); compactions use the local summarizer until ${new Date(cooldown.until).toISOString()}`,
    "warning",
    "per-session-reason",
  );
}

/** A main session offers the Preferences row; a child session never does. */
function publishPreferences(
  rt: HostRuntime,
  ctx: ExtensionContext,
  childProvider: ChildCompactionProvider,
): void {
  if (rt.unpublishPreferences !== undefined) return;
  if (isChildSession(ctx.sessionManager.getSessionId())) return;
  rt.unpublishPreferences = publishBackgroundCompactionPreferences({
    enabled: () => rt.loaded.settings.enabled,
    setEnabled: (enabled, commandCtx) => applyEnabled(rt, { enabled, commandCtx, childProvider }),
    anthropic: {
      mode: () => rt.anthropicMode,
      set: (mode, commandCtx) => applyAnthropicMode(rt, { mode, commandCtx, childProvider }),
    },
    xai: {
      mode: () => rt.xaiMode,
      set: (mode, commandCtx) => applyXaiMode(rt, { mode, commandCtx, childProvider }),
    },
  });
}

/** Host scalars for a settings change, snapshotted before the first await. */
function locationOf(ctx: ExtensionContext): SettingsLocation {
  return { cwd: ctx.cwd, agentDir: getAgentDir(), projectTrusted: ctx.isProjectTrusted() };
}

/**
 * Codex's current `responsesCompaction`, re-read so an OpenAI-row change made
 * earlier in this session is seen; the session-start snapshot when unreadable.
 */
function codexServerSide(rt: HostRuntime, location: SettingsLocation): boolean {
  try {
    return readCodexCompactionSnapshot(location.cwd, location.projectTrusted).responsesCompaction;
  } catch {
    return rt.readState().codexCompaction?.responsesCompaction ?? false;
  }
}

function lanesFor(
  rt: HostRuntime,
  location: SettingsLocation,
  anthropicMode: AnthropicCompactionMode,
): BackgroundLaneSwitches {
  return deriveBackgroundLanes({
    openaiServerSide: codexServerSide(rt, location),
    anthropicServerSide: anthropicMode === "server-side",
  });
}

/**
 * Bring an existing global sidecar's backend switches in line with the vendor
 * rows before the settings load. A missing sidecar stays missing, and a
 * malformed one is left to the settings load to report. Returns the derived
 * switches; undefined inside a child session, which stays inert.
 */
async function syncLanesAtSessionStart(
  rt: HostRuntime,
  ctx: ExtensionContext,
): Promise<BackgroundLaneSwitches | undefined> {
  if (isChildSession(ctx.sessionManager.getSessionId())) return undefined;
  const location = locationOf(ctx);
  const readMode = rt.options.anthropic?.readMode ?? readAnthropicCompactionMode;
  const lanes = deriveBackgroundLanes({
    openaiServerSide: rt.readState().codexCompaction?.responsesCompaction ?? false,
    anthropicServerSide: (await readMode(location.agentDir)) === "server-side",
  });
  try {
    await writeGlobalBackgroundSettings(location.agentDir, { lanes, onlyIfExists: true });
  } catch (cause) {
    if (!(cause instanceof SidecarRefusedError)) {
      rt.notify(ctx, `backend switches not updated: ${errorText(cause)}`);
    }
  }
  return lanes;
}

/** One notice when a trusted project's sidecar overrides the derived backend switches. */
function warnOnProjectLanes(
  rt: HostRuntime,
  ctx: ExtensionContext,
  lanes: BackgroundLaneSwitches,
): void {
  const location = locationOf(ctx);
  if (!location.projectTrusted) return;
  const { source, settings, diagnostic } = rt.loaded;
  if (diagnostic !== undefined || source !== backgroundSettingsPaths(location)[0]) return;
  if (
    settings.text === lanes.text &&
    settings.codexNative === lanes.codexNative &&
    settings.anthropicNative === lanes.anthropicNative
  ) {
    return;
  }
  rt.notify(
    ctx,
    `${source} sets text=${settings.text}, codexNative=${settings.codexNative}, anthropicNative=${settings.anthropicNative}; it overrides the OpenAI and Anthropic compaction rows (text=${lanes.text}, codexNative=${lanes.codexNative}, anthropicNative=${lanes.anthropicNative})`,
  );
}

/**
 * Save the master switch with the backend switches derived from the vendor
 * rows, then reload the settings and replace the main owner in place:
 * switching on registers a coordinator for the running session, switching off
 * disposes it and cancels its candidate before any later boundary.
 */
async function applyEnabled(
  rt: HostRuntime,
  change: {
    readonly enabled: boolean;
    readonly commandCtx: ExtensionContext;
    readonly childProvider: ChildCompactionProvider;
  },
): Promise<void> {
  try {
    const location = locationOf(change.commandCtx);
    await writeGlobalBackgroundSettings(location.agentDir, {
      enabled: change.enabled,
      lanes: lanesFor(rt, location, rt.anthropicMode),
    });
    const ctx = rt.parent?.ctx;
    if (ctx === undefined) return;
    await startMainSession(rt, ctx, { reloadSettings: true, childProvider: change.childProvider });
  } catch (cause) {
    if (cause instanceof Error && isStaleContextError(cause)) return;
    rt.notify(change.commandCtx, `setting not applied: ${errorText(cause)}`);
  }
}

/**
 * Save the Anthropic compaction mode, re-derive an existing global sidecar's
 * backend switches, then reload and replace the main owner in place so the
 * foreground path, the replay binding and the background lanes all follow the
 * new mode in the running session. A refused sidecar update is reported but
 * does not undo the saved mode.
 */
async function applyAnthropicMode(
  rt: HostRuntime,
  change: {
    readonly mode: AnthropicCompactionMode;
    readonly commandCtx: ExtensionContext;
    readonly childProvider: ChildCompactionProvider;
  },
): Promise<void> {
  try {
    const location = locationOf(change.commandCtx);
    const lifecycle = rt.lifecycle;
    await writeAnthropicCompactionMode(location.agentDir, change.mode);
    if (lifecycle === rt.lifecycle) rt.anthropicMode = change.mode;
    try {
      await writeGlobalBackgroundSettings(location.agentDir, {
        lanes: lanesFor(rt, location, change.mode),
        onlyIfExists: true,
      });
    } catch (cause) {
      rt.notify(change.commandCtx, `backend switches not updated: ${errorText(cause)}`);
    }
    const ctx = rt.parent?.ctx;
    if (ctx === undefined) return;
    await startMainSession(rt, ctx, { reloadSettings: true, childProvider: change.childProvider });
  } catch (cause) {
    if (cause instanceof Error && isStaleContextError(cause)) return;
    rt.notify(change.commandCtx, `Anthropic compaction not applied: ${errorText(cause)}`);
  }
}

/** A branch switch invalidates the frozen prefix of any candidate. */
function onSessionTree(rt: HostRuntime, ctx: ExtensionContext): void {
  const owner = touchCurrentOwner(rt, ctx);
  if (owner === undefined) return;
  owner.core.bumpBranch();
  owner.core.coordinator.cancel("stale-prefix");
}

/**
 * Save the xAI compaction mode, then reload and replace the main owner in
 * place so the foreground path, the replay binding and the background lane
 * selection follow the new mode in the running session.
 */
async function applyXaiMode(
  rt: HostRuntime,
  change: {
    readonly mode: XaiCompactionMode;
    readonly commandCtx: ExtensionContext;
    readonly childProvider: ChildCompactionProvider;
  },
): Promise<void> {
  try {
    const location = locationOf(change.commandCtx);
    const lifecycle = rt.lifecycle;
    await writeXaiCompactionMode(location.agentDir, change.mode);
    if (lifecycle === rt.lifecycle) rt.xaiMode = change.mode;
    const ctx = rt.parent?.ctx;
    if (ctx === undefined) return;
    await startMainSession(rt, ctx, { reloadSettings: true, childProvider: change.childProvider });
  } catch (cause) {
    if (cause instanceof Error && isStaleContextError(cause)) return;
    rt.notify(change.commandCtx, `xAI compaction not applied: ${errorText(cause)}`);
  }
}

async function settleCurrentOwner(rt: HostRuntime, ctx: ExtensionContext): Promise<void> {
  const owner = touchCurrentOwner(rt, ctx);
  if (owner === undefined) return;
  await owner.core.settle();
}

async function onCompactFailed(rt: HostRuntime, ctx: ExtensionContext): Promise<void> {
  const owner = touchCurrentOwner(rt, ctx);
  if (owner === undefined) return;
  await reportHostRefused(rt, owner, ctx);
}

function nowOf(rt: HostRuntime): number {
  return rt.options.clock?.now() ?? Date.now();
}

/**
 * The journaled reason of a replay code: our own refusal and disable codes
 * as they are; a provider-supplied code (`compaction_*` from
 * `error.details.error_code`) or a missing one is `provider-error`.
 */
function replayReason(code: string | undefined): LaneReason {
  return code === undefined ? REASONS.providerError : ownedReasonOf(code);
}

/**
 * Journal a replay diagnostic once per transition and notify through the
 * registration notifier exactly as before the journal existed (each distinct
 * text once per registration).
 */
function announceReplayDiagnostic(
  rt: HostRuntime,
  ctx: ExtensionContext,
  record: Pick<LaneRecordInput, "sessionId" | "provider" | "event" | "from" | "reason"> & {
    readonly checkpointEntryId: string;
  },
  text: string,
): void {
  announce(
    rt,
    ctx,
    { ...record, at: nowOf(rt), route: "replay" },
    text,
    "warning",
    "per-session-reason",
  );
}

function reportReplayDiagnostic(
  rt: HostRuntime,
  ctx: ExtensionContext,
  diagnostic: ReplayDiagnostic,
): void {
  if (diagnostic.kind === "rewritten") return;
  const base = {
    sessionId: diagnostic.sessionId,
    provider: "anthropic",
    from: "anthropic-native",
    checkpointEntryId: diagnostic.entryId,
  } as const;
  if (diagnostic.kind === "unverifiable") {
    announceReplayDiagnostic(
      rt,
      ctx,
      { ...base, event: "fallback", reason: REASONS.unverifiable },
      `Anthropic native checkpoint ${diagnostic.entryId} could not be verified at the transport; its summary text is sent instead`,
    );
    return;
  }
  const reason = replayReason(diagnostic.code);
  if (diagnostic.kind === "fallback") {
    announceReplayDiagnostic(
      rt,
      ctx,
      { ...base, event: "fallback", reason },
      `Anthropic native replay skipped (${diagnostic.code ?? "unknown"}) for checkpoint ${diagnostic.entryId}; its summary text is sent instead`,
    );
    return;
  }
  announceReplayDiagnostic(
    rt,
    ctx,
    { ...base, event: "refuse", reason },
    `Anthropic native replay refused (${diagnostic.code ?? "unknown"}) for checkpoint ${diagnostic.entryId}`,
  );
}

/** The replayed Anthropic checkpoint: the branch's newest compaction entry, when it is Anthropic-native. */
function anthropicCheckpointId(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "compaction") continue;
    return isAnthropicDetails(entry.details) ? entry.id : undefined;
  }
  return undefined;
}

function xaiCheckpointId(ctx: ExtensionContext): string | undefined {
  const lookup = findActiveXaiCheckpoint(ctx.sessionManager.getBranch());
  if (lookup.kind === "none") return undefined;
  return lookup.kind === "active" ? lookup.checkpoint.entryId : lookup.entryId;
}

/**
 * One journaled, always-notified disable per session (the replay binder calls
 * this once per session), then the `onReplayDisabled` seam. A stale context
 * (the session is gone) is contained.
 */
function reportReplayDisabled(
  rt: HostRuntime,
  ctx: ExtensionContext,
  disabled: {
    readonly provider: "anthropic" | "xai";
    readonly code: string;
    readonly text: string;
    readonly checkpointId: (ctx: ExtensionContext) => string | undefined;
  },
): void {
  let sessionId: string;
  let checkpointEntryId: string | undefined;
  try {
    sessionId = ctx.sessionManager.getSessionId();
    checkpointEntryId = disabled.checkpointId(ctx);
  } catch (cause) {
    if (cause instanceof Error && isStaleContextError(cause)) return;
    throw cause;
  }
  const { provider, code } = disabled;
  announce(
    rt,
    ctx,
    {
      at: nowOf(rt),
      sessionId,
      provider,
      route: "replay",
      event: "disable",
      from: provider === "anthropic" ? "anthropic-native" : "xai-native",
      reason: replayReason(code),
      checkpointEntryId,
    },
    disabled.text,
    "warning",
    "always",
  );
  rt.onReplayDisabled?.(sessionId, provider, code);
}

/** One notice per session when the provider rejected a replayed block. */
function reportServerSideDisabled(rt: HostRuntime, ctx: ExtensionContext, code: string): void {
  reportReplayDisabled(rt, ctx, {
    provider: "anthropic",
    code,
    text: `Anthropic server-side compaction: the provider rejected the replayed checkpoint (${code}); server-side compaction is off for this session, its summary text is sent instead and later compactions are summarized locally.`,
    checkpointId: anthropicCheckpointId,
  });
}

/** What happens to later requests over an xAI checkpoint that is no longer replayed (`unreplayable` in `xai/replay.ts`). */
const XAI_REFUSED_UNTIL =
  "later requests over this checkpoint are refused until you run /compaction-allow-loss or create a new xAI checkpoint";

function reportXaiReplayDiagnostic(
  rt: HostRuntime,
  ctx: ExtensionContext,
  diagnostic: XaiReplayDiagnostic,
): void {
  if (diagnostic.kind === "rewritten") return;
  const base = {
    sessionId: diagnostic.sessionId,
    provider: "xai",
    from: "xai-native",
    checkpointEntryId: diagnostic.entryId,
  } as const;
  if (diagnostic.kind === "unverifiable") {
    announceReplayDiagnostic(
      rt,
      ctx,
      { ...base, event: "fallback", reason: REASONS.unverifiable },
      `xAI native checkpoint ${diagnostic.entryId} could not be verified at the transport; ${XAI_REFUSED_UNTIL}`,
    );
    return;
  }
  announceReplayDiagnostic(
    rt,
    ctx,
    { ...base, event: "refuse", reason: replayReason(diagnostic.code) },
    `xAI native replay refused (${diagnostic.code ?? "unknown"}) for checkpoint ${diagnostic.entryId}`,
  );
}

/** One notice per session when a replay refusal or provider rejection turned xAI server-side off. */
function reportXaiServerSideDisabled(rt: HostRuntime, ctx: ExtensionContext, code: string): void {
  reportReplayDisabled(rt, ctx, {
    provider: "xai",
    code,
    text: `xAI server-side compaction: the replayed checkpoint was refused (${code}); server-side compaction is off for this session; ${XAI_REFUSED_UNTIL}.`,
    checkpointId: xaiCheckpointId,
  });
}

/**
 * `/compaction-allow-loss`: consent, for this session and the branch's
 * current opaque checkpoint only, to compaction summarizing without the
 * provider-held history. Journaled with the checkpoint id.
 */
function allowOpaqueLoss(rt: HostRuntime, ctx: ExtensionContext): void {
  const sessionId = ctx.sessionManager.getSessionId();
  const opaque = opaqueCheckpointOf(ctx.sessionManager.getBranch());
  if (opaque === undefined) {
    tell(ctx, "no opaque checkpoint on this branch", "info");
    return;
  }
  rt.opaqueConsent.set(sessionId, opaque.entryId);
  rt.journal({
    at: nowOf(rt),
    sessionId,
    provider: opaqueProviderOf(opaque.owner),
    route: "manual",
    event: "consent",
    from: opaqueLaneOf(opaque.owner),
    reason: REASONS.consent,
    checkpointEntryId: opaque.entryId,
    noticeAttempted: true,
  });
  tell(ctx, `loss authorized for checkpoint ${opaque.entryId} (this session only)`, "info");
}

async function answerBeforeCompact(
  rt: HostRuntime,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
): Promise<SessionBeforeCompactResult | undefined> {
  const owner = touchCurrentOwner(rt, ctx);
  if (owner === undefined) return undefined;
  const decision = await decide(rt, owner, event);
  if (decision.action === "adopt") return { compaction: decision.compaction };
  if (decision.action === "cancel") return { cancel: true };
  return undefined;
}

async function childAdopts(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
): Promise<boolean> {
  const sessionId = ctx.sessionManager.getSessionId();
  if (!isChildSession(sessionId)) return false;
  return (await getBackgroundAdoptionSignal().willAdopt(sessionId, event)) === true;
}
