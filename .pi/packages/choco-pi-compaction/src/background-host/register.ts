import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { ChildCompactionProvider } from "../../../choco-pi-subagents/src/child-compaction-bridge.ts";
import { createReplayRewriteHandler, type ReplayDiagnostic } from "../anthropic/replay-rewrite.ts";
import { DEFAULT_BACKGROUND_COMPACTION_SETTINGS } from "../background/contract.ts";
import {
  type LoadedBackgroundSettings,
  writeGlobalBackgroundEnabled,
} from "../background/settings.ts";
import { isStaleContextError } from "../lifecycle.ts";
import { isChildSession } from "../ownership.ts";
import { publishBackgroundCompactionPreferences } from "../preferences-section.ts";
import type { SessionStateReader } from "../session-state.ts";
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

  pi.on("session_start", async (_event, ctx) => {
    publishPreferences(rt, ctx, childProvider);
    await startMainSession(rt, ctx, { reloadSettings: true, childProvider });
  });
  pi.on("model_select", async (_event, ctx) => {
    // A new model is a new provider scope: replace the owner, keep the settings.
    await startMainSession(rt, ctx, { reloadSettings: false, childProvider });
  });
  pi.on("session_tree", (_event, ctx) => onSessionTree(rt, ctx));
  pi.on("session_shutdown", () => {
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
  pi.on("before_provider_request", (event, ctx) => {
    if (!rt.replayActive) return undefined;
    return createReplayRewriteHandler({
      onDiagnostic: (diagnostic) => reportReplayDiagnostic(rt, ctx, diagnostic),
    })(event, ctx);
  });

  return {
    beforeCompact: (event, ctx) => answerBeforeCompact(rt, event, ctx),
    childAdopts: (event, ctx) => childAdopts(event, ctx),
    settings: () => rt.loaded,
  };
}

function createRuntime(
  pi: ExtensionAPI,
  readState: SessionStateReader,
  options: BackgroundCompactionOptions,
): HostRuntime {
  return {
    pi,
    readState,
    options,
    notify: createNotifier(),
    lifecycle: 0,
    main: undefined,
    loaded: {
      settings: { ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS },
      source: undefined,
      diagnostic: undefined,
    },
    unpublishProvider: undefined,
    unpublishPreferences: undefined,
    captureRegistered: false,
    unregisterResourceCleanup: undefined,
    replayActive: false,
    parent: undefined,
  };
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
  });
}

/**
 * Save the master switch, then reload the settings and replace the main owner
 * in place: switching on registers a coordinator for the running session,
 * switching off disposes it and cancels its candidate before any later boundary.
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
    await writeGlobalBackgroundEnabled(getAgentDir(), change.enabled);
    const ctx = rt.parent?.ctx;
    if (ctx === undefined) return;
    await startMainSession(rt, ctx, { reloadSettings: true, childProvider: change.childProvider });
  } catch (cause) {
    if (cause instanceof Error && isStaleContextError(cause)) return;
    rt.notify(change.commandCtx, `setting not applied: ${errorText(cause)}`);
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
  rt: HostRuntime,
  ctx: ExtensionContext,
  diagnostic: ReplayDiagnostic,
): void {
  if (diagnostic.kind === "rewritten") return;
  if (diagnostic.kind === "unverifiable") {
    rt.notify(
      ctx,
      `Anthropic native checkpoint ${diagnostic.entryId} could not be verified at the transport; its summary text is sent instead`,
    );
    return;
  }
  rt.notify(
    ctx,
    `Anthropic native replay refused (${diagnostic.code ?? "unknown"}) for checkpoint ${diagnostic.entryId}`,
  );
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
