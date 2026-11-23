import type {
  ContextUsage,
  CompactionEntryDraft,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  ANTHROPIC_BACKEND_ID,
  hasUsableCapture,
  legalCutEntries,
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
  type DetailedCoordinatorStatus,
  type SnapshotContext,
  type SnapshotRefused,
  type SuppressedPortEvent,
} from "../background/coordinator.ts";
import {
  type LaneId,
  type LaneProvider,
  type LaneRecordInput,
  type LaneRoute,
  ownedReasonOf,
  REASONS,
} from "../background/lane-journal.ts";
import { CODEX_BACKEND_SETTING_ID } from "../background/settings.ts";
import { isCompactionBackendEnabled } from "./backend-registry.ts";
import { TEXT_BACKEND_ID } from "../background/text-backend.ts";
import { deliveredAdoptionsFor } from "../background/registry.ts";
import {
  type ExactFreezeOptions,
  findPrefixInvalidation,
  freezeSnapshot,
  freezeSnapshotAt,
  isSnapshotRefusal,
  type PrefixSnapshot,
  type SnapshotRefusal,
} from "../background/snapshot.ts";
import { isStaleContextError } from "@choco-pi/shared/lifecycle";
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

const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

const MAX_NATIVE_CUT_ATTEMPTS = 16;

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

const CONTEXT_ENTRY_TYPES: ReadonlySet<string> = new Set([
  "message",
  "custom_message",
  "compaction",
  "branch_summary",
  "context_edit",
]);

export interface OwnerCore {
  readonly ownerKey: string;
  readonly sessionId: string;
  readonly scope: ProviderScope;
  readonly coordinator: CoordinatorHandle;
  readonly backendId: string | undefined;
  readonly backendIds: readonly string[];
  anthropicDisabled(): boolean;
  opaqueBlock(backendId: string): OpaqueCheckpoint | undefined;
  readonly proposals: Map<string, AdoptionRoute>;
  bumpBranch(): void;
  observeUsage(usage: ContextUsage | undefined): void;
  vet(draft: CompactionEntryDraft, branch: readonly SessionEntry[]): boolean;
  settle(): Promise<void>;
  dispose(): void;
}

interface OwnerCoreState {
  readonly spec: OwnerSpec;
  readonly options: BackgroundCompactionOptions;
  readonly backendId: string | undefined;
  readonly backendIds: readonly string[];
  readonly snapshots: Map<string, PrefixSnapshot>;
  branchEpoch: number;
  lastLeaf: string | undefined;
  headroom: number;
  armed: boolean;
  retryAfter: number;
  lastRequested: string | undefined;
  requested: ThresholdRequest | undefined;
  failedAt: string | undefined;
  readonly failedLanes: Set<string>;
  readonly unsupportedLanes: Set<string>;
}

interface ThresholdRequest {
  readonly lane: string;
  readonly position: string;
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
    requested: undefined,
    failedAt: undefined,
    failedLanes: new Set(),
    unsupportedLanes: new Set(),
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
    isBackendEnabled: isCompactionBackendEnabled,
    isStaleContextError: (cause) => cause instanceof Error && isStaleContextError(cause),
    clock: options.clock,
    delivered: deliveredAdoptionsFor(spec.ownerKey),
    modelBudget: ownerModelBudget(spec),
    tokenCounter: ownerTokenCounter(spec, options),
    onCandidateFailure: (failure) => journalCandidateFailure(state, failure),
    cutSalt: (backendId) => cutSaltOf(state, backendId),
    onSuppressed: (event) => journalSuppressed(state, event),
  });
  return assembleCore(state, coordinator, [...backends.keys()]);
}

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

function cutSaltOf(state: OwnerCoreState, backendId: string): string {
  const keep = keepRecentTokens(state.spec);
  if (backendId !== ANTHROPIC_BACKEND_ID) return `keep=${keep}`;
  const capture = capturesFor(state.spec.sessionId).at(-1);
  return `keep=${keep}|capture=${capture?.sequence ?? "none"}`;
}

