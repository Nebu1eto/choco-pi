import type {
  CompactionResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import type { LoadedBackgroundSettings } from "../background/settings.ts";
import type { CompactionSessionState, SessionStateReader } from "../session-state.ts";
import { errorText, type Notifier } from "./notices.ts";
import type { OwnerCore } from "./owner-core.ts";
import type { BackgroundCompactionOptions } from "./owner-spec.ts";

// ---------------------------------------------------------------------------
// Per-registration host state shared by the session lifecycle, routes and
// child provider
// ---------------------------------------------------------------------------

export interface PendingRoute {
  readonly candidateId: string;
  readonly trigger: "idle" | "context-cap";
}

export type Decision =
  | { readonly action: "proceed" }
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
  lastCtx: ExtensionContext;
  readonly cleanup: (() => void)[];
}

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
  captureRegistered: boolean;
  unregisterResourceCleanup: (() => void) | undefined;
  replayActive: boolean;
  parent: ParentHost | undefined;
}

export function isCurrent(rt: HostRuntime, owner: MainOwner): boolean {
  return rt.main === owner && rt.lifecycle === owner.generation;
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
  rt.parent = undefined;
  rt.replayActive = false;
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
