import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { getCoordinator } from "../../choco-pi-compaction/src/background/registry.ts";
import { getChildCompactionBridge, isCoordinatorPreparing } from "./child-compaction-bridge.ts";

type CompactionEventSource = Pick<AgentSession, "subscribe">;

interface HostCompactionWindow {
  open: boolean;
}

const windows = new WeakMap<object, HostCompactionWindow>();

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

export function isSessionCompacting(session: AgentSession | undefined): boolean {
  if (session === undefined) return false;
  if (windows.get(session)?.open === true) return true;
  return getChildCompactionBridge(session)?.isPreparing() === true;
}

export function mainCoordinatorOwnerKey(sessionId: string): string {
  return `main-session:${sessionId}`;
}

export interface MainCompactionActivity {
  bind(sessionId: string | undefined): void;
  hostStarted(): void;
  hostEnded(): void;
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
