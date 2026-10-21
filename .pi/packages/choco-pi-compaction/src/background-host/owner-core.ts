import type {
  ContextUsage,
  CompactionEntryDraft,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  ANTHROPIC_BACKEND_ID,
  chooseLegalCutEntry,
  hasUsableCapture,
  selectCapture,
} from "../anthropic/backend.ts";
import { capturesFor, type WireCapture } from "../anthropic/capture.ts";
import type {
  CandidateState,
  CoordinatorStatus,
  FrozenSnapshot,
  PreparationRequestResult,
  ProviderScope,
} from "../background/contract.ts";
import {
  type CandidateFailurePortEvent,
  type CoordinatorHandle,
  type CoordinatorPort,
  createCoordinator,
  type SnapshotContext,
  type SnapshotRefused,
} from "../background/coordinator.ts";
import {
  type LaneId,
  type LaneProvider,
  type LaneRoute,
  ownedReasonOf,
  REASONS,
} from "../background/lane-journal.ts";
import { CODEX_BACKEND_SETTING_ID, isBackendEnabled } from "../background/settings.ts";
import { TEXT_BACKEND_ID } from "../background/text-backend.ts";
import { deliveredAdoptionsFor } from "../background/registry.ts";
import {
  findPrefixInvalidation,
  freezeSnapshot,
  isSnapshotRefusal,
  type PrefixSnapshot,
  type SnapshotRefusal,
} from "../background/snapshot.ts";
import { isStaleContextError } from "../lifecycle.ts";
import {
  laneMayAnswerOverOpaque,
  lossAuthorizedFor,
  type OpaqueCheckpoint,
  opaqueCheckpointOf,
  opaqueProviderOf,
} from "../opaque-checkpoint.ts";
import { type AdoptionRoute, readAdoptionIdentity } from "./adoption-signal.ts";
import {
  ownerModelBudget,
  ownerTokenCounter,
  resolveBackends,
  selectBackendId,
} from "./backends.ts";
import { findCommittedAdoption, latestCompactionOf } from "./branch.ts";
import { CANCELLATIONS } from "./manual-policy.ts";
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
  /** The owner's provider scope (the session model's resolved endpoint and auth mode). */
  readonly scope: ProviderScope;
  readonly coordinator: CoordinatorHandle;
  /** Backend chosen for this owner's model, or undefined when none applies. */
  readonly backendId: string | undefined;
  /** Backend IDs resolved for this owner; the chosen one may fall back to another at request time. */
  readonly backendIds: readonly string[];
  /** Whether a replay rejection turned Anthropic server-side off for this owner's session. */
  anthropicDisabled(): boolean;
  /** The opaque checkpoint that forbids `backendId`'s lane from answering now, if any. */
  opaqueBlock(backendId: string): OpaqueCheckpoint | undefined;
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
  /** Every resolved lane; the threshold route may fall back from a native lane to text. */
  readonly backendIds: readonly string[];
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
    backendIds: [...backends.keys()],
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
    delivered: deliveredAdoptionsFor(spec.ownerKey),
    modelBudget: ownerModelBudget(spec),
    tokenCounter: ownerTokenCounter(spec, options),
    onCandidateFailure: (failure) => journalCandidateFailure(state, failure),
  });
  return assembleCore(state, coordinator, [...backends.keys()]);
}

/**
 * Native background lanes with the provider each journals under. xAI has no
 * background lane: an admitted xAI model leaves compaction to xAI server-side.
 */
const NATIVE_LANE_PROVIDERS: ReadonlyMap<string, LaneProvider> = new Map([
  [ANTHROPIC_BACKEND_ID, "anthropic"],
  [CODEX_BACKEND_SETTING_ID, "codex"],
]);

export function laneIdOf(backendId: string): LaneId | undefined {
  if (backendId === TEXT_BACKEND_ID) return "text";
  if (backendId === ANTHROPIC_BACKEND_ID) return "anthropic-native";
  if (backendId === CODEX_BACKEND_SETTING_ID) return "codex-native-v2";
  return undefined;
}

/**
 * The opaque checkpoint that forbids `backendId`'s lane from answering over
 * `entries` (D2): the newest compaction is a provider-held record that lane
 * cannot replay, and the user has not authorized losing it. Undefined when
 * the lane may answer. Consent is read from the process-global slot, which
 * combines every registration's answer for the session.
 */
