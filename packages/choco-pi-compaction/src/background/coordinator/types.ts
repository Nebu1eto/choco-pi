/** Coordinator types: the host port, dependencies, status, and the explicit state every step receives. */
import type {
  CompactionEntryDraft,
  CompactionResult,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  AdmissionRecord,
  AdoptionConsumer,
  AppendRecord,
  Backend,
  BackgroundCompactionSettings,
  BackgroundUsage,
  CandidateFailure,
  CandidateRecord,
  CoordinatorApi,
  CoordinatorStatus,
  FrozenSnapshot,
  ModelRef,
  PreparationRequest,
  PreSnapshotParticipant,
  ProviderScope,
  ReasonCode,
  TokenCounter,
} from "../contract.ts";
import { type ModelBudget } from "../../budget.ts";
import { AdoptionDelivery, type CommittedCandidate, type DeliveredAdoptions } from "../adoption.ts";
import { type HostCompactionTrigger } from "../arbitration.ts";
import { CandidateMachine } from "../state-machine.ts";
import { type SchedulerClock, type WorkSettlement } from "../scheduler.ts";

export interface SnapshotContext {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly providerScope: ProviderScope;
  readonly entries: readonly SessionEntry[];
  readonly latestCheckpoint: { readonly id: string; readonly version: number } | null;
  readonly capturedAt: number;
  readonly participantEntryIds: readonly string[];
  readonly recoveryRecord?: CandidateRecord;
  /** Backend that will prepare this snapshot; lane-specific cut rules apply only to it. */
  readonly backendId: string;
}

/** Synchronous reads must refer to one currently held owner. No method starts a foreground run. */
export interface CoordinatorPort {
  getBranch(): readonly SessionEntry[];
  getBranchKey(): string;
  getProviderScope(): ProviderScope;
  getLatestCompactionEntry(): { readonly id: string; readonly version: number } | null;
  appendAnchor(): string | Promise<string>;
  /** Observe a proposal only; this is NOT permission to commit or invoke ctx.compact(). */
  proposeDraft(draft: CompactionEntryDraft): void;
  findCommittedCandidate(candidateId: string, fingerprint: string): CommittedCandidate | undefined;
}

export interface CoordinatorDependencies {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  /** Scalar owner token check; must remain usable after the host context is invalidated. */
  readonly isOwnerCurrent: () => boolean;
  readonly appendRecord: AppendRecord;
  readonly port: CoordinatorPort;
  readonly backends: ReadonlyMap<string, Backend>;
  readonly settings: Readonly<BackgroundCompactionSettings>;
  /**
   * The host adapts the pure snapshot builder; the coordinator overrides its
   * runtime identity. A refusal names why no cut was frozen.
   */
  readonly freezeSnapshot: (context: SnapshotContext) => FrozenSnapshot | SnapshotRefused;
  readonly clock?: SchedulerClock;
  readonly createCandidateId?: () => string;
  readonly headroom?: () => number;
  /** Host-owned backend flag mapping; the neutral core does not infer provider IDs. */
  readonly isBackendEnabled: (
    backendId: string,
    settings: Readonly<BackgroundCompactionSettings>,
  ) => boolean;
  readonly isStaleContextError?: (cause: unknown) => boolean;
  /** In-process delivery ledger shared across reloads of the same owner; a fresh process starts empty. */
  readonly delivered?: DeliveredAdoptions;
  /**
   * Window and output cap of the owner's model. Admission and the backend
   * budget use `min(maxInputTokens, contextWindow - output cap - margin)`;
   * without it only the configured ceiling applies.
   */
  readonly modelBudget?: ModelBudget;
  /** Provider prompt counter; when it returns a count, it replaces the estimate. */
  readonly tokenCounter?: { readonly counter: TokenCounter; readonly model: ModelRef };
  /**
   * Failure port: observes each candidate's terminal `failed`, `canceled` or
   * `discarded-stale` transition exactly once, after the transition. Not
   * called once the coordinator is disposed or for a `disposed` teardown (a
   * lifecycle event, not a lane transition). A stale-context failure of the
   * observer is contained; any other failure reaches the caller.
   */
  readonly onCandidateFailure?: (failure: CandidateFailurePortEvent) => void;
  /**
   * Non-manual salt for the cut fingerprint: whatever besides the branch the
   * cut search depends on (keep tokens, latest wire capture). Absent: the
   * branch alone decides.
   */
  readonly cutSalt?: (backendId: string) => string;
  /**
   * Called once per cut fingerprint and lane when a trigger is not started
   * because nothing changed since that lane ended with no legal cut. A
   * stale-context failure of the observer is contained.
   */
  readonly onSuppressed?: (event: SuppressedPortEvent) => void;
}

/** What requested a candidate; `recovery` restores a persisted record at session start. */
export type CandidateTrigger = PreparationRequest["trigger"] | "recovery";

