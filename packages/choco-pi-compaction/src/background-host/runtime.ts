import type {
  CompactionResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import type { ChildCompactionProvider } from "../background/child-provider-contract.ts";
import type { LaneRecordInput, LaneTransitionMemo } from "../background/lane-journal.ts";
import type { LoadedBackgroundSettings } from "../background/settings.ts";
import { registryAvailability } from "../background/registry.ts";
import type { AnthropicCapabilityGate } from "../anthropic/capability.ts";
import { releaseSessionCaptures } from "../anthropic/capture.ts";
import type {
  AnthropicCompactionMode,
  AnthropicServerSideSession,
  OpaqueHistoryMode,
} from "../anthropic/mode.ts";
import type { AnthropicReplayBinder } from "../anthropic/replay-binding.ts";
import type { CompactionSessionState, SessionStateReader } from "../session-state.ts";
import { releaseXaiSessionCaptures } from "../xai/capture.ts";
import type { XaiCompactionMode } from "../xai/mode.ts";
import type { XaiReplayBinder } from "../xai/replay.ts";
import { errorText, type Notifier } from "./notices.ts";
import type { OwnerCore } from "./owner-core.ts";
import type { BackgroundCompactionOptions } from "./owner-spec.ts";

export interface PendingRoute {
  readonly candidateId: string;
  readonly trigger: "idle" | "context-cap" | "manual";
}

export type Decision =
  | { readonly action: "proceed" }
  | { readonly action: "cancel" }
  | {
      readonly action: "adopt";
      readonly candidateId: string;
      readonly compaction: CompactionResult;
    };

export interface MainOwner {
  readonly core: OwnerCore;
  readonly generation: number;
  readonly decisions: WeakMap<SessionBeforeCompactEvent, Promise<Decision>>;
  readonly refusedIdle: Set<string>;
  pendingRoute: PendingRoute | undefined;
  manualCandidate: string | undefined;
  manualSerial: number;
  manualNotice: string | undefined;
  hostCompactUnwinding: boolean;
  idlePending: IdleRequest | undefined;
  idleRunning: Promise<void> | undefined;
  lastCtx: ExtensionContext;
  readonly cleanup: (() => void)[];
}

export interface IdleRequest {
  readonly kind: "adopt";
  readonly trigger: PendingRoute["trigger"];
  readonly onSettled: (compacted: boolean) => void;
}

export interface ParentHost {
  readonly modelRegistry: ExtensionContext["modelRegistry"];
  readonly state: CompactionSessionState;
  readonly ctx: ExtensionContext;
}

export interface CompactionModes {
  readonly anthropic: AnthropicCompactionMode;
  readonly xai: XaiCompactionMode;
  readonly opaqueHistory: OpaqueHistoryMode;
}

export interface HostRuntime {
  readonly pi: ExtensionAPI;
  readonly readState: SessionStateReader;
  readonly options: BackgroundCompactionOptions;
  readonly notify: Notifier;
  readonly journal: (record: LaneRecordInput) => void;
  readonly transitions: LaneTransitionMemo;
  opaqueHistory: OpaqueHistoryMode;
  readonly opaqueConsent: Map<string, string>;
  unpublishOpaqueConsent: (() => void) | undefined;
  onReplayDisabled:
    | ((sessionId: string, provider: "anthropic" | "xai", code: string) => void)
    | undefined;
  childProvider: ChildCompactionProvider | undefined;
  unwatchCodexEligibility: (() => void) | undefined;
  modes(): CompactionModes;
  lifecycle: number;
  main: MainOwner | undefined;
  loaded: LoadedBackgroundSettings;
  unpublishProvider: (() => void) | undefined;
  unpublishPreferences: (() => void) | undefined;
  unregisterResourceCleanup: (() => void) | undefined;
  parent: ParentHost | undefined;
  anthropicMode: AnthropicCompactionMode;
  readonly serverSide: AnthropicServerSideSession;
  readonly foregroundGate: AnthropicCapabilityGate;
  readonly replay: AnthropicReplayBinder;
  readonly replayUnbinds: Map<string, () => void>;
  xaiMode: XaiCompactionMode;
  readonly xaiServerSide: AnthropicServerSideSession;
  readonly xaiGate: AnthropicCapabilityGate;
  readonly xaiReplay: XaiReplayBinder;
  readonly xaiReplayUnbinds: Map<string, () => void>;
  readonly detachedUnbinds: (() => void)[];
  readonly nativeSessions: Set<string>;
  unregisterNativeRefresher: (() => void) | undefined;
}

export function isCurrent(rt: HostRuntime, owner: MainOwner): boolean {
  return rt.main === owner && rt.lifecycle === owner.generation;
}

export const REGISTRY_CONFLICT_NOTICE =
  "background compaction unavailable: registry conflict; restart pi";

export function registryUsable(rt: HostRuntime, ctx: ExtensionContext | undefined): boolean {
  if (registryAvailability().status === "available") return true;
  rt.notify(ctx, REGISTRY_CONFLICT_NOTICE);
  return false;
}

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
  detachReplayUnbinds(rt);
  runUnbinds(rt.detachedUnbinds.splice(0));
  for (const sessionId of rt.nativeSessions) {
    releaseCaptures(sessionId);
    rt.serverSide.release(sessionId);
    rt.xaiServerSide.release(sessionId);
    rt.transitions.reset(sessionId);
    rt.opaqueConsent.delete(sessionId);
  }
  rt.nativeSessions.clear();
  rt.parent = undefined;
  const unregister = rt.unregisterResourceCleanup;
  rt.unregisterResourceCleanup = undefined;
  unregister?.();
  const unwatch = rt.unwatchCodexEligibility;
  rt.unwatchCodexEligibility = undefined;
  unwatch?.();
  const unpublishConsent = rt.unpublishOpaqueConsent;
  rt.unpublishOpaqueConsent = undefined;
  unpublishConsent?.();
  const unpublish = rt.unpublishProvider;
  rt.unpublishProvider = undefined;
  unpublish?.();
  const unpublishPreferences = rt.unpublishPreferences;
  rt.unpublishPreferences = undefined;
  unpublishPreferences?.();
}

export function detachReplayUnbinds(rt: HostRuntime): (() => void)[] {
  const unregister = rt.unregisterNativeRefresher;
  rt.unregisterNativeRefresher = undefined;
  unregister?.();
  const detached: (() => void)[] = [];
  for (const unbinds of [rt.replayUnbinds, rt.xaiReplayUnbinds]) {
    for (const sessionId of unbinds.keys()) rt.transitions.reset(sessionId);
    detached.push(...unbinds.values());
    unbinds.clear();
  }
  rt.detachedUnbinds.push(...detached);
  return detached;
}

export function runUnbinds(list: readonly (() => void)[]): void {
  for (const unbind of list) unbind();
}

export function releaseCaptures(sessionId: string): void {
  releaseSessionCaptures(sessionId);
  releaseXaiSessionCaptures(sessionId);
}

export function releaseOtherSessionCaptures(rt: HostRuntime, current: string): void {
  for (const sessionId of rt.nativeSessions) {
    if (sessionId !== current) releaseCaptures(sessionId);
  }
}
