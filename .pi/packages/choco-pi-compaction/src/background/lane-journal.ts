/**
 * Lane journal: one model-invisible custom entry per compaction-lane
 * transition (attempt outcome, lane change, disable, cooldown start, consent,
 * loss). Records carry only this package's own stable codes ({@link REASONS},
 * enforced by the schema for `reason`): provider error text and
 * provider-supplied codes NEVER go into `reason` or `detail`; producers map
 * them with {@link ownedReasonOf}. Notice dedupe is separate from journal
 * retention (see `background-host/notices.ts`).
 */
import { bool, compile, lit, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { finiteInt, nonEmptyStr, nonNegative } from "../guards.ts";
import { isStaleContextError } from "../lifecycle.ts";
import { LANE_RECORD_TYPE as LANE_ENTRY_TYPE } from "./entry-types.ts";
import { CompactionTriggerSchema } from "../trigger.ts";

/** The custom entry type of lane records (declared with the other entry types in `entry-types.ts`). */
export const LANE_RECORD_TYPE = LANE_ENTRY_TYPE;

const NonEmptyString = nonEmptyStr();

const LaneIdSchema = oneOf([
  "anthropic-native",
  "xai-native",
  "codex-native-v2",
  "codex-foreground",
  "text",
  "local",
  "host-default",
]);
export type LaneId = Static<typeof LaneIdSchema>;

const LaneRouteSchema = oneOf([
  "foreground",
  "manual",
  "threshold",
  "boundary",
  "idle",
  "context-cap",
  "replay",
  "resume",
  "mode-change",
  "model-select",
  "config-change",
]);
export type LaneRoute = Static<typeof LaneRouteSchema>;

const LaneEventSchema = oneOf([
  "fallback",
  "yield",
  "cancel",
  "disable",
  "cooldown",
  "refuse",
  "consent",
  "loss",
  /** A trigger was not started because nothing changed since a no-legal-cut attempt. */
  "suppressed",
]);
export type LaneEvent = Static<typeof LaneEventSchema>;

const LaneProviderSchema = oneOf(["anthropic", "xai", "codex"]);
export type LaneProvider = Static<typeof LaneProviderSchema>;

/**
 * The package-owned code vocabulary of lane records (`reason`, and `detail`
 * when it carries a code), the single source of what may be journaled.
 * Provider error text and provider-supplied codes (an Anthropic
 * `error.details.error_code` such as `compaction_*`, a third-party backend's
 * detail) are never journaled as they are: {@link ownedReasonOf} maps any
 * string that is not one of these codes to `provider-error`. A new code is
 * added here, which also extends the schema.
 */
export const REASONS = {
  /** No capture exists for the session. */
  noCapture: "no-capture",
  /** Captures exist but none is usable for the scope. */
  noUsableCapture: "no-usable-capture",
  /** The latest checkpoint is an opaque record the answering lane cannot replay. */
  opaqueCheckpoint: "opaque-checkpoint",
  /** A persisted checkpoint's provider scope differs from the current request. */
  scopeMismatch: "scope-mismatch",
  /** The credential was refused. */
  auth: "auth",
  /** The credential could not be read right now; retried later. */
  authTransient: "auth-transient",
  /** The provider scope is cooling down after earlier failures. */
  cooldown: "cooldown",
  /** The checkpoint or candidate does not fit the current owner. */
  incompatible: "incompatible",
  /** No legal cut exists for the native lane. */
  noLegalCut: "no-legal-cut",
  /** The model, endpoint or auth mode is not supported by the lane. */
  unsupported: "unsupported",
  /** The capability gate did not admit the scope (policy decline). */
  notAdmitted: "not-admitted",
  /** The vendor's server-side mode is off (policy decline). */
  modeOff: "mode-off",
  /** `/compact <instructions>` could not be forwarded natively. */
  instructionsIgnored: "instructions-ignored",
  /** `/compact <instructions>` was forwarded to the native lane. */
  instructionsForwarded: "instructions-forwarded",
  /** A host overflow compaction canceled the candidate. */
  overflow: "overflow",
  /** A branch switch invalidated the candidate. */
  branchSwitch: "branch-switch",
  /** The provider failed in a way this package has no own code for (any non-owned code maps here). */
  providerError: "provider-error",
  /** The transport check refused the outgoing request. */
  transportRefused: "transport-refused",
  /** A replay could not be verified at the transport; the summary text was sent instead. */
  unverifiable: "unverifiable",
  /** The user authorized losing an opaque checkpoint's history. */
  consent: "consent",
  /** An opaque checkpoint's history was dropped. */
  loss: "loss",

  // Coordinator `ReasonCode`s (`background/contract.ts`) not listed above.
  quota: "quota",
  http429: "429",
  http529: "529",
  timeout: "timeout",
  malformed: "malformed",
  oversized: "oversized",
  canceled: "canceled",
  cooling: "cooling",
  stalePrefix: "stale-prefix",
  ownerChanged: "owner-changed",
  checkpointChanged: "checkpoint-changed",
  manualInstructions: "manual-instructions",
  disabled: "disabled",
  disposed: "disposed",
  draftNotCommitted: "draft-not-committed",
  prepared: "prepared",
  recovered: "recovered",

  // Replay refusal codes of this package's transport checks (Anthropic and xAI).
  detailsInvalid: "details-invalid",
  payloadUnrecognized: "payload-unrecognized",
  summaryNotFirst: "summary-not-first",
  multipleBlocks: "multiple-blocks",
  contextManagement: "context-management",
  taskBudgetRemaining: "task-budget-remaining",
  bindingMismatch: "binding-mismatch",
  blockMissing: "block-missing",
  blockAltered: "block-altered",
  betaMissing: "beta-missing",
  summaryDuplicated: "summary-duplicated",
  multipleItems: "multiple-items",
  previousResponse: "previous-response",
  itemMissing: "item-missing",
  itemAltered: "item-altered",
  itemNotFirst: "item-not-first",

  // Replay-disable codes this package mints from a provider response.
  /** Anthropic OAuth extra-usage entitlement refusal (`OAUTH_ENTITLEMENT_CODE`). */
  oauthExtraUsage: "oauth-extra-usage",
  /** xAI rejected a replayed item with HTTP 400 / 422. */
  provider400: "provider-400",
  provider422: "provider-422",

  // Own detail codes behind a candidate failure (coordinator, snapshot, text and Anthropic backends).
  prefixMismatch: "prefix-mismatch",
  resultBytes: "result-bytes",
  outputOverBudget: "output-over-budget",
  prefixOverBudget: "prefix-over-budget",
  noPassPlan: "no-pass-plan",
  secondPassOverBudget: "second-pass-over-budget",
  summaryTruncated: "summary-truncated",
  emptyBranch: "empty-branch",
  brokenChain: "broken-chain",
  duplicateEntryId: "duplicate-entry-id",
  nothingToSummarize: "nothing-to-summarize",
  splitTurnWithoutGoverningRequest: "split-turn-without-governing-request",
  noRetainedEntry: "no-retained-entry",
  unmappedCapture: "unmapped-capture",
  cutNotCaptured: "cut-not-captured",
  ambiguousOrder: "ambiguous-order",
  ambiguousCut: "ambiguous-cut",
  straddlesCut: "straddles-cut",
  order: "order",
  prefixGap: "prefix-gap",
  firstKeptUnplaced: "first-kept-unplaced",
  firstKeptSystem: "first-kept-system",
  firstKeptNotUser: "first-kept-not-user",
  sameRole: "same-role",
  openToolCall: "open-tool-call",
  outOfRange: "out-of-range",
} as const;

/** One package-owned lane code. */
export type LaneReason = (typeof REASONS)[keyof typeof REASONS];

const OWNED_REASONS: readonly LaneReason[] = Object.values(REASONS);
const OWNED_REASON_SET: ReadonlySet<string> = new Set(OWNED_REASONS);

/** Whether `candidate` is one of this package's own codes. */
export function isOwnedReason(candidate: string): candidate is LaneReason {
  return OWNED_REASON_SET.has(candidate);
}

/**
 * The owned code `candidate` names, or `provider-error` for anything else
 * (provider-supplied codes, error text, a foreign backend's detail). Every
 * producer that journals a string it did not mint itself goes through here.
 */
export function ownedReasonOf(candidate: string): LaneReason {
  return isOwnedReason(candidate) ? candidate : REASONS.providerError;
}

/**
 * `reason` admits exactly the owned codes: the schema itself enforces their
 * provenance. An enum of the literals.
 */
const LaneReasonSchema = oneOf(OWNED_REASONS);

/** Field schemas by name, exposed as `LaneRecordSchema.properties` (the object schema's own keyword). */
const laneFields = {
  customType: lit(LANE_RECORD_TYPE),
  schemaVersion: lit(1),
  at: nonNegative(),
  sessionId: NonEmptyString,
  provider: LaneProviderSchema,
  route: LaneRouteSchema,
  event: LaneEventSchema,
  from: LaneIdSchema,
  to: LaneIdSchema,
  /** One of {@link REASONS}. */
  reason: LaneReasonSchema,
  /** Free-form, but only own codes or text: provider input goes through {@link ownedReasonOf}. */
  detail: str({ maxLength: 128 }),
  candidateId: NonEmptyString,
  checkpointEntryId: NonEmptyString,
  cooldownUntil: nonNegative(),
  /** What started the compaction this transition belongs to; absent on records written before it was journaled. */
  trigger: CompactionTriggerSchema,
  /** 1-based attempt number for the cut fingerprint; absent on records written before it was journaled. */
  attempt: finiteInt(1),
  /** Stable hash of the candidate cut (see `cutFingerprint` in snapshot.ts); absent on older records. */
  cutFingerprint: NonEmptyString,
  /** Context tokens when the trigger fired; absent on older records and non-threshold routes. */
  tokensAtTrigger: nonNegative(),
  noticeAttempted: bool(),
};
const laneRecordSchema = obj({
  customType: laneFields.customType,
  schemaVersion: laneFields.schemaVersion,
  at: laneFields.at,
  sessionId: laneFields.sessionId,
  provider: laneFields.provider,
  route: laneFields.route,
  event: laneFields.event,
  from: laneFields.from,
  to: opt(laneFields.to),
  reason: laneFields.reason,
  detail: opt(laneFields.detail),
  candidateId: opt(laneFields.candidateId),
  checkpointEntryId: opt(laneFields.checkpointEntryId),
  cooldownUntil: opt(laneFields.cooldownUntil),
  trigger: opt(laneFields.trigger),
  attempt: opt(laneFields.attempt),
  cutFingerprint: opt(laneFields.cutFingerprint),
  tokensAtTrigger: opt(laneFields.tokensAtTrigger),
  noticeAttempted: laneFields.noticeAttempted,
});
export type LaneRecord = Static<typeof laneRecordSchema>;
export const LaneRecordSchema = { ...laneRecordSchema, properties: laneFields };
const laneRecordValidator = compile(laneRecordSchema);
export const isLaneRecord = laneRecordValidator.check;

/** A record as callers build it; the envelope fields are added on append. */
export type LaneRecordInput = Omit<LaneRecord, "customType" | "schemaVersion">;

/** `pi.appendEntry` or a structurally compatible sink. */
export type LaneAppend = (customType: string, data: LaneRecord) => void;

/** Copy the defined fields only, so optional keys never carry `undefined` into validation or storage. */
function envelope(input: LaneRecordInput): LaneRecord {
  const record: LaneRecord = {
    customType: LANE_RECORD_TYPE,
    schemaVersion: 1,
    at: input.at,
    sessionId: input.sessionId,
    provider: input.provider,
    route: input.route,
    event: input.event,
    from: input.from,
    reason: input.reason,
    noticeAttempted: input.noticeAttempted,
  };
  if (input.to !== undefined) record.to = input.to;
  if (input.detail !== undefined) record.detail = input.detail;
  if (input.candidateId !== undefined) record.candidateId = input.candidateId;
  if (input.checkpointEntryId !== undefined) record.checkpointEntryId = input.checkpointEntryId;
  if (input.cooldownUntil !== undefined) record.cooldownUntil = input.cooldownUntil;
  if (input.trigger !== undefined) record.trigger = input.trigger;
  if (input.attempt !== undefined) record.attempt = input.attempt;
  if (input.cutFingerprint !== undefined) record.cutFingerprint = input.cutFingerprint;
  if (input.tokensAtTrigger !== undefined) record.tokensAtTrigger = input.tokensAtTrigger;
  return record;
}

/**
 * Validate and append one lane record. An invalid record is dropped and
 * reported (the journal is observability, never control flow). A
 * stale-context failure of the append (the host session is gone) is
 * contained; every other failure reaches the caller. Returns whether the
 * record was appended.
 */
export function appendLaneRecord(
  append: LaneAppend,
  input: LaneRecordInput,
  report: (message: string) => void,
): boolean {
  const record = envelope(input);
  if (!isLaneRecord(record)) {
    const first = laneRecordValidator.errors(record)[0];
    const path = first === undefined || first.path === "" ? "/" : first.path;
    report(`lane journal: dropped invalid record: ${path}`);
    return false;
  }
  try {
    append(LANE_RECORD_TYPE, record);
    return true;
  } catch (cause) {
    if (cause instanceof Error && isStaleContextError(cause)) return false;
    throw cause;
  }
}

/** The custom-entry members the reader looks at (a `SessionEntry` fits). */
interface JournalEntryLike {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

/** Valid lane records among `entries`, in order; other entries and invalid payloads are skipped. */
export function laneRecordsOf(entries: readonly JournalEntryLike[]): LaneRecord[] {
  const records: LaneRecord[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== LANE_RECORD_TYPE) continue;
    const data = entry.data;
    if (isLaneRecord(data)) records.push(data);
  }
  return records;
}

/** The transition identity automatic routes dedupe on. */
export interface LaneTransitionKey {
  readonly route: LaneRoute;
  readonly event: LaneEvent;
  readonly reason: LaneReason;
  readonly checkpointEntryId?: string;
}

/**
 * Per-session memo of transitions already journaled, keyed by route, event,
 * reason and checkpoint id (D4: one record per semantic transition, never per
 * re-evaluation).
 */
export class LaneTransitionMemo {
  private readonly sessions = new Map<string, Set<string>>();

  /** True when the transition was already seen for the session; otherwise records it and returns false. */
  seen(sessionId: string, key: LaneTransitionKey): boolean {
    const id = `${key.route}|${key.event}|${key.reason}|${key.checkpointEntryId ?? ""}`;
    let keys = this.sessions.get(sessionId);
    if (keys === undefined) {
      keys = new Set();
      this.sessions.set(sessionId, keys);
    }
    if (keys.has(id)) return true;
    keys.add(id);
    return false;
  }

  /** Forget a session's transitions (its binding was torn down). */
  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