/** One candidate's terminal outcome as the failure port reports it. */
export interface CandidateFailurePortEvent {
  readonly candidateId: string;
  readonly backendId: string;
  readonly reason: CandidateFailure["reason"];
  readonly trigger: CandidateTrigger;
  /** Instructions the candidate was requested with (`/compact <instructions>`). */
  customInstructions?: string;
  /** Backend detail code, or the coordinator's own (`overflow` for an overflow cancel). */
  detail?: string;
  /** 1-based attempt number for `cutFingerprint`. */
  attempt?: number;
  cutFingerprint?: string;
  tokensAtTrigger?: number;
}

/** A trigger the no-progress guard did not start (see `CoordinatorDependencies.onSuppressed`). */
export interface SuppressedPortEvent {
  readonly backendId: string;
  readonly trigger: PreparationRequest["trigger"];
  /** The attempt number that was not started. */
  readonly attempt: number;
  readonly cutFingerprint: string;
  readonly tokensAtTrigger?: number;
}

export interface DetailedCoordinatorStatus extends CoordinatorStatus {
  readonly durationMs: number;
  readonly queueDelayMs: number;
  readonly preparationMs: number;
  readonly attempts: number;
  readonly usage?: BackgroundUsage;
  /** Estimate only: tokenEstimate minus usage.output. Real usefulness is backend-owned. */
  readonly estimatedReductionTokens?: number;
  readonly committedEntryId?: string;
  /** How admission sized the prompt of the current candidate. */
  readonly admission?: AdmissionRecord;
  /**
   * The retry delay the backend reported with the candidate's terminal
   * failure (`PrepareFailure.retryAfterMs`). Its presence marks a failure the
   * backend expects to clear (a capture-specific `unsupported`, for one).
   */
  readonly retryAfterMs?: number;
}

export type CoordinatorArbitrationResult =
  | { readonly action: "proceed" }
  | {
      readonly action: "adopt";
      readonly candidateId: string;
      readonly draft: CompactionEntryDraft & CompactionResult;
      readonly compaction: CompactionResult;
    };

export interface CoordinatorHandle extends CoordinatorApi {
  status(): DetailedCoordinatorStatus;
  arbitrateHostCompaction(event?: HostCompactionTrigger): Promise<CoordinatorArbitrationResult>;
  arbitrateManualCompact(customInstructions?: string): Promise<CoordinatorArbitrationResult>;
  /** Call after the boundary/compact callback has settled, not while a proposal is in flight. */
  reconcileCommit(draftFinished?: boolean): Promise<void>;
  /** Unexpected background exceptions rethrow here; the launch promise never rejects. */
  waitForPreparation(): Promise<void>;
  recover(records: readonly unknown[]): Promise<boolean>;
  setEnabled(enabled: boolean): void;
  /** Permanently revoke this owner token; replacement owners need a new coordinator. */
  invalidate(reason?: ReasonCode): void;
  hostRefused(): Promise<void>;
}

export interface Candidate {
  readonly id: string;
  readonly backendId: string;
  readonly trigger: CandidateTrigger;
  readonly machine: CandidateMachine;
  readonly abort: AbortController;
  readonly createdAt: number;
  readonly customInstructions?: string;
  /** Cut fingerprint and 1-based attempt number at request time. */
  cutFingerprint?: string;
  attempt?: number;
  tokensAtTrigger?: number;
  snapshot?: FrozenSnapshot;
  branchKey?: string;
  checkpoint?: CandidateRecord["checkpoint"];
  startedAt?: number;
  preparedAt?: number;
  finishedAt?: number;
  attempts: number;
  committedEntryId?: string;
  /** Backend detail code behind the terminal failure reason. */
  detail?: string;
  /** Retry delay reported with the terminal failure, if any. */
  retryAfterMs?: number;
  admission?: AdmissionRecord;
  cancelDeadline: () => void;
}

export type TerminalState = "canceled" | "failed" | "discarded-stale";

/** Explicit coordinator state; every step below receives it instead of closing over a factory. */
export interface CoordinatorState {
  readonly deps: CoordinatorDependencies;
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly clock: SchedulerClock;
  readonly settings: BackgroundCompactionSettings;
  readonly participants: Map<string, PreSnapshotParticipant>;
  readonly consumers: Map<string, AdoptionConsumer>;
  readonly delivery: AdoptionDelivery;
  enabled: boolean;
  disposed: boolean;
  invalidated: boolean;
  /** Bounded, newest last. */
  readonly recentFailures: CandidateFailure[];
  arbitrating: boolean;
  candidate: Candidate | undefined;
  preparation: Promise<WorkSettlement>;
  /** Attempts started per cut fingerprint (bounded, oldest dropped). */
  readonly cutAttempts: Map<string, number>;
  /**
   * Lane + cut fingerprints whose last attempt ended with no legal cut. A
   * request that computes the same fingerprint is not started (manual ones
   * excepted); a changed fingerprint is simply absent, which re-arms the lane.
   * No time-based cooldown: see `selectSnapshot`.
   */
  readonly noProgress: Map<string, { reported: boolean }>;
}

/** No cut could be frozen; `detail` is the builder's refusal code. */
export interface SnapshotRefused {
  readonly refused: true;
  readonly detail: string;
}
