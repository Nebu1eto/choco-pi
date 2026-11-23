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
export interface FrozenSnapshot extends SnapshotIdentity {
  readonly entries: readonly SessionEntry[];
  readonly splitTurn: boolean;
  readonly governingUserRequest: { readonly entryId: string; readonly content: string } | null;
  readonly fileOps: CompactionFileOperations;
  readonly tokenEstimate: number;
  readonly promptTokenEstimate?: number;
  readonly estimateSource?: EstimateSource;
  readonly estimateRatio?: number;
  readonly capturedAt: number;
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
export type EstimateSource = "usage-calibrated" | "chars" | "counted";
export type ModelRef = Model<Api>;
export interface TokenCounter {
  countTokens(input: {
    readonly system: string;
    readonly promptText: string;
    readonly model: ModelRef;
    readonly signal: AbortSignal;
    readonly onDiagnostic?: (detail: string) => void;
  }): Promise<number | undefined>;
}
export interface Backend<Details = unknown> {
  readonly id: string;
  capability(scope: ProviderScope): Promise<CapabilityVerdict>;
  isLegalCut(snapshot: FrozenSnapshot): LegalityVerdict;
  prepare(
    snapshot: FrozenSnapshot,
    options: {
      readonly signal: AbortSignal;
      readonly budget: PreparationBudget;
      readonly candidateId: string;
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
export interface AdoptionConsumer {
  readonly id: string;
  onAdopted(adoption: Adoption): void | Promise<void>;
}
export interface PreparationRequest {
  readonly trigger: "threshold" | "context-cap" | "manual" | "idle";
  readonly backendId?: string;
  readonly customInstructions?: string;
  readonly tokensAtTrigger?: number;
}
export interface CoordinatorStatus {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly state: CandidateState;
  readonly candidateId?: string;
  readonly backendId?: string;
  readonly reason?: ReasonCode;
  readonly detail?: string;
  readonly customInstructions?: string;
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
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
const JSON_VALUE_DEFS = {
  JsonValue: {
    anyOf: [
      { type: "null" },
      { type: "boolean" },
      { type: "number", minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE },
      { type: "string" },
      { type: "array", items: { $ref: "#/$defs/JsonValue" } },
      { type: "object", additionalProperties: { $ref: "#/$defs/JsonValue" } },
    ],
  },
};
export const jsonValueRef: Schema<JsonValue> = { $ref: "#/$defs/JsonValue" };
export const JsonValueSchema: Schema<JsonValue> = withJsonValueDefs(jsonValueRef);
export const isJsonValue = compile(JsonValueSchema).check;
export type JsonRecord = { [key: string]: JsonValue };
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
export function jsonRest<const P extends Properties>(
  properties: P,
): Schema<StaticObject<P> & JsonRecord> {
  return {
    ...Object.fromEntries(Object.entries(obj(properties, { open: true }))),
    additionalProperties: { $ref: "#/$defs/JsonValue" },
  };
}
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
export const CandidateRecordSchema = withJsonValueDefs(
  obj({
    customType: lit("choco-compaction-candidate"),
    schemaVersion: lit(1),
    candidateId: NonEmptyString,
    backendId: NonEmptyString,
    identity: SnapshotIdentitySchema,
    createdAt: NonNegative,
    customInstructions: opt(str()),
    admission: opt(
      obj({
        promptTokens: NonNegative,
        budget: NonNegative,
        source: oneOf(["usage-calibrated", "chars", "counted"]),
        ratio: opt(NonNegative),
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
export type AppendRecord = (record: CandidateRecord) => void | Promise<void>;
export interface BackendFactoryContext {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly providerScope: ProviderScope;
}
export type BackendFactory = (context: BackendFactoryContext) => Backend | Promise<Backend>;
