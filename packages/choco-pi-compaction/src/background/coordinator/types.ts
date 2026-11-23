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
  readonly backendId: string;
}

export interface CoordinatorPort {
  getBranch(): readonly SessionEntry[];
  getBranchKey(): string;
  getProviderScope(): ProviderScope;
  getLatestCompactionEntry(): { readonly id: string; readonly version: number } | null;
  appendAnchor(): string | Promise<string>;
  proposeDraft(draft: CompactionEntryDraft): void;
  findCommittedCandidate(candidateId: string, fingerprint: string): CommittedCandidate | undefined;
}

export interface CoordinatorDependencies {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly isOwnerCurrent: () => boolean;
  readonly appendRecord: AppendRecord;
  readonly port: CoordinatorPort;
  readonly backends: ReadonlyMap<string, Backend>;
  readonly settings: Readonly<BackgroundCompactionSettings>;
  readonly freezeSnapshot: (context: SnapshotContext) => FrozenSnapshot | SnapshotRefused;
  readonly clock?: SchedulerClock;
  readonly createCandidateId?: () => string;
  readonly headroom?: () => number;
  readonly isBackendEnabled: (
    backendId: string,
    settings: Readonly<BackgroundCompactionSettings>,
  ) => boolean;
  readonly isStaleContextError?: (cause: unknown) => boolean;
  readonly delivered?: DeliveredAdoptions;
  readonly modelBudget?: ModelBudget;
  readonly tokenCounter?: { readonly counter: TokenCounter; readonly model: ModelRef };
  readonly onCandidateFailure?: (failure: CandidateFailurePortEvent) => void;
  readonly cutSalt?: (backendId: string) => string;
  readonly onSuppressed?: (event: SuppressedPortEvent) => void;
}

export type CandidateTrigger = PreparationRequest["trigger"] | "recovery";

export interface CandidateFailurePortEvent {
  readonly candidateId: string;
  readonly backendId: string;
  readonly reason: CandidateFailure["reason"];
  readonly trigger: CandidateTrigger;
  customInstructions?: string;
  detail?: string;
  attempt?: number;
  cutFingerprint?: string;
  tokensAtTrigger?: number;
}

export interface SuppressedPortEvent {
  readonly backendId: string;
  readonly trigger: PreparationRequest["trigger"];
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
  readonly estimatedReductionTokens?: number;
  readonly committedEntryId?: string;
  readonly admission?: AdmissionRecord;
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
  reconcileCommit(draftFinished?: boolean): Promise<void>;
  waitForPreparation(): Promise<void>;
  recover(records: readonly unknown[]): Promise<boolean>;
  setEnabled(enabled: boolean): void;
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
  detail?: string;
  retryAfterMs?: number;
  admission?: AdmissionRecord;
  cancelDeadline: () => void;
}

export type TerminalState = "canceled" | "failed" | "discarded-stale";

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
  readonly recentFailures: CandidateFailure[];
  arbitrating: boolean;
  candidate: Candidate | undefined;
  preparation: Promise<WorkSettlement>;
  readonly cutAttempts: Map<string, number>;
  readonly noProgress: Map<string, { reported: boolean }>;
}

export interface SnapshotRefused {
  readonly refused: true;
  readonly detail: string;
}
