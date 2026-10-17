import type {
  CompactionResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import type { LoadedBackgroundSettings } from "../background/settings.ts";
import { registryAvailability } from "../background/registry.ts";
import type { AnthropicCapabilityGate } from "../anthropic/capability.ts";
import type { AnthropicCompactionMode, AnthropicServerSideSession } from "../anthropic/mode.ts";
import type { AnthropicReplayBinder } from "../anthropic/replay-binding.ts";
import type { CompactionSessionState, SessionStateReader } from "../session-state.ts";
import type { XaiCompactionMode } from "../xai/mode.ts";
import type { XaiReplayBinder } from "../xai/replay.ts";
import { errorText, type Notifier } from "./notices.ts";
import type { OwnerCore } from "./owner-core.ts";
import type { BackgroundCompactionOptions } from "./owner-spec.ts";

// ---------------------------------------------------------------------------
// Per-registration host state shared by the session lifecycle, routes and
// child provider
// ---------------------------------------------------------------------------

export interface PendingRoute {
  readonly candidateId: string;
  readonly trigger: "idle" | "context-cap" | "manual";
}

export type Decision =
  | { readonly action: "proceed" }
  /** A plain `/compact` continues in the background; the host compaction is cancelled. */
  | { readonly action: "cancel" }
  | {
      readonly action: "adopt";
      readonly candidateId: string;
      readonly compaction: CompactionResult;
    };

/** One owned main session. */
export interface MainOwner {
  readonly core: OwnerCore;
  readonly generation: number;
  readonly decisions: WeakMap<SessionBeforeCompactEvent, Promise<Decision>>;
  /** Candidates the host refused on the idle route; boundary adoption remains possible. */
  readonly refusedIdle: Set<string>;
  pendingRoute: PendingRoute | undefined;
  /** Candidate a plain `/compact` is waiting on; adopted as soon as it is ready and the session is idle. */
  manualCandidate: string | undefined;
  /** Bumped by every new manual request; a follower whose serial moved is superseded and stops. */
  manualSerial: number;
  /**
   * Set when the `session_before_compact` hook answers `cancel`: the host's
   * `compact()` is still unwinding (it clears the shared compaction controller
   * in its `finally`, after every `session_compact_failed` handler), so the
   * manual follower must not adopt through `ctx.compact()` until a later host
   * boundary (`turn_end`, `agent_settled`, `input`), which the host emits
   * only after that invocation returned. Cleared at that boundary.
   */
  hostCompactUnwinding: boolean;
  /**
   * A host compaction requested while it must not start yet (from
   * `agent_settled`, where Pi defers an arriving prompt and would reject it
   * once a compaction is running). Run at the next safe idle point: the
   * following macrotask while idle, or the next prompt's `input` hook (before
   * that prompt starts its run).
   */
  idlePending: IdleRequest | undefined;
  /** The pending request while it runs; later requests join it. */
  idleRunning: Promise<void> | undefined;
  lastCtx: ExtensionContext;
  readonly cleanup: (() => void)[];
}

/**
 * A deferred host compaction: adopt the ready candidate (context cap), or run
 * the host's own compaction, which a native handler (Codex, xAI) answers.
 * `onSettled` runs exactly once with whether a compaction completed.
 */
export type IdleRequest =
  | {
      readonly kind: "adopt";
      readonly trigger: PendingRoute["trigger"];
      readonly onSettled: (compacted: boolean) => void;
    }
  | {
      readonly kind: "foreground";
      readonly customInstructions: string | undefined;
      readonly onSettled: (compacted: boolean) => void;
    };

/** The main session's host services a child attachment borrows. */
export interface ParentHost {
  readonly modelRegistry: ExtensionContext["modelRegistry"];
  readonly state: CompactionSessionState;
  readonly ctx: ExtensionContext;
}

export interface HostRuntime {
  readonly pi: ExtensionAPI;
  readonly readState: SessionStateReader;
  readonly options: BackgroundCompactionOptions;
  readonly notify: Notifier;
  /** Bumped by every session start and shutdown; owners compare their generation to it. */
  lifecycle: number;
  main: MainOwner | undefined;
  loaded: LoadedBackgroundSettings;
  unpublishProvider: (() => void) | undefined;
  /** Removes this registration's Preferences row provider. */
  unpublishPreferences: (() => void) | undefined;
  unregisterResourceCleanup: (() => void) | undefined;
  parent: ParentHost | undefined;
  /** Anthropic compaction mode read at session start. */
  anthropicMode: AnthropicCompactionMode;
  /** Session-scoped server-side switch (disabled after a replay rejection). */
  readonly serverSide: AnthropicServerSideSession;
  /** Capability gate (and cooldowns) of the foreground server-side path. */
  readonly foregroundGate: AnthropicCapabilityGate;
  /** Capture, projection and replay rewrite shared by foreground and background. */
  readonly replay: AnthropicReplayBinder;
  /** Unbind of each session's Anthropic replay binding, by session ID. */
  readonly replayUnbinds: Map<string, () => void>;
  /** xAI compaction mode read at session start. */
  xaiMode: XaiCompactionMode;
  /** Session-scoped xAI server-side switch (disabled after a replay refusal or rejection). */
  readonly xaiServerSide: AnthropicServerSideSession;
  /** Capability gate (and cooldowns) of the xAI foreground path. */
  readonly xaiGate: AnthropicCapabilityGate;
  /** xAI capture, projection and replay rewrite. */
  readonly xaiReplay: XaiReplayBinder;
  /** Unbind of each session's xAI replay binding, by session ID. */
  readonly xaiReplayUnbinds: Map<string, () => void>;
  /** Sessions bound in `serverSide`/`xaiServerSide`; released at shutdown. */
  readonly nativeSessions: Set<string>;
  /** Removes this registration's per-session native refresher. */
  unregisterNativeRefresher: (() => void) | undefined;
  /**
   * The settling window, opened by this extension's own `agent_end` handler.
   * Pi awaits every extension's `agent_end` before the run settles and
   * `agent_settled` is emitted, so the window covers every `agent_settled`
   * handler whatever the load order. It stays open until the next `input`
   * (before the deferred request runs), `turn_start`, `session_start`,
   * `model_select` or shutdown. Public events only; nothing on `ctx` or the
   * session object is read or changed.
   */
  settling: boolean;
}

export function isCurrent(rt: HostRuntime, owner: MainOwner): boolean {
  return rt.main === owner && rt.lifecycle === owner.generation;
}

/** Shown (once per registration, by the notifier) when the coordinator registry is in conflict. */
export const REGISTRY_CONFLICT_NOTICE =
  "background compaction unavailable: registry conflict; restart pi";

/**
 * Whether the process-wide coordinator registry is usable. A conflicting slot
 * (left by incompatible code in this process) turns the background feature off
 * exactly like the master switch: no owner attaches and every route falls
 * through to host compaction until pi restarts.
 */
export function registryUsable(rt: HostRuntime, ctx: ExtensionContext | undefined): boolean {
  if (registryAvailability().status === "available") return true;
  rt.notify(ctx, REGISTRY_CONFLICT_NOTICE);
  return false;
}

/** The current main owner, recording ctx as its latest context; undefined when none is current. */
export function touchCurrentOwner(rt: HostRuntime, ctx: ExtensionContext): MainOwner | undefined {
  const owner = rt.main;
  if (owner === undefined || !isCurrent(rt, owner)) return undefined;
  owner.lastCtx = ctx;
  return owner;
}

export function runCleanup(steps: readonly (() => void)[]): void {
  for (const step of steps) step();
}

export function teardownMain(rt: HostRuntime): void {
  const current = rt.main;
  rt.main = undefined;
  if (current === undefined) return;
  for (const cleanup of current.cleanup.splice(0)) {
    runReportedCleanup(rt, current, cleanup);
  }
}

function runReportedCleanup(rt: HostRuntime, owner: MainOwner, cleanup: () => void): void {
  try {
    cleanup();
  } catch (cause) {
    rt.notify(owner.lastCtx, `cleanup failed: ${errorText(cause)}`);
  }
}

export function shutdown(rt: HostRuntime): void {
  rt.lifecycle += 1;
  teardownMain(rt);
  unbindReplay(rt);
  for (const sessionId of rt.nativeSessions) {
    rt.serverSide.release(sessionId);
    rt.xaiServerSide.release(sessionId);
  }
  rt.nativeSessions.clear();
  rt.parent = undefined;
  const unregister = rt.unregisterResourceCleanup;
  rt.unregisterResourceCleanup = undefined;
  unregister?.();
  const unpublish = rt.unpublishProvider;
  rt.unpublishProvider = undefined;
  unpublish?.();
  const unpublishPreferences = rt.unpublishPreferences;
  rt.unpublishPreferences = undefined;
  unpublishPreferences?.();
}

export function unbindReplay(rt: HostRuntime): void {
  const unregister = rt.unregisterNativeRefresher;
  rt.unregisterNativeRefresher = undefined;
  unregister?.();
  for (const unbinds of [rt.replayUnbinds, rt.xaiReplayUnbinds]) {
    const pending = [...unbinds.values()];
    unbinds.clear();
    for (const unbind of pending) unbind();
  }
}
