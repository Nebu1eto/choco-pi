import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { ChildCompactionProvider } from "../background/child-provider-contract.ts";
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
import { isStaleContextError } from "@choco-pi/shared/lifecycle";
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
import {
  firstForegroundAnswer,
  type ForegroundCompactHandler,
  registeredForegroundHandlers,
} from "./backend-registry.ts";
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
  manualBypassesHost,
  observeSettled,
  reportHostRefused,
  startManualPreparation,
} from "./routes.ts";
import {
  type CompactionModes,
  type HostRuntime,
  isCurrent,
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

export interface BackgroundCompaction {
  beforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<SessionBeforeCompactResult | undefined>;
  childAdopts(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<boolean>;
  foregroundCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<SessionBeforeCompactResult | undefined>;
  settings(): LoadedBackgroundSettings;
  modes(): CompactionModes;
}

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
  const builtInForeground: readonly ForegroundCompactHandler[] = [foreground, xaiForeground];
  const shutdowns = { count: 0 };

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

  const deferSessionCompact = async (
    host: SessionCompactHost,
    customInstructions?: string,
  ): Promise<SessionCompactOutcome> => {
    if (!host.isIdle) return "declined";
    if (!backgroundCompactionActive(rt.loaded.settings)) return "declined";
    if (!registryUsable(rt, undefined)) return "declined";
    const owner = rt.main;
    if (owner === undefined || owner.core.sessionId !== host.sessionId) return "declined";
    if (!manualBypassesHost(rt, owner, customInstructions)) return "declined";
    if (await startManualPreparation(rt, owner, customInstructions)) return "handled";
    return isCurrent(rt, owner) ? "declined" : "stale";
  };
  installSessionCompactBridge(deferSessionCompact);

  pi.on("session_start", async (_event, ctx) => {
    publishConsent(rt);
    publishPreferences(rt, ctx, childProvider);
    rt.unwatchCodexEligibility ??= watchCodexEligibility(rt, () => {});
    const shutdownCount = shutdowns.count;
    const lanes = await syncLanesAtSessionStart(rt, ctx);
    if (shutdownCount !== shutdowns.count) return;
    await startMainSession(rt, ctx, { reloadSettings: true, childProvider });
    if (lanes === undefined || shutdownCount !== shutdowns.count) return;
    warnOnProjectLanes(rt, ctx, lanes);
  });
  pi.on("model_select", async (_event, ctx) => {
    await startMainSession(rt, ctx, { reloadSettings: false, childProvider });
  });
  pi.on("session_tree", (_event, ctx) => onSessionTree(rt, ctx));
  pi.on("session_shutdown", () => {
    shutdowns.count += 1;
    releaseCompactCommandBridge(deferTypedCompact);
    releaseSessionCompactBridge(deferSessionCompact);
    shutdown(rt);
  });
  pi.on("turn_start", (_event, ctx) => settleCurrentOwner(rt, ctx));
  pi.on("turn_end", (event, ctx) => adoptAtBoundary(rt, event, ctx));
  pi.on("agent_before_settle", (event, ctx) => adoptAtBoundary(rt, event, ctx));
  pi.on("agent_settled", (_event, ctx) => observeSettled(rt, ctx));
  pi.on("input", async (event, ctx) => {
    if (event.streamingBehavior !== undefined) return undefined;
    await adoptOnIdleInput(rt, ctx);
    return undefined;
  });
  pi.on("session_compact", (_event, ctx) => settleCurrentOwner(rt, ctx));
  pi.on("session_compact_failed", (_event, ctx) => onCompactFailed(rt, ctx));
  pi.on("before_provider_request", (event, ctx) => rt.replay.handler(event, ctx));
  pi.on("before_provider_request", (event, ctx) => rt.xaiReplay.handler(event, ctx));

  return {
    beforeCompact: (event, ctx) => answerBeforeCompact(rt, event, ctx),
    childAdopts: (event, ctx) => childAdopts(event, ctx),
    foregroundCompact: (event, ctx) =>
      firstForegroundAnswer([...builtInForeground, ...registeredForegroundHandlers()], event, ctx),
    settings: () => rt.loaded,
    modes: () => rt.modes(),
  };
}

function publishConsent(rt: HostRuntime): void {
  rt.unpublishOpaqueConsent ??= publishOpaqueConsent(
    (sessionId, entryId) =>
      rt.nativeSessions.has(sessionId) && lossAuthorized(rt, sessionId, entryId),
  );
}

interface ReplayRequestStart {
  readonly lifecycle: number;
  readonly sessionId: string;
  readonly binding: (() => void) | undefined;
}

type ReplayRequests = WeakMap<ExtensionContext, ReplayRequestStart>;

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
  };
  rt.onReplayDisabled = (sessionId, provider) => cancelDisabledCandidate(rt, sessionId, provider);
  return rt;
}

