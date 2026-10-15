import type { CompactionEntryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { CompactionFileOperations } from "../types.ts";

export type CandidateState =
  | "idle"
  | "queued"
  | "preparing"
  | "ready"
  | "adopting"
  | "installed"
  | "canceled"
  | "failed"
  | "discarded-stale";
/** Terminal candidates never restart; retries stay preparing or create a new candidate. */
export interface CandidateTransitionTable {
  readonly idle: readonly CandidateState[];
  readonly queued: readonly CandidateState[];
  readonly preparing: readonly CandidateState[];
  readonly ready: readonly CandidateState[];
  readonly adopting: readonly CandidateState[];
  readonly installed: readonly CandidateState[];
  readonly canceled: readonly CandidateState[];
  readonly failed: readonly CandidateState[];
  readonly "discarded-stale": readonly CandidateState[];
}
export const CANDIDATE_TRANSITIONS: CandidateTransitionTable = {
  idle: ["queued"],
  queued: ["preparing", "canceled", "failed", "discarded-stale"],
  preparing: ["ready", "canceled", "failed", "discarded-stale"],
  ready: ["adopting", "canceled", "failed", "discarded-stale"],
  adopting: ["installed", "ready", "failed", "discarded-stale"],
  installed: [],
  canceled: [],
  failed: [],
  "discarded-stale": [],
};
const NonEmptyString = Type.String({ minLength: 1 });
const NonNegative = Type.Number({ minimum: 0 });
const PositiveInteger = Type.Integer({ minimum: 1 });
const Strict = { additionalProperties: false };
export const ProviderScopeSchema = Type.Object(
  {
    provider: NonEmptyString,
    baseUrl: Type.Optional(NonEmptyString),
    model: NonEmptyString,
    authMode: Type.Optional(NonEmptyString),
    accountScope: Type.Optional(NonEmptyString),
  },
  Strict,
);
/** Non-secret compatibility identity only; never tokens, headers, or credentials. */
export type ProviderScope = Static<typeof ProviderScopeSchema>;
export const SnapshotIdentitySchema = Type.Object(
  {
    cutEntryId: NonEmptyString,
    prefixFingerprint: NonEmptyString,
    priorCheckpointId: Type.Union([NonEmptyString, Type.Null()]),
    priorCheckpointVersion: Type.Union([PositiveInteger, Type.Null()]),
    ownerKey: NonEmptyString,
    ownerGeneration: Type.Integer({ minimum: 0 }),
    providerScope: ProviderScopeSchema,
  },
  Strict,
);
export type SnapshotIdentity = Static<typeof SnapshotIdentitySchema>;
/** Captured entries must be detached immutable copies; no live host objects. */
export interface FrozenSnapshot extends SnapshotIdentity {
  readonly entries: readonly SessionEntry[];
  readonly splitTurn: boolean;
  readonly governingUserRequest: { readonly entryId: string; readonly content: string } | null;
  readonly fileOps: CompactionFileOperations;
  readonly tokenEstimate: number;
  readonly capturedAt: number;
  /** Backend-specific, immutable request evidence (full canonical prefix for Codex). */
  readonly backendCapture?: unknown;
}
export type FailureReason =
  | "quota"
  | "429"
  | "529"
  | "auth"
  | "timeout"
  | "malformed"
  | "oversized"
  | "no-legal-cut"
  | "unsupported"
  | "canceled"
  | "incompatible";
export type ReasonCode =
  | FailureReason
  | "stale-prefix"
  | "owner-changed"
  | "checkpoint-changed"
  | "manual-instructions"
  | "disabled"
  | "disposed"
  | "draft-not-committed"
  | "prepared"
  | "recovered";
export interface PrepareFailure {
  readonly ok: false;
  readonly reason: FailureReason;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** Backend-specific detail code behind `reason`, for diagnosis only. */
  readonly detail?: string;
}
export type CapabilityVerdict =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: FailureReason };
export type LegalityVerdict =
  | { readonly legal: true }
  | { readonly legal: false; readonly reason: FailureReason; readonly detail?: string };
export const BackgroundUsageSchema = Type.Object(
  {
    input: NonNegative,
    output: NonNegative,
    iterations: Type.Optional(
      Type.Array(Type.Object({ input: NonNegative, output: NonNegative }, Strict)),
    ),
  },
  Strict,
);
export type BackgroundUsage = Static<typeof BackgroundUsageSchema>;
export type CheckpointStrategy =
  | "local-reconciled"
  | "openai-native-compact-v1"
  | "openai-responses-compaction-v2"
  | "anthropic-compaction-on-demand-v1";
