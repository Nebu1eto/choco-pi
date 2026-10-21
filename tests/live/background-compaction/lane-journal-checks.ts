/**
 * Lane-journal verdicts shared by the offline harness scenarios and the RPC
 * compaction probe: `choco-compaction-lane` records exist for every observed
 * fallback and cancel, a short run stays below a record budget, every record
 * validates against the package schema, and no record carries
 * credential-looking text.
 */
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import {
  LANE_RECORD_TYPE,
  type LaneEvent,
  type LaneRecord,
  LaneRecordSchema,
} from "../../../.pi/packages/choco-pi-compaction/src/background/lane-journal.ts";

export { LANE_RECORD_TYPE };

/**
 * Credential-looking text (plan: `/Bearer |sk-|xai-|eyJ/`). `sk-` and `xai-`
 * count only at the start of a token, because the package's own codes contain
 * them inside words (`task-budget-remaining`) and `xai-native` is a lane id.
 */
export const CREDENTIAL_TEXT = /Bearer |(?<![A-Za-z0-9])sk-|(?<![A-Za-z0-9])xai-|eyJ/u;
/** A default six-seed-turn probe cell (or one offline scenario) journals fewer records than this. */
export const MAX_LANE_RECORDS = 10;
/** Schema-closed fields (literal unions), never free text. */
const CLOSED_FIELDS: ReadonlySet<string> = new Set([
  "customType",
  "provider",
  "route",
  "event",
  "from",
  "to",
]);

/** A session entry as the RPC `get_entries` answer or a session manager returns it. */
export interface JournalEntry {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

/** The `data` of every lane-journal custom entry, in append order. */
export function laneRecordData(entries: readonly JournalEntry[]): unknown[] {
  return entries.flatMap((entry) =>
    entry.type === "custom" && entry.customType === LANE_RECORD_TYPE ? [entry.data] : [],
  );
}

/** Any object-shaped record, valid or not, so invalid records are scanned too. */
const JournalFieldsSchema = Type.Record(Type.String(), Type.Unknown());
type JournalFields = Static<typeof JournalFieldsSchema>;
const TextSchema = Type.String();

/** Field names of one record whose string value looks like a credential. */
export function credentialFields(record: JournalFields): string[] {
  return Object.entries(record).flatMap(([key, value]) =>
    !CLOSED_FIELDS.has(key) && Value.Check(TextSchema, value) && CREDENTIAL_TEXT.test(value)
      ? [key]
      : [],
  );
}

export interface JournalRequirements {
  /** Observed outcomes: each listed event must have at least one record. */
  readonly events?: readonly LaneEvent[];
  /** Reasons that must each appear on at least one record. */
  readonly reasons?: readonly string[];
  /** Reasons no record may carry. */
  readonly forbiddenReasons?: readonly string[];
  /** Exclusive upper bound on the record count (omit for none). */
  readonly below?: number;
}

export interface JournalSummary {
  readonly count: number;
  /** `event:reason` of every valid record, in order. */
  readonly records: string[];
}

export function summarizeJournal(data: readonly unknown[]): JournalSummary {
  const valid = data.filter((item): item is LaneRecord => Value.Check(LaneRecordSchema, item));
  return { count: data.length, records: valid.map((item) => `${item.event}:${item.reason}`) };
}

/** Every unmet requirement, schema violation and credential-looking field; empty means pass. */
export function journalReasons(
  data: readonly unknown[],
  requirements: JournalRequirements = {},
): string[] {
  const reasons: string[] = [];
  const valid: LaneRecord[] = [];
  data.forEach((item, index) => {
    if (Value.Check(LaneRecordSchema, item)) valid.push(item);
    else reasons.push(`lane record ${index} fails the lane record schema`);
    if (!Value.Check(JournalFieldsSchema, item)) return;
    for (const field of credentialFields(item))
      reasons.push(`lane record ${index} field ${field} looks like a credential`);
  });
  for (const event of requirements.events ?? [])
    if (!valid.some((record) => record.event === event))
      reasons.push(`observed ${event} has no lane record`);
  for (const reason of requirements.reasons ?? [])
    if (!valid.some((record) => record.reason === reason))
      reasons.push(`no lane record with reason ${reason}`);
  for (const reason of requirements.forbiddenReasons ?? [])
    if (valid.some((record) => record.reason === reason))
      reasons.push(`unexpected lane record with reason ${reason}`);
  if (requirements.below !== undefined && data.length >= requirements.below)
    reasons.push(`${data.length} lane records (expected fewer than ${requirements.below})`);
  return reasons;
}
