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
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { getChildCompactionBridge } from "./child-compaction-bridge.ts";

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
