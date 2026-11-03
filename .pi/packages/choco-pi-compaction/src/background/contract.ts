import type { Api, Model } from "@earendil-works/pi-ai";
import type { CompactionEntryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";
import { arr, bool, compile, lit, nullable, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Properties, Schema, Static, StaticObject } from "@earendil-works/pi-schema";
import { finiteInt, finiteNum, nonEmptyStr, nonNegative } from "../guards.ts";
import type { CompactionFileOperations } from "../types.ts";
import { jsonEqual } from "./json-equal.ts";

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
const NonEmptyString = nonEmptyStr();
const NonNegative = nonNegative();
const PositiveInteger = finiteInt(1);
/** Wraps a pi-schema root so the shared recursive `JsonValue` definition resolves inside it. */
export function withJsonValueDefs<T>(schema: Schema<T>): Schema<T> {
  return { ...schema, $defs: JSON_VALUE_DEFS };
}
export const ProviderScopeSchema = obj({
  provider: NonEmptyString,
  baseUrl: opt(NonEmptyString),
  model: NonEmptyString,
  authMode: opt(NonEmptyString),
  accountScope: opt(NonEmptyString),
});
/** Non-secret compatibility identity only; never tokens, headers, or credentials. */
export type ProviderScope = Static<typeof ProviderScopeSchema>;
export const isProviderScope = compile(ProviderScopeSchema).check;
export const SnapshotIdentitySchema = obj({
  cutEntryId: NonEmptyString,
  prefixFingerprint: NonEmptyString,
  priorCheckpointId: nullable(NonEmptyString),
  priorCheckpointVersion: nullable(PositiveInteger),
  ownerKey: NonEmptyString,
  ownerGeneration: finiteInt(0),
  providerScope: ProviderScopeSchema,
});
export type SnapshotIdentity = Static<typeof SnapshotIdentitySchema>;
export const isSnapshotIdentity = compile(SnapshotIdentitySchema).check;
/** Captured entries must be detached immutable copies; no live host objects. */
export interface FrozenSnapshot extends SnapshotIdentity {
  readonly entries: readonly SessionEntry[];
  readonly splitTurn: boolean;
  readonly governingUserRequest: { readonly entryId: string; readonly content: string } | null;
  readonly fileOps: CompactionFileOperations;
  /** Raw chars/4 estimate of every summarized message, untruncated; reported as `tokensBefore`. */
  readonly tokenEstimate: number;
  /**
   * Estimate of the summarization prompt actually sent (tool results truncated
   * as the serializer renders them), calibrated by provider usage when the
   * prefix carries it. Admission gates on this; absent means `tokenEstimate`.
   */
  readonly promptTokenEstimate?: number;
  readonly estimateSource?: EstimateSource;
  /** Tokens per character applied to the rendered prompt. */
  readonly estimateRatio?: number;
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
  /** The provider scope is cooling down after an earlier failure; no request was sent. */
  | "cooling"
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
export const BackgroundUsageSchema = obj({
  input: NonNegative,
  output: NonNegative,
  iterations: opt(arr(obj({ input: NonNegative, output: NonNegative }))),
});
export type BackgroundUsage = Static<typeof BackgroundUsageSchema>;
export const isBackgroundUsage = compile(BackgroundUsageSchema).check;
export type CheckpointStrategy =
  | "local-reconciled"
  | "openai-native-compact-v1"
  | "openai-responses-compaction-v2"
  | "anthropic-compaction-on-demand-v1"
  | "xai-responses-compaction-v1";
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
/** Where an admission token figure came from. */
export type EstimateSource = "usage-calibrated" | "chars" | "counted";
/** The model a token counter counts for; the owner's own session model. */
export type ModelRef = Model<Api>;
/**
 * Provider-side prompt token counter. Returns undefined when it cannot count
 * (unsupported provider, transport failure, timeout); it must never throw.
 */
export interface TokenCounter {
  countTokens(input: {
    readonly system: string;
    readonly promptText: string;
    readonly model: ModelRef;
    readonly signal: AbortSignal;
    /** Receives a short `count-tokens: <code>` note when the count falls back. */
    readonly onDiagnostic?: (detail: string) => void;
  }): Promise<number | undefined>;
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
const settingsFields = {
  enabled: bool(),
  text: bool(),
  codexNative: bool(),
  anthropicNative: bool(),
  maxConcurrent: PositiveInteger,
  maxQueued: PositiveInteger,
  maxAttempts: PositiveInteger,
  retryBaseMs: NonNegative,
  cooldownMs: NonNegative,
  prepareAt: finiteNum({ exclusiveMinimum: 0, maximum: 1 }),
  hysteresis: finiteNum({ minimum: 0, exclusiveMaximum: 1 }),
  minReductionTokens: NonNegative,
  reserveTokens: NonNegative,
  maxInputTokens: PositiveInteger,
  maxOutputTokens: PositiveInteger,
  maxResultBytes: PositiveInteger,
  timeoutMs: PositiveInteger,
  countTokens: bool(),
};
export const BackgroundCompactionSettingsSchema = obj(settingsFields);
export type BackgroundCompactionSettings = Static<typeof BackgroundCompactionSettingsSchema>;
export const isBackgroundCompactionSettings = compile(BackgroundCompactionSettingsSchema).check;
/** Sidecar may override individual defaults, but unknown keys are rejected. */
export const BackgroundCompactionSidecarSchema = obj({
  enabled: opt(settingsFields.enabled),
  text: opt(settingsFields.text),
  codexNative: opt(settingsFields.codexNative),
  anthropicNative: opt(settingsFields.anthropicNative),
  maxConcurrent: opt(settingsFields.maxConcurrent),
  maxQueued: opt(settingsFields.maxQueued),
  maxAttempts: opt(settingsFields.maxAttempts),
  retryBaseMs: opt(settingsFields.retryBaseMs),
  cooldownMs: opt(settingsFields.cooldownMs),
  prepareAt: opt(settingsFields.prepareAt),
  hysteresis: opt(settingsFields.hysteresis),
  minReductionTokens: opt(settingsFields.minReductionTokens),
  reserveTokens: opt(settingsFields.reserveTokens),
  maxInputTokens: opt(settingsFields.maxInputTokens),
  maxOutputTokens: opt(settingsFields.maxOutputTokens),
  maxResultBytes: opt(settingsFields.maxResultBytes),
  timeoutMs: opt(settingsFields.timeoutMs),
  countTokens: opt(settingsFields.countTokens),
});
/** Compiled once; settings use its `errors()` for the first-violation diagnostic. */
export const backgroundCompactionSidecarValidator = compile(BackgroundCompactionSidecarSchema);
export const isBackgroundCompactionSidecar = backgroundCompactionSidecarValidator.check;
export const DEFAULT_BACKGROUND_COMPACTION_SETTINGS: Readonly<BackgroundCompactionSettings> = {
  enabled: true,
  text: true,
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
  maxInputTokens: 1000000,
  maxOutputTokens: 8192,
  maxResultBytes: 1048576,
  timeoutMs: 120000,
  countTokens: true,
};
/** Any JSON value (recursive); declared explicitly because `Static` cannot follow `$ref`. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
/**
 * The shared recursive definition. A schema that embeds {@link jsonValueRef}
 * must be wrapped with {@link withJsonValueDefs}: pi-schema resolves `$ref`
 * against the compiled root, so the definitions live on each root.
 */
const JSON_VALUE_DEFS = {
  JsonValue: {
    anyOf: [
      { type: "null" },
      { type: "boolean" },
      // Bounded: pi-schema numbers accept NaN and Infinity, TypeBox `Number` did not.
      { type: "number", minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE },
      { type: "string" },
      { type: "array", items: { $ref: "#/$defs/JsonValue" } },
      { type: "object", additionalProperties: { $ref: "#/$defs/JsonValue" } },
    ],
  },
};
/** Embed inside a schema wrapped by {@link withJsonValueDefs}. */
export const jsonValueRef: Schema<JsonValue> = { $ref: "#/$defs/JsonValue" };
/** Standalone root; it carries its own definitions, so do not embed it inside another schema. */
export const JsonValueSchema: Schema<JsonValue> = withJsonValueDefs(jsonValueRef);
export const isJsonValue = compile(JsonValueSchema).check;
/** A string-keyed record of JSON values (TypeBox `Record(String, JsonValue)`), as a standalone root. */
export type JsonRecord = { [key: string]: JsonValue };
/** The un-wrapped record schema, for embedding inside a root wrapped by {@link withJsonValueDefs}. */
export const jsonRecordMember: Schema<JsonRecord> = {
  type: "object",
  additionalProperties: { $ref: "#/$defs/JsonValue" },
};
export const JsonRecordSchema: Schema<JsonRecord> = withJsonValueDefs(jsonRecordMember);
export const isJsonRecord = compile(JsonRecordSchema).check;
const CHECKPOINT_STRATEGIES = [
  "local-reconciled",
  "openai-native-compact-v1",
  "openai-responses-compaction-v2",
  "anthropic-compaction-on-demand-v1",
  "xai-responses-compaction-v1",
] as const;
/**
 * An object whose listed `properties` are validated and whose every other key
 * must hold a JSON value (TypeBox `additionalProperties: JsonValueSchema`).
 * Embed it only inside a root wrapped by {@link withJsonValueDefs}.
 */
export function jsonRest<const P extends Properties>(
  properties: P,
): Schema<StaticObject<P> & JsonRecord> {
  return {
    // Keywords only: the builder's type-level brand is replaced by this function's return type.
    ...Object.fromEntries(Object.entries(obj(properties, { open: true }))),
    additionalProperties: { $ref: "#/$defs/JsonValue" },
  };
}
/** `{ strategy }` plus any other JSON-valued keys: the backend owns the rest. */
const checkpointDetails = jsonRest({ strategy: oneOf(CHECKPOINT_STRATEGIES) });
export type CheckpointDetails = Static<typeof checkpointDetails>;
export const CheckpointDetailsSchema = withJsonValueDefs(checkpointDetails);
export const isCheckpointDetails = compile(CheckpointDetailsSchema).check;
const DraftUsageSchema = obj({
  input: NonNegative,
  output: NonNegative,
  cacheRead: NonNegative,
  cacheWrite: NonNegative,
  totalTokens: NonNegative,
  cost: obj({
    input: NonNegative,
    output: NonNegative,
    cacheRead: NonNegative,
    cacheWrite: NonNegative,
    total: NonNegative,
  }),
});
const ReasonCodeSchema = oneOf([
  "quota",
  "429",
  "529",
  "auth",
  "timeout",
  "malformed",
  "oversized",
  "no-legal-cut",
  "unsupported",
  "canceled",
  "incompatible",
  "cooling",
  "stale-prefix",
  "owner-changed",
  "checkpoint-changed",
  "manual-instructions",
  "disabled",
  "disposed",
  "draft-not-committed",
  "prepared",
  "recovered",
]);
/** Persist only validated ready payloads in protected session storage, never logs. */
export const CandidateRecordSchema = withJsonValueDefs(
  obj({
    customType: lit("choco-compaction-candidate"),
    schemaVersion: lit(1),
    candidateId: NonEmptyString,
    backendId: NonEmptyString,
    identity: SnapshotIdentitySchema,
    createdAt: NonNegative,
    customInstructions: opt(str()),
    /** How admission sized the prompt, for diagnosis only. */
    admission: opt(
      obj({
        promptTokens: NonNegative,
        budget: NonNegative,
        source: oneOf(["usage-calibrated", "chars", "counted"]),
        ratio: opt(NonNegative),
        /** Why a provider count fell back to the estimate, e.g. `count-tokens: http 500`. */
        detail: opt(NonEmptyString),
      }),
    ),
    checkpoint: obj({
      candidateId: NonEmptyString,
      backendId: NonEmptyString,
      schemaVersion: lit(1),
      draft: obj({
        type: lit("compaction"),
        summary: NonEmptyString,
        firstKeptEntryId: nullable(NonEmptyString),
        details: checkpointDetails,
        usage: opt(DraftUsageSchema),
      }),
      details: checkpointDetails,
      usage: BackgroundUsageSchema,
      reasonCodes: arr(ReasonCodeSchema),
    }),
  }),
);
export type CandidateRecord = Static<typeof CandidateRecordSchema>;
const candidateRecordValidator = compile(CandidateRecordSchema);
/** Admission sizing persisted with a candidate record and shown in status. */
export type AdmissionRecord = NonNullable<CandidateRecord["admission"]>;
export function isCandidateRecord<T>(value: T): value is T & CandidateRecord {
  return (
    candidateRecordValidator.check(value) &&
    value.candidateId === value.checkpoint.candidateId &&
    value.backendId === value.checkpoint.backendId &&
    jsonEqual(value.checkpoint.details, value.checkpoint.draft.details) &&
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
