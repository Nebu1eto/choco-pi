import { bool, compile, lit, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { finiteInt, nonEmptyStr, nonNegative } from "../guards.ts";
import { isStaleContextError } from "@choco-pi/shared/lifecycle";
import { LANE_RECORD_TYPE as LANE_ENTRY_TYPE } from "./entry-types.ts";
import { CompactionTriggerSchema } from "../trigger.ts";

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
  "suppressed",
]);
export type LaneEvent = Static<typeof LaneEventSchema>;

const LaneProviderSchema = oneOf(["anthropic", "xai", "codex"]);
export type LaneProvider = Static<typeof LaneProviderSchema>;

export const REASONS = {
  noCapture: "no-capture",
  noUsableCapture: "no-usable-capture",
  opaqueCheckpoint: "opaque-checkpoint",
  scopeMismatch: "scope-mismatch",
  auth: "auth",
  authTransient: "auth-transient",
  cooldown: "cooldown",
  incompatible: "incompatible",
  noLegalCut: "no-legal-cut",
  unsupported: "unsupported",
  notAdmitted: "not-admitted",
  modeOff: "mode-off",
  instructionsIgnored: "instructions-ignored",
  instructionsForwarded: "instructions-forwarded",
  overflow: "overflow",
  branchSwitch: "branch-switch",
  providerError: "provider-error",
  transportRefused: "transport-refused",
  unverifiable: "unverifiable",
  consent: "consent",
  loss: "loss",

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

  oauthExtraUsage: "oauth-extra-usage",
  provider400: "provider-400",
  provider422: "provider-422",

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
  cutNotOnBranch: "cut-not-on-branch",
  cutNotReproducible: "cut-not-reproducible",
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

export type LaneReason = (typeof REASONS)[keyof typeof REASONS];

const OWNED_REASONS: readonly LaneReason[] = Object.values(REASONS);
const OWNED_REASON_SET: ReadonlySet<string> = new Set(OWNED_REASONS);

export function isOwnedReason(candidate: string): candidate is LaneReason {
  return OWNED_REASON_SET.has(candidate);
}

export function ownedReasonOf(candidate: string): LaneReason {
  return isOwnedReason(candidate) ? candidate : REASONS.providerError;
}

const LaneReasonSchema = oneOf(OWNED_REASONS);

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
  reason: LaneReasonSchema,
  detail: str({ maxLength: 128 }),
  candidateId: NonEmptyString,
  checkpointEntryId: NonEmptyString,
  cooldownUntil: nonNegative(),
  trigger: CompactionTriggerSchema,
  attempt: finiteInt(1),
  cutFingerprint: NonEmptyString,
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

export type LaneRecordInput = Omit<LaneRecord, "customType" | "schemaVersion">;

export type LaneAppend = (customType: string, data: LaneRecord) => void;

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

interface JournalEntryLike {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

export function laneRecordsOf(entries: readonly JournalEntryLike[]): LaneRecord[] {
  const records: LaneRecord[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== LANE_RECORD_TYPE) continue;
    const data = entry.data;
    if (isLaneRecord(data)) records.push(data);
  }
  return records;
}

export interface LaneTransitionKey {
  readonly route: LaneRoute;
  readonly event: LaneEvent;
  readonly reason: LaneReason;
  readonly checkpointEntryId?: string;
}

export class LaneTransitionMemo {
  private readonly sessions = new Map<string, Set<string>>();

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

  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