export function opaqueBlockFor(
  sessionId: string,
  entries: readonly SessionEntry[],
  backendId: string,
): OpaqueCheckpoint | undefined {
  const opaque = opaqueCheckpointOf(entries);
  if (opaque === undefined) return undefined;
  const lane = laneIdOf(backendId);
  if (lane !== undefined && laneMayAnswerOverOpaque(lane, opaque)) return undefined;
  return lossAuthorizedFor(sessionId, opaque.entryId) ? undefined : opaque;
}

/**
 * Journal a candidate's terminal failure, cancellation or discard. A text
 * candidate is journaled under the provider of this owner's selected native
 * lane; with no native lane selected there is no vendor lane to report on.
 * A backend (possibly another package's) supplies the reason and detail at
 * runtime, so both go through `ownedReasonOf`: anything that is not an owned
 * code is journaled as `provider-error`, never as it is.
 */
function journalCandidateFailure(state: OwnerCoreState, failure: CandidateFailurePortEvent): void {
  const from = laneIdOf(failure.backendId);
  const provider =
    NATIVE_LANE_PROVIDERS.get(failure.backendId) ??
    (state.backendId === undefined ? undefined : NATIVE_LANE_PROVIDERS.get(state.backendId));
  if (from === undefined || provider === undefined) return;
  const route: LaneRoute = failure.trigger === "recovery" ? "resume" : failure.trigger;
  // `/compact <focus>` on the Anthropic lane: the instructions were sent as
  // `compaction.instructions` (D9); recorded when no failure detail says more.
  const forwarded =
    failure.backendId === ANTHROPIC_BACKEND_ID && failure.customInstructions !== undefined;
  const detail = failure.detail ?? (forwarded ? REASONS.instructionsForwarded : undefined);
  state.spec.journal({
    at: now(state),
    sessionId: state.spec.sessionId,
    provider,
    route,
    event:
      CANCELLATIONS.has(failure.reason) || failure.reason === "disabled" ? "cancel" : "fallback",
    from,
    reason: ownedReasonOf(failure.reason),
    detail: detail === undefined ? undefined : ownedReasonOf(detail),
    candidateId: failure.candidateId,
    noticeAttempted: false,
  });
}