const CANCELABLE_ON_DISABLE: ReadonlySet<CandidateState> = new Set<CandidateState>([
  "queued",
  "preparing",
  "ready",
]);

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

function boundSessionId(rt: HostRuntime): string | undefined {
  const main = rt.main;
  if (main !== undefined && isCurrent(rt, main)) return main.core.sessionId;
  return [...rt.nativeSessions].at(-1);
}

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

function locationOf(ctx: ExtensionContext): SettingsLocation {
  return { cwd: ctx.cwd, agentDir: getAgentDir(), projectTrusted: ctx.isProjectTrusted() };
}

async function codexServerSide(rt: HostRuntime, location: SettingsLocation): Promise<boolean> {
  try {
    const snapshot = await readCodexCompactionSnapshot(location.cwd, location.projectTrusted);
    return snapshot.responsesCompaction;
  } catch {
    return rt.readState().codexCompaction?.responsesCompaction ?? false;
  }
}

async function lanesFor(
  rt: HostRuntime,
  location: SettingsLocation,
  anthropicMode: AnthropicCompactionMode,
): Promise<BackgroundLaneSwitches> {
  return deriveBackgroundLanes({
    openaiServerSide: await codexServerSide(rt, location),
    anthropicServerSide: anthropicMode === "server-side",
  });
}

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
      lanes: await lanesFor(rt, location, rt.anthropicMode),
    });
    const ctx = rt.parent?.ctx;
    if (ctx === undefined) return;
    await startMainSession(rt, ctx, { reloadSettings: true, childProvider: change.childProvider });
  } catch (cause) {
    if (cause instanceof Error && isStaleContextError(cause)) return;
    rt.notify(change.commandCtx, `setting not applied: ${errorText(cause)}`);
  }
}

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
        lanes: await lanesFor(rt, location, change.mode),
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

function onSessionTree(rt: HostRuntime, ctx: ExtensionContext): void {
  const owner = touchCurrentOwner(rt, ctx);
  if (owner === undefined) return;
  owner.core.bumpBranch();
  owner.core.coordinator.cancel("stale-prefix");
}

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

function replayReason(code: string | undefined): LaneReason {
  return code === undefined ? REASONS.providerError : ownedReasonOf(code);
}

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

function reportServerSideDisabled(rt: HostRuntime, ctx: ExtensionContext, code: string): void {
  reportReplayDisabled(rt, ctx, {
    provider: "anthropic",
    code,
    text: `Anthropic server-side compaction: the provider rejected the replayed checkpoint (${code}); server-side compaction is off for this session, its summary text is sent instead and later compactions are summarized locally.`,
    checkpointId: anthropicCheckpointId,
  });
}

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

function reportXaiServerSideDisabled(rt: HostRuntime, ctx: ExtensionContext, code: string): void {
  reportReplayDisabled(rt, ctx, {
    provider: "xai",
    code,
    text: `xAI server-side compaction: the replayed checkpoint was refused (${code}); server-side compaction is off for this session; ${XAI_REFUSED_UNTIL}.`,
    checkpointId: xaiCheckpointId,
  });
}

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