/** Backend validates its own payload; coordinator never interprets native contents. */
export interface PreparedCheckpoint<Details = unknown> {
  readonly candidateId: string;
  readonly backendId: string;
  readonly schemaVersion: 1;
  readonly draft: CompactionEntryDraft & { readonly details: Details };
  readonly details: Details;
  readonly usage: BackgroundUsage;
  readonly reasonCodes: readonly ReasonCode[];
}
export interface PreparationBudget {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxResultBytes: number;
  readonly deadlineMs: number;
  readonly maxAttempts: number;
}
export interface Backend<Details = unknown> {
  readonly id: string;
  capability(scope: ProviderScope): Promise<CapabilityVerdict>;
  /** Never edits captured messages to manufacture a legal cut. */
  isLegalCut(snapshot: FrozenSnapshot): LegalityVerdict;
  prepare(
    snapshot: FrozenSnapshot,
    options: {
      readonly signal: AbortSignal;
      readonly budget: PreparationBudget;
      readonly candidateId: string;
      /** User focus from `/compact <instructions>`; a backend that cannot honor it declines. */
      readonly customInstructions?: string;
    },
  ): Promise<PreparedCheckpoint<Details> | PrepareFailure>;
}
export interface ParticipantContext {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly signal: AbortSignal;
}
export interface PreSnapshotParticipant {
  readonly id: string;
  beforeSnapshot(
    context: ParticipantContext,
  ): Promise<{ readonly appendedEntryIds: readonly string[] }>;
}
export interface Adoption {
  readonly adoptionId: string;
  readonly candidateId: string;
  readonly committedEntryId: string;
  readonly backendId: string;
  readonly fingerprint: string;
}
/** Called only after commit, at most once per adoptionId; never a forged host event. */
export interface AdoptionConsumer {
  readonly id: string;
  onAdopted(adoption: Adoption): void | Promise<void>;
}
export interface PreparationRequest {
  readonly trigger: "threshold" | "context-cap" | "manual" | "idle";
  readonly backendId?: string;
  readonly customInstructions?: string;
}
export interface CoordinatorStatus {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly state: CandidateState;
  readonly candidateId?: string;
  readonly backendId?: string;
  readonly reason?: ReasonCode;
  /** Backend detail code behind a failure `reason`. */
  readonly detail?: string;
  /** Instructions the candidate was requested with (`/compact <instructions>`). */
  readonly customInstructions?: string;
  /** Most recent failed candidates of this owner, newest last, for diagnosis after a fallback. */
  readonly recentFailures?: readonly CandidateFailure[];
}
export interface CandidateFailure {
  readonly candidateId: string;
  readonly backendId: string;
  readonly reason: ReasonCode;
  readonly detail: string | null;
  readonly at: number;
}
export type PreparationRequestResult =
  | { readonly accepted: true; readonly candidateId: string }
  | { readonly accepted: false; readonly reason: ReasonCode | "busy" };
/** proceed preserves existing host/manual semantics; adopt is a proposal, not commit. */
export type ArbitrationResult =
  | { readonly action: "proceed" }
  | {
      readonly action: "adopt";
      readonly candidateId: string;
      readonly draft: CompactionEntryDraft;
    };
