import type {
  ContextUsage,
  CompactionEntryDraft,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { ANTHROPIC_BACKEND_ID, chooseLegalCutEntry, selectCapture } from "../anthropic/backend.ts";
import { capturesFor } from "../anthropic/capture.ts";
import type {
  CandidateState,
  CoordinatorStatus,
  FrozenSnapshot,
  PreparationRequestResult,
} from "../background/contract.ts";
import {
  type CoordinatorHandle,
  type CoordinatorPort,
  createCoordinator,
  type SnapshotContext,
} from "../background/coordinator.ts";
import { isBackendEnabled } from "../background/settings.ts";
import {
  findPrefixInvalidation,
  freezeSnapshot,
  isSnapshotRefusal,
  type PrefixSnapshot,
} from "../background/snapshot.ts";
import { isStaleContextError } from "../lifecycle.ts";
import { type AdoptionRoute, readAdoptionIdentity } from "./adoption-signal.ts";
import { resolveBackends, selectBackendId } from "./backends.ts";
import { findCommittedAdoption, latestCompactionOf } from "./branch.ts";
import { errorText } from "./notices.ts";
import type { BackgroundCompactionOptions, OwnerSpec } from "./owner-spec.ts";

// ---------------------------------------------------------------------------
// Per-owner core: coordinator, port, backends, trigger policy
// ---------------------------------------------------------------------------

/** Host compaction default when no settings were loaded (pi's own default). */
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/** Retention that freezes exactly at a chosen cut: one retained entry, no more. */
const EXACT_CUT_RETENTION: KeepTokens = { keepRecentTokens: 1, maxKeepTokens: 0 };

const OUTSTANDING: ReadonlySet<CandidateState> = new Set([
  "queued",
  "preparing",
  "ready",
  "adopting",
]);
const TERMINAL_FAILURE: ReadonlySet<CandidateState> = new Set([
  "failed",
  "canceled",
  "discarded-stale",
]);

export interface OwnerCore {
  readonly ownerKey: string;
  readonly sessionId: string;
  readonly coordinator: CoordinatorHandle;
  /** Backend chosen for this owner's model, or undefined when none applies. */
  readonly backendId: string | undefined;
  /** candidateId -> route of every proposal this owner handed to the host. */
  readonly proposals: Map<string, AdoptionRoute>;
  /** Branch switch observed outside the per-read leaf check. */
  bumpBranch(): void;
  /** Start preparation when usage crosses the threshold; never awaits it. */
  observeUsage(usage: ContextUsage | undefined): void;
  /** Re-check that an adoption draft still matches its frozen prefix on this branch. */
  vet(draft: CompactionEntryDraft, branch: readonly SessionEntry[]): boolean;
  /** Settle earlier proposals whose boundary has completed. */
  settle(): Promise<void>;
  dispose(): void;
}

interface KeepTokens {
  readonly keepRecentTokens: number;
  readonly maxKeepTokens?: number;
}

/** Mutable trigger and branch state of one owner, shared by its port and coordinator callbacks. */
interface OwnerCoreState {
  readonly spec: OwnerSpec;
  readonly options: BackgroundCompactionOptions;
  readonly backendId: string | undefined;
  readonly snapshots: Map<string, PrefixSnapshot>;
  branchEpoch: number;
  lastLeaf: string | undefined;
  headroom: number;
  armed: boolean;
  retryAfter: number;
  lastRequested: string | undefined;
}

export async function createOwnerCore(
  spec: OwnerSpec,
  options: BackgroundCompactionOptions,
): Promise<OwnerCore | undefined> {
  const backends = await resolveBackends(spec, options);
  if (backends.size === 0) return undefined;
  const backendId = await selectBackendId(spec, backends);
  const state: OwnerCoreState = {
    spec,
    options,
    backendId,
    snapshots: new Map(),
    branchEpoch: 0,
    lastLeaf: undefined,
    headroom: 0,
    armed: true,
    retryAfter: 0,
    lastRequested: undefined,
  };
  const coordinator = createCoordinator({
    ownerKey: spec.ownerKey,
    ownerGeneration: spec.ownerGeneration,
    isOwnerCurrent: spec.isOwnerCurrent,
    appendRecord: spec.appendRecord,
    port: createPort(state),
    backends,
    settings: spec.settings,
    freezeSnapshot: (context) => freeze(state, context),
    headroom: () => state.headroom,
    isBackendEnabled,
    isStaleContextError: (cause) => cause instanceof Error && isStaleContextError(cause),
    clock: options.clock,
  });
  return assembleCore(state, coordinator);
}

function assembleCore(state: OwnerCoreState, coordinator: CoordinatorHandle): OwnerCore {
  const spec = state.spec;
  return {
    ownerKey: spec.ownerKey,
    sessionId: spec.sessionId,
    coordinator,
    backendId: state.backendId,
    proposals: new Map(),
    bumpBranch: () => {
      state.branchEpoch += 1;
    },
    observeUsage: (usage) => observeUsage(state, coordinator, usage),
    vet: (draft, branch) => vetDraft(state, draft, branch),
    settle: () => settleCommits(spec, coordinator),
    dispose: () => {
      coordinator.invalidate("disposed");
      coordinator.dispose();
      state.snapshots.clear();
    },
  };
}

function now(state: OwnerCoreState): number {
  return state.options.clock?.now() ?? Date.now();
}

function keepRecentTokens(spec: OwnerSpec): number {
  return spec.compactionPolicy?.(spec.model).keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
}

function createPort(state: OwnerCoreState): CoordinatorPort {
  const spec = state.spec;
  const manager = spec.sessionManager;
  return {
    getBranch: () => manager.getBranch(),
    getBranchKey: () => branchKey(state),
    getProviderScope: () => structuredClone(spec.scope),
    getLatestCompactionEntry: () => latestCompactionOf(manager.getBranch()),
    appendAnchor: () => spec.appendAnchor(),
    // Observation only: the proposal is consumed once at the host boundary.
    proposeDraft: () => {},
    findCommittedCandidate: (candidateId, fingerprint) =>
      findCommittedAdoption(manager.getBranch(), spec.ownerKey, candidateId, fingerprint),
  };
}

function branchKey(state: OwnerCoreState): string {
  const branch = state.spec.sessionManager.getBranch();
  const lastLeaf = state.lastLeaf;
  // A previously observed leaf that left the branch means the leaf moved to
  // another path, even when the frozen prefix is shared.
  if (lastLeaf !== undefined && !branch.some((entry) => entry.id === lastLeaf)) {
    state.branchEpoch += 1;
  }
  state.lastLeaf = branch.at(-1)?.id;
  return `${state.spec.sessionId}#${state.branchEpoch}`;
}

function freezeOptions(state: OwnerCoreState, context: SnapshotContext, keep: KeepTokens) {
  const base = {
    ownerKey: state.spec.ownerKey,
    ownerGeneration: state.spec.ownerGeneration,
    providerScope: context.providerScope,
    keepRecentTokens: keep.keepRecentTokens,
    capturedAt: context.capturedAt,
  };
  return keep.maxKeepTokens === undefined ? base : { ...base, maxKeepTokens: keep.maxKeepTokens };
}

/** Freeze exactly at cutEntryId (the next entry retained), or refuse. */
function freezeAt(
  state: OwnerCoreState,
  entries: readonly SessionEntry[],
  cutEntryId: string,
  context: SnapshotContext,
): PrefixSnapshot | undefined {
  const index = entries.findIndex((entry) => entry.id === cutEntryId);
  if (index < 0 || index + 1 >= entries.length) return undefined;
  const result = freezeSnapshot(
    entries.slice(0, index + 2),
    freezeOptions(state, context, EXACT_CUT_RETENTION),
  );
  if (isSnapshotRefusal(result) || result.cutEntryId !== cutEntryId) return undefined;
  return result;
}

function freeze(state: OwnerCoreState, context: SnapshotContext): FrozenSnapshot | null {
  const record = context.recoveryRecord;
  // Recovery reconstructs the recorded cut from the full branch; it never
  // reselects a later cut and never starts a paid preparation.
  const selected =
    record === undefined
      ? freezeFresh(state, context)
      : freezeAt(state, state.spec.sessionManager.getBranch(), record.identity.cutEntryId, context);
  if (selected === undefined) return null;
  state.snapshots.set(selected.prefixFingerprint, selected);
  return selected;
}

function freezeFresh(state: OwnerCoreState, context: SnapshotContext): PrefixSnapshot | undefined {
  const base = freezeSnapshot(
    context.entries,
    freezeOptions(state, context, { keepRecentTokens: keepRecentTokens(state.spec) }),
  );
  if (isSnapshotRefusal(base)) return undefined;
  if (state.backendId !== ANTHROPIC_BACKEND_ID) return base;
  return legalAnthropicCut(state, base, context);
}

/** Move the cut to one the Anthropic capture can replay, defer, or keep it. */
function legalAnthropicCut(
  state: OwnerCoreState,
  base: PrefixSnapshot,
  context: SnapshotContext,
): PrefixSnapshot | undefined {
  const capture = selectCapture(
    capturesFor(state.spec.sessionId),
    base.cutEntryId,
    context.providerScope,
  );
  if (capture === undefined) return base;
  const legal = chooseLegalCutEntry(capture, base.cutEntryId);
  if (legal === "defer") return undefined;
  if (legal === base.cutEntryId) return base;
  return freezeAt(state, context.entries, legal, context);
}

function observeUsage(
  state: OwnerCoreState,
  coordinator: CoordinatorHandle,
  usage: ContextUsage | undefined,
): void {
  const backendId = state.backendId;
  if (!state.spec.isOwnerCurrent() || backendId === undefined) return;
  if (usage === undefined || usage.tokens === null) return;
  const settings = state.spec.settings;
  const trigger = Math.max(1, usage.contextWindow - settings.reserveTokens);
  state.headroom = Math.max(0, trigger - usage.tokens);
  const ratio = usage.tokens / trigger;
  if (ratio < settings.prepareAt - settings.hysteresis) state.armed = true;
  const status = coordinator.status();
  rearmAfterFailure(state, status);
  if (!state.armed || ratio < settings.prepareAt || now(state) < state.retryAfter) return;
  if (OUTSTANDING.has(status.state)) return;
  requestThresholdPreparation(state, coordinator, backendId);
}

/**
 * A failed attempt may retry after the cooldown; an installed one waits for
 * usage to drop below the hysteresis band first.
 */
function rearmAfterFailure(state: OwnerCoreState, status: CoordinatorStatus): void {
  if (state.armed || state.lastRequested === undefined) return;
  if (status.candidateId !== state.lastRequested || !TERMINAL_FAILURE.has(status.state)) return;
  state.armed = true;
  state.lastRequested = undefined;
  state.retryAfter = now(state) + state.spec.settings.cooldownMs;
}

function requestThresholdPreparation(
  state: OwnerCoreState,
  coordinator: CoordinatorHandle,
  backendId: string,
): void {
  const report = state.spec.report;
  const requested = coordinator.requestPreparation({ trigger: "threshold", backendId });
  coordinator.waitForPreparation().catch((cause: unknown) => {
    report(`preparation failed unexpectedly: ${errorText(cause)}`);
  });
  requested.then(
    (result) => recordPreparationRequest(state, result),
    (cause: unknown) => report(`preparation request failed: ${errorText(cause)}`),
  );
}

function recordPreparationRequest(state: OwnerCoreState, result: PreparationRequestResult): void {
  if (result.accepted) {
    state.armed = false;
    state.lastRequested = result.candidateId;
  } else if (result.reason !== "busy") {
    state.retryAfter = now(state) + state.spec.settings.cooldownMs;
  }
}

function vetDraft(
  state: OwnerCoreState,
  draft: CompactionEntryDraft,
  branch: readonly SessionEntry[],
): boolean {
  const identity = readAdoptionIdentity(draft);
  if (identity === undefined || identity.ownerKey !== state.spec.ownerKey) return false;
  const snapshot = state.snapshots.get(identity.prefixFingerprint);
  if (snapshot === undefined || findPrefixInvalidation(snapshot, branch) !== null) return false;
  const first = draft.firstKeptEntryId;
  return first !== null && branch.some((entry) => entry.id === first);
}

async function settleCommits(spec: OwnerSpec, coordinator: CoordinatorHandle): Promise<void> {
  try {
    await coordinator.reconcileCommit(true);
  } catch (cause) {
    spec.report(`commit reconciliation failed: ${errorText(cause)}`);
  }
}
