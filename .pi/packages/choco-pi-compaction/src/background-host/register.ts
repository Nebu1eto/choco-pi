import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { ChildCompactionProvider } from "../../../choco-pi-subagents/src/child-compaction-bridge.ts";
import { AnthropicCapabilityGate, capturedProviders } from "../anthropic/capability.ts";
import { capturesFor } from "../anthropic/capture.ts";
import { createForegroundCompactHandler } from "../anthropic/foreground.ts";
import {
  AnthropicServerSideSession,
  type AnthropicCompactionMode,
  DEFAULT_ANTHROPIC_COMPACTION_MODE,
  readAnthropicCompactionMode,
  writeAnthropicCompactionMode,
} from "../anthropic/mode.ts";
import { createAnthropicReplayBinder } from "../anthropic/replay-binding.ts";
import type { ReplayDiagnostic } from "../anthropic/replay-rewrite.ts";
import { DEFAULT_BACKGROUND_COMPACTION_SETTINGS } from "../background/contract.ts";
import {
  type BackgroundLaneSwitches,
  backgroundSettingsPaths,
  deriveBackgroundLanes,
  type LoadedBackgroundSettings,
  type SettingsLocation,
  SidecarRefusedError,
  writeGlobalBackgroundSettings,
} from "../background/settings.ts";
import { isStaleContextError } from "../lifecycle.ts";
import { isChildSession } from "../ownership.ts";
import { publishBackgroundCompactionPreferences } from "../preferences-section.ts";
import { readCodexCompactionSnapshot, type SessionStateReader } from "../session-state.ts";
import {
  getBackgroundAdoptionSignal,
  publishBackgroundAdoptionSignalSlot,
} from "./adoption-signal.ts";
import { createChildProvider } from "./child-provider.ts";
import { startMainSession } from "./main-session.ts";
import { createNotifier, errorText } from "./notices.ts";
import type { BackgroundCompactionOptions } from "./owner-spec.ts";
import {
  adoptAtBoundary,
  adoptOnIdleInput,
  decide,
  observeSettled,
  reportHostRefused,
} from "./routes.ts";
import { type HostRuntime, shutdown, touchCurrentOwner } from "./runtime.ts";

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
   * Answer session_before_compact with Anthropic server-side compaction, or
   * undefined to let the local summarizer answer the same compaction.
   */
  foregroundCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<SessionBeforeCompactResult | undefined>;
  /** Current settings load (for diagnostics and tests). */
  settings(): LoadedBackgroundSettings;
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
  });
  /** Bumped by every session_shutdown; a session start awaiting I/O stops when it moved. */
  const shutdowns = { count: 0 };

  pi.on("session_start", async (_event, ctx) => {
    publishPreferences(rt, ctx, childProvider);
    const shutdownCount = shutdowns.count;
    const lanes = await syncLanesAtSessionStart(rt, ctx);
    if (shutdownCount !== shutdowns.count) return;
    await startMainSession(rt, ctx, { reloadSettings: true, childProvider });
    if (lanes === undefined || shutdownCount !== shutdowns.count) return;
    warnOnProjectLanes(rt, ctx, lanes);
  });
  pi.on("model_select", async (_event, ctx) => {
    // A new model is a new provider scope: replace the owner, keep the settings.
    await startMainSession(rt, ctx, { reloadSettings: false, childProvider });
  });
  pi.on("session_tree", (_event, ctx) => onSessionTree(rt, ctx));
  pi.on("session_shutdown", () => {
    shutdowns.count += 1;
    shutdown(rt);
  });
  pi.on("turn_start", (_event, ctx) => settleCurrentOwner(rt, ctx));
  pi.on("turn_end", (event, ctx) => adoptAtBoundary(rt, event, ctx));
  pi.on("agent_before_settle", (event, ctx) => adoptAtBoundary(rt, event, ctx));
  pi.on("agent_settled", (_event, ctx) => observeSettled(rt, ctx));
  pi.on("input", async (event, ctx) => {
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

  return {
    beforeCompact: (event, ctx) => answerBeforeCompact(rt, event, ctx),
    childAdopts: (event, ctx) => childAdopts(event, ctx),
    foregroundCompact: (event, ctx) => foreground(event, ctx),
    settings: () => rt.loaded,
  };
}

function createRuntime(
  pi: ExtensionAPI,
  readState: SessionStateReader,
  options: BackgroundCompactionOptions,
): HostRuntime {
  const notify = createNotifier();
  const serverSide = new AnthropicServerSideSession();
  const clock = options.clock;
  const rt: HostRuntime = {
    pi,
    readState,
    options,
    notify,
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
    }),
    replay: createAnthropicReplayBinder(pi, {
      providers: capturedProviders(options.anthropic?.allowList),
      capture: options.anthropic?.capture,
      session: serverSide,
      onDiagnostic: (ctx, diagnostic) => reportReplayDiagnostic(notify, ctx, diagnostic),
      onDisabled: (ctx, code) => reportServerSideDisabled(ctx, code),
    }),
    unbindReplay: undefined,
  };
  return rt;
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

function reportReplayDiagnostic(
  notify: HostRuntime["notify"],
  ctx: ExtensionContext,
  diagnostic: ReplayDiagnostic,
): void {
  if (diagnostic.kind === "rewritten") return;
  if (diagnostic.kind === "unverifiable") {
    notify(
      ctx,
      `Anthropic native checkpoint ${diagnostic.entryId} could not be verified at the transport; its summary text is sent instead`,
    );
    return;
  }
  notify(
    ctx,
    `Anthropic native replay refused (${diagnostic.code ?? "unknown"}) for checkpoint ${diagnostic.entryId}`,
  );
}

/** One notice per session when the provider rejected a replayed block. */
function reportServerSideDisabled(ctx: ExtensionContext, code: string): void {
  try {
    ctx.ui.notify(
      `Anthropic server-side compaction: the provider rejected the replayed checkpoint (${code}); server-side compaction is off for this session, its summary text is sent instead and later compactions are summarized locally.`,
      "warning",
    );
  } catch (cause) {
    if (!(cause instanceof Error && isStaleContextError(cause))) throw cause;
  }
}

async function answerBeforeCompact(
  rt: HostRuntime,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
): Promise<SessionBeforeCompactResult | undefined> {
  const owner = touchCurrentOwner(rt, ctx);
  if (owner === undefined) return undefined;
  const decision = await decide(rt, owner, event);
  return decision.action === "adopt" ? { compaction: decision.compaction } : undefined;
}

async function childAdopts(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
): Promise<boolean> {
  const sessionId = ctx.sessionManager.getSessionId();
  if (!isChildSession(sessionId)) return false;
  return (await getBackgroundAdoptionSignal().willAdopt(sessionId, event)) === true;
}