export interface CoordinatorApi {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  requestPreparation(request?: PreparationRequest): Promise<PreparationRequestResult>;
  cancel(reason?: ReasonCode): void;
  status(): CoordinatorStatus;
  arbitrateHostCompaction(): Promise<ArbitrationResult>;
  arbitrateManualCompact(customInstructions?: string): Promise<ArbitrationResult>;
  registerConsumer(consumer: AdoptionConsumer): () => void;
  registerParticipant(participant: PreSnapshotParticipant): () => void;
  dispose(): void;
}
export const BackgroundCompactionSettingsSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    text: Type.Boolean(),
    codexNative: Type.Boolean(),
    anthropicNative: Type.Boolean(),
    maxConcurrent: PositiveInteger,
    maxQueued: PositiveInteger,
    maxAttempts: PositiveInteger,
    retryBaseMs: NonNegative,
    cooldownMs: NonNegative,
    prepareAt: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    hysteresis: Type.Number({ minimum: 0, exclusiveMaximum: 1 }),
    minReductionTokens: NonNegative,
    reserveTokens: NonNegative,
    maxInputTokens: PositiveInteger,
    maxOutputTokens: PositiveInteger,
    maxResultBytes: PositiveInteger,
    timeoutMs: PositiveInteger,
  },
  Strict,
);
export type BackgroundCompactionSettings = Static<typeof BackgroundCompactionSettingsSchema>;
/** Sidecar may override individual defaults, but unknown keys are rejected. */
export const BackgroundCompactionSidecarSchema = Type.Partial(
  BackgroundCompactionSettingsSchema,
  Strict,
);
export const DEFAULT_BACKGROUND_COMPACTION_SETTINGS: Readonly<BackgroundCompactionSettings> = {
  enabled: false,
  text: false,
  codexNative: false,
  anthropicNative: false,
  maxConcurrent: 2,
  maxQueued: 32,
  maxAttempts: 2,
  retryBaseMs: 1000,
  cooldownMs: 60000,
  prepareAt: 0.7,
  hysteresis: 0.1,
  minReductionTokens: 1024,
  reserveTokens: 8192,
  maxInputTokens: 200000,
  maxOutputTokens: 8192,
  maxResultBytes: 1048576,
  timeoutMs: 120000,
};
export const JsonValueSchema = Type.Cyclic(
  {
    JsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("JsonValue")),
      Type.Record(Type.String(), Type.Ref("JsonValue")),
    ]),
  },
  "JsonValue",
);
export type JsonValue = Static<typeof JsonValueSchema>;
export const CheckpointDetailsSchema = Type.Object(
  {
    strategy: Type.Union([
      Type.Literal("local-reconciled"),
      Type.Literal("openai-native-compact-v1"),
      Type.Literal("openai-responses-compaction-v2"),
      Type.Literal("anthropic-compaction-on-demand-v1"),
    ]),
  },
  { additionalProperties: JsonValueSchema },
);
const DraftUsageSchema = Type.Object(
  {
    input: NonNegative,
    output: NonNegative,
    cacheRead: NonNegative,
    cacheWrite: NonNegative,
    totalTokens: NonNegative,
    cost: Type.Object(
      {
        input: NonNegative,
        output: NonNegative,
        cacheRead: NonNegative,
        cacheWrite: NonNegative,
        total: NonNegative,
      },
      Strict,
    ),
  },
  Strict,
);
const ReasonCodeSchema = Type.Union([
  Type.Literal("quota"),
  Type.Literal("429"),
  Type.Literal("529"),
  Type.Literal("auth"),
  Type.Literal("timeout"),
  Type.Literal("malformed"),
  Type.Literal("oversized"),
  Type.Literal("no-legal-cut"),
  Type.Literal("unsupported"),
  Type.Literal("canceled"),
  Type.Literal("incompatible"),
  Type.Literal("stale-prefix"),
  Type.Literal("owner-changed"),
  Type.Literal("checkpoint-changed"),
  Type.Literal("manual-instructions"),
  Type.Literal("disabled"),
  Type.Literal("disposed"),
  Type.Literal("draft-not-committed"),
  Type.Literal("prepared"),
  Type.Literal("recovered"),
]);
/** Persist only validated ready payloads in protected session storage, never logs. */
export const CandidateRecordSchema = Type.Object(
  {
    customType: Type.Literal("choco-compaction-candidate"),
    schemaVersion: Type.Literal(1),
    candidateId: NonEmptyString,
    backendId: NonEmptyString,
    identity: SnapshotIdentitySchema,
    createdAt: NonNegative,
    customInstructions: Type.Optional(Type.String()),
    checkpoint: Type.Object(
      {
        candidateId: NonEmptyString,
        backendId: NonEmptyString,
        schemaVersion: Type.Literal(1),
        draft: Type.Object(
          {
            type: Type.Literal("compaction"),
            summary: NonEmptyString,
            firstKeptEntryId: Type.Union([NonEmptyString, Type.Null()]),
            details: CheckpointDetailsSchema,
            usage: Type.Optional(DraftUsageSchema),
          },
          Strict,
        ),
        details: CheckpointDetailsSchema,
        usage: BackgroundUsageSchema,
        reasonCodes: Type.Array(ReasonCodeSchema),
      },
      Strict,
    ),
  },
  Strict,
);
export type CandidateRecord = Static<typeof CandidateRecordSchema>;
export function isCandidateRecord<T>(value: T): value is T & CandidateRecord {
  return (
    Value.Check(CandidateRecordSchema, value) &&
    value.candidateId === value.checkpoint.candidateId &&
    value.backendId === value.checkpoint.backendId &&
    Value.Equal(value.checkpoint.details, value.checkpoint.draft.details) &&
    (value.identity.priorCheckpointId === null) === (value.identity.priorCheckpointVersion === null)
  );
}
/** Main adapter uses pi.appendEntry(record.customType, record); owner uses appendCustomEntry. */
export type AppendRecord = (record: CandidateRecord) => void | Promise<void>;
export interface BackendFactoryContext {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly providerScope: ProviderScope;
}
export type BackendFactory = (context: BackendFactoryContext) => Backend | Promise<Backend>;