function providerOfLane(state: OwnerCoreState, backendId: string): LaneProvider | undefined {
  return (
    NATIVE_LANE_PROVIDERS.get(backendId) ??
    (state.backendId === undefined ? undefined : NATIVE_LANE_PROVIDERS.get(state.backendId))
  );
}

function journalSuppressed(state: OwnerCoreState, event: SuppressedPortEvent): void {
  const from = laneIdOf(event.backendId);
  const provider = providerOfLane(state, event.backendId);
  state.spec.report(
    `compaction attempt #${event.attempt} (${event.trigger}) suppressed: no legal cut and nothing changed since the last attempt`,
  );
  if (from === undefined || provider === undefined) return;
  const record: LaneRecordInput = {
    at: now(state),
    sessionId: state.spec.sessionId,
    provider,
    route: event.trigger,
    event: "suppressed",
    from,
    reason: REASONS.noLegalCut,
    trigger: event.trigger,
    attempt: event.attempt,
    cutFingerprint: event.cutFingerprint,
    noticeAttempted: false,
  };
  if (event.tokensAtTrigger !== undefined) record.tokensAtTrigger = event.tokensAtTrigger;
  state.spec.journal(record);
}

function journalCandidateFailure(state: OwnerCoreState, failure: CandidateFailurePortEvent): void {
  const from = laneIdOf(failure.backendId);
  const provider = providerOfLane(state, failure.backendId);
  if (from === undefined || provider === undefined) return;
  const route: LaneRoute = failure.trigger === "recovery" ? "resume" : failure.trigger;
  const forwarded =
    failure.backendId === ANTHROPIC_BACKEND_ID && failure.customInstructions !== undefined;
  const detail = failure.detail ?? (forwarded ? REASONS.instructionsForwarded : undefined);
  const record: LaneRecordInput = {
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
  };
  if (failure.trigger !== "recovery") record.trigger = failure.trigger;
  if (failure.attempt !== undefined) record.attempt = failure.attempt;
  if (failure.cutFingerprint !== undefined) record.cutFingerprint = failure.cutFingerprint;
  if (failure.tokensAtTrigger !== undefined) record.tokensAtTrigger = failure.tokensAtTrigger;
  state.spec.journal(record);
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
    proposeDraft: () => {},
    findCommittedCandidate: (candidateId, fingerprint) =>
      findCommittedAdoption(manager.getBranch(), spec.ownerKey, candidateId, fingerprint),
  };
}

function branchKey(state: OwnerCoreState): string {
  const branch = state.spec.sessionManager.getBranch();
  const lastLeaf = state.lastLeaf;
  if (lastLeaf !== undefined && !branch.some((entry) => entry.id === lastLeaf)) {
    state.branchEpoch += 1;
  }
  state.lastLeaf = branch.at(-1)?.id;
  return `${state.spec.sessionId}#${state.branchEpoch}`;
}

function exactFreezeOptions(state: OwnerCoreState, context: SnapshotContext): ExactFreezeOptions {
  return {
    ownerKey: state.spec.ownerKey,
    ownerGeneration: state.spec.ownerGeneration,
    providerScope: context.providerScope,
    capturedAt: context.capturedAt,
  };
}

function freezeAt(
  state: OwnerCoreState,
  entries: readonly SessionEntry[],
  cutEntryId: string,
  context: SnapshotContext,
): PrefixSnapshot | undefined {
  const result = freezeSnapshotAt(entries, cutEntryId, exactFreezeOptions(state, context));
  return isSnapshotRefusal(result) || result.cutEntryId !== cutEntryId ? undefined : result;
}