function assembleCore(
  state: OwnerCoreState,
  coordinator: CoordinatorHandle,
  backendIds: readonly string[],
): OwnerCore {
  const spec = state.spec;
  return {
    ownerKey: spec.ownerKey,
    sessionId: spec.sessionId,
    scope: spec.scope,
    coordinator,
    backendId: state.backendId,
    backendIds,
    anthropicDisabled: () => spec.anthropicDisabled(),
    opaqueBlock: (backendId) =>
      opaqueBlockFor(spec.sessionId, spec.sessionManager.getBranch(), backendId),
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

function freeze(state: OwnerCoreState, context: SnapshotContext): FrozenSnapshot | SnapshotRefused {
  // Second line of defence behind the routes (manual requests and recovery
  // included): never freeze a prefix a lane cannot answer over an opaque record.
  if (opaqueBlockFor(state.spec.sessionId, context.entries, context.backendId) !== undefined) {
    return { refused: true, detail: REASONS.opaqueCheckpoint };
  }
  const record = context.recoveryRecord;
  // Recovery reconstructs the recorded cut from the full branch; it never
  // reselects a later cut and never starts a paid preparation.
  const selected =
    record === undefined
      ? freezeFresh(state, context)
      : (freezeAt(
          state,
          state.spec.sessionManager.getBranch(),
          record.identity.cutEntryId,
          context,
        ) ?? refusedCut("no-legal-cut", false));
  if (isSnapshotRefusal(selected)) return { refused: true, detail: selected.detail };
  state.snapshots.set(selected.prefixFingerprint, selected);
  return selected;
}

function freezeFresh(
  state: OwnerCoreState,
  context: SnapshotContext,
): PrefixSnapshot | SnapshotRefusal {
  const base = freezeSnapshot(
    context.entries,
    freezeOptions(state, context, { keepRecentTokens: keepRecentTokens(state.spec) }),
  );
  if (isSnapshotRefusal(base)) return base;
  // Wire-replay cut rules bind only the lane that replays the wire.
  if (context.backendId !== ANTHROPIC_BACKEND_ID) return base;
  return legalAnthropicCut(state, base, context);
}

/** Move the cut to one the Anthropic capture can replay, defer, or keep it. */
function legalAnthropicCut(
  state: OwnerCoreState,
  base: PrefixSnapshot,
  context: SnapshotContext,
): PrefixSnapshot | SnapshotRefusal {
  const capture = selectCapture(
    capturesFor(state.spec.sessionId),
    base.cutEntryId,
    context.providerScope,
  );
  if (capture === undefined) return base;
  const legal = chooseLegalCutEntry(capture, base.cutEntryId, {
    branchExtendsCapture: branchExtendsCapture(capture, context.entries),
  });
  if (legal === "defer") return refusedCut("no-legal-cut", true);
  if (legal === base.cutEntryId) return base;
  return (
    freezeAt(state, context.entries, legal, context) ?? refusedCut("nothing-to-summarize", true)
  );
}

/**
 * Whether the branch holds an entry after the capture's last projected entry.
 * The capture is taken when its request is sent, so the turn's reply and any
 * later entries lie past it; a cut at the capture's tail then retains them.
 */
function branchExtendsCapture(capture: WireCapture, entries: readonly SessionEntry[]): boolean {
  const tail = capture.mapping?.projection.at(-1)?.entryId;
  if (tail === undefined) return false;
  const position = entries.findIndex((entry) => entry.id === tail);
  return position >= 0 && position + 1 < entries.length;
}

function refusedCut(
  detail: "no-legal-cut" | "nothing-to-summarize",
  retryable: boolean,
): SnapshotRefusal {
  return { ok: false, reason: "no-legal-cut", retryable, detail };
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
  const anthropicDisabled = state.spec.anthropicDisabled();
  const lane = thresholdLane({
    selected: backendId,
    backendIds: state.backendIds,
    hasAnthropicCapture: hasUsableCapture(state.spec.sessionId, state.spec.scope),
    anthropicDisabled,
    status,
  });
  if (yieldsToOpaque(state, lane)) return;
  if (anthropicDisabled && backendId === ANTHROPIC_BACKEND_ID && lane === TEXT_BACKEND_ID) {
    announceDisabledYield(state);
  }
  requestThresholdPreparation(state, coordinator, lane);
}

/**
 * Whether the opaque-history guard stops a threshold preparation on `lane`:
 * journaled (and noticed) once per checkpoint and session; no candidate.
 */
function yieldsToOpaque(state: OwnerCoreState, lane: string): boolean {
  const { spec } = state;
  const blocked = opaqueBlockFor(spec.sessionId, spec.sessionManager.getBranch(), lane);
  if (blocked === undefined) return false;
  const provider = opaqueProviderOf(blocked.owner);
  spec.announce(
    `background compaction is paused: the latest checkpoint ${blocked.entryId} is an opaque ${provider} server-side record a local summary cannot replace; run /compaction-allow-loss to summarize without it`,
    "warning",
    "per-session-reason",
    {
      at: now(state),
      sessionId: spec.sessionId,
      provider,
      route: "threshold",
      event: "yield",
      from: laneIdOf(lane) ?? "text",
      reason: REASONS.opaqueCheckpoint,
      checkpointEntryId: blocked.entryId,
    },
  );
  return true;
}

/** The Anthropic lane is off for this session (replay rejection): threshold work moves to text, once noticed. */
function announceDisabledYield(state: OwnerCoreState): void {
  const { spec } = state;
  spec.announce(
    "Anthropic server-side compaction is off for this session; background compaction uses the text lane",
    "warning",
    "per-session-reason",
    {
      at: now(state),
      sessionId: spec.sessionId,
      provider: "anthropic",
      route: "threshold",
      event: "yield",
      from: "anthropic-native",
      to: "text",
      reason: REASONS.disabled,
    },
  );
}

/**
 * The lane for the next threshold preparation. The Anthropic lane yields to
 * the text lane (when enabled) while it cannot serve: no wire capture of this
 * session yet, its last attempt refused the cut, or a replay rejection turned
 * it off for this session (`anthropicDisabled`). Any other native lane
 * never yields: a Codex-owned model is compacted by Codex's own handler, so a
 * text candidate adopted over Codex content is exactly what
 * `selectBackendId` rules out. A refused Codex cut (no recorded provider
 * response yet, for example) retries on the Codex lane after the cooldown.
 */
export function thresholdLane(input: {
  readonly selected: string;
  readonly backendIds: readonly string[];
  readonly hasAnthropicCapture: boolean;
  readonly anthropicDisabled?: boolean;
  readonly status: CoordinatorStatus;
}): string {
  const { selected, backendIds, hasAnthropicCapture, status } = input;
  if (selected !== ANTHROPIC_BACKEND_ID || !backendIds.includes(TEXT_BACKEND_ID)) return selected;
  if (input.anthropicDisabled === true || !hasAnthropicCapture) return TEXT_BACKEND_ID;
  const refusedHere =
    status.state === "failed" &&
    status.backendId === selected &&
    (status.reason === "no-legal-cut" || status.reason === "incompatible");
  return refusedHere ? TEXT_BACKEND_ID : selected;
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
