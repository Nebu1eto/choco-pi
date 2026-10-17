/**
 * Per-child compaction window for the fleet view.
 *
 * A child is compacting while its own session is between `compaction_start`
 * and `compaction_end` (completed, failed, or aborted), or while its
 * background-compaction coordinator is queued, preparing, or adopting a
 * candidate. Boundary adoptions commit inside a turn boundary with no
 * `compaction_start`, so they only ever end a background-preparation window.
 *
 * The window is keyed by the child session object, not the agent record, so
 * every spawn, resume, revival, and nested path that runs through the runner
 * is covered without threading callbacks through the manager. Tracking is
 * run-scoped: the runner starts it with each prompt invocation and the
 * returned stop removes the listener and closes the window when that run
 * settles, so no subscription outlives the run. Callers still gate rendering
 * on the record's running status.
 *
 * The main session is tracked separately (`createMainCompactionActivity`):
 * its host window comes from the extension's `session_before_compact` /
 * `session_compact` / `session_compact_failed` events, and its background
 * preparation from the main coordinator in the shared compaction registry.
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { getCoordinator } from "../../choco-pi-compaction/src/background/registry.ts";
import { getChildCompactionBridge, isCoordinatorPreparing } from "./child-compaction-bridge.ts";

/** The slice of a child session this module reads. */
type CompactionEventSource = Pick<AgentSession, "subscribe">;

interface HostCompactionWindow {
  open: boolean;
}

const windows = new WeakMap<object, HostCompactionWindow>();

/**
 * Observe the session's host compaction events for one run. Returns the stop
 * callback the run calls on settlement; it unsubscribes and closes the window.
 * A session already tracked by an outer run gets a no-op stop, so only the
 * owning run ends the window.
 */
export function trackSessionCompaction(session: CompactionEventSource): () => void {
  if (windows.has(session)) return () => {};
  const window: HostCompactionWindow = { open: false };
  windows.set(session, window);
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "compaction_start") window.open = true;
    else if (event.type === "compaction_end") window.open = false;
  });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    window.open = false;
    if (windows.get(session) === window) windows.delete(session);
    unsubscribe();
  };
}

/** Whether the child session currently has a compaction in progress. */
export function isSessionCompacting(session: AgentSession | undefined): boolean {
  if (session === undefined) return false;
  if (windows.get(session)?.open === true) return true;
  return getChildCompactionBridge(session)?.isPreparing() === true;
}

/**
 * Registry owner key of a main session's coordinator. Mirrors
 * `mainOwnerKey` in choco-pi-compaction's `ownership.ts`, which is not
 * imported because it loads the codex adapter; a test pins the two together.
 */
export function mainCoordinatorOwnerKey(sessionId: string): string {
  return `main-session:${sessionId}`;
}

/** Compaction state of the main (root) session. */
export interface MainCompactionActivity {
  /** Follow a new main session, or none; closes any open host window. */
  bind(sessionId: string | undefined): void;
  /** `session_before_compact`: the host compaction started. */
  hostStarted(): void;
  /** `session_compact` or `session_compact_failed`: the host compaction ended. */
  hostEnded(): void;
  /** Whether a host compaction or a background preparation is in progress. */
  isCompacting(): boolean;
}

export function createMainCompactionActivity(): MainCompactionActivity {
  let sessionId: string | undefined;
  let hostOpen = false;
  return {
    bind(id) {
      sessionId = id;
      hostOpen = false;
    },
    hostStarted() {
      hostOpen = true;
    },
    hostEnded() {
      hostOpen = false;
    },
    isCompacting() {
      if (hostOpen) return true;
      if (sessionId === undefined) return false;
      return isCoordinatorPreparing(getCoordinator(mainCoordinatorOwnerKey(sessionId)));
    },
  };
}