function freeze(state: OwnerCoreState, context: SnapshotContext): FrozenSnapshot | SnapshotRefused {
  if (opaqueBlockFor(state.spec.sessionId, context.entries, context.backendId) !== undefined) {
    return { refused: true, detail: REASONS.opaqueCheckpoint };
  }
  const record = context.recoveryRecord;
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
  const base = freezeSnapshot(context.entries, {
    ...exactFreezeOptions(state, context),
    keepRecentTokens: keepRecentTokens(state.spec),
  });
  if (isSnapshotRefusal(base)) return base;
  if (context.backendId !== ANTHROPIC_BACKEND_ID) return base;
  return legalAnthropicCut(state, base, context);
}

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
  const legalCuts = legalCutEntries(capture, base.cutEntryId, {
    branchExtendsCapture: branchExtendsCapture(capture, context.entries),
  });
  let attempts = 0;
  for (const legal of legalCuts) {
    if (legal === base.cutEntryId) return base;
    const exact = freezeAt(state, context.entries, legal, context);
    if (exact !== undefined) return exact;
    attempts += 1;
    if (attempts >= MAX_NATIVE_CUT_ATTEMPTS) break;
  }
  return attempts === 0
    ? refusedCut("no-legal-cut", true)
    : refusedCut("cut-not-reproducible", true);
}

function branchExtendsCapture(capture: WireCapture, entries: readonly SessionEntry[]): boolean {
  const tail = capture.mapping?.projection.at(-1)?.entryId;
  if (tail === undefined) return false;
  const position = entries.findIndex((entry) => entry.id === tail);
  return position >= 0 && position + 1 < entries.length;
}

function refusedCut(
  detail: "no-legal-cut" | "cut-not-reproducible",
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
  if (state.unsupportedLanes.has(lane)) return;
  const position = contextPosition(state);
  if (state.failedAt === position && state.failedLanes.has(lane)) return;
  if (yieldsToOpaque(state, lane)) return;
  if (anthropicDisabled && backendId === ANTHROPIC_BACKEND_ID && lane === TEXT_BACKEND_ID) {
    announceDisabledYield(state);
  }
  requestThresholdPreparation(state, coordinator, { lane, position }, usage.tokens);
}

function contextPosition(state: OwnerCoreState): string {
  const branch = state.spec.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry !== undefined && CONTEXT_ENTRY_TYPES.has(entry.type)) return entry.id;
  }
  return "";
}

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

function rearmAfterFailure(state: OwnerCoreState, status: DetailedCoordinatorStatus): void {
  if (state.armed || state.lastRequested === undefined) return;
  if (status.candidateId !== state.lastRequested || !TERMINAL_FAILURE.has(status.state)) return;
  state.armed = true;
  state.lastRequested = undefined;
  const failed = status.state === "failed";
  const retryAfterMs = failed ? (status.retryAfterMs ?? 0) : 0;
  state.retryAfter = now(state) + Math.max(state.spec.settings.cooldownMs, retryAfterMs);
  if (failed) barRequestedLane(state, ownerInvariantUnsupported(status));
}

function ownerInvariantUnsupported(status: DetailedCoordinatorStatus): boolean {
  return status.reason === "unsupported" && status.retryAfterMs === undefined;
}

function barRequestedLane(state: OwnerCoreState, unsupported: boolean): void {
  const requested = state.requested;
  state.requested = undefined;
  if (requested === undefined) return;
  if (unsupported) state.unsupportedLanes.add(requested.lane);
  if (state.failedAt !== requested.position) {
    state.failedAt = requested.position;
    state.failedLanes.clear();
  }
  state.failedLanes.add(requested.lane);
}

function requestThresholdPreparation(
  state: OwnerCoreState,
  coordinator: CoordinatorHandle,
  request: ThresholdRequest,
  tokensAtTrigger: number,
): void {
  const report = state.spec.report;
  const requested = coordinator.requestPreparation({
    trigger: "threshold",
    backendId: request.lane,
    tokensAtTrigger,
  });
  coordinator.waitForPreparation().catch((cause: unknown) => {
    report(`preparation failed unexpectedly: ${errorText(cause)}`);
  });
  requested.then(
    (result) => recordPreparationRequest(state, request, result),
    (cause: unknown) => report(`preparation request failed: ${errorText(cause)}`),
  );
}

function recordPreparationRequest(
  state: OwnerCoreState,
  request: ThresholdRequest,
  result: PreparationRequestResult,
): void {
  if (result.accepted) {
    state.armed = false;
    state.lastRequested = result.candidateId;
    state.requested = request;
  } else if (result.reason !== "busy") {
    state.retryAfter = now(state) + state.spec.settings.cooldownMs;
    state.requested = request;
    barRequestedLane(state, result.reason === "unsupported");
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
