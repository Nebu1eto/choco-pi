/**
 * Lane-journal verdicts shared by the offline harness scenarios and the RPC
 * compaction probe: at least as many `choco-compaction-lane` records as
 * observed fallbacks and cancels (per event), a short run stays below a record
 * budget, every record validates against the package schema, and no record
 * (or shown notice) carries credential-looking text.
 */
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import {
  isOwnedReason,
  LANE_RECORD_TYPE,
  type LaneEvent,
  type LaneRecord,
  LaneRecordSchema,
} from "../../../.pi/packages/choco-pi-compaction/src/background/lane-journal.ts";

export { LANE_RECORD_TYPE };

/**
 * Credential-looking text, exactly the plan's `/Bearer |sk-|xai-|eyJ/`. The
 * package's own codes contain some of these (`task-budget-remaining`, the
 * lane id `xai-native`); they are exempted by equality ({@link isOwnedCode}),
 * never by weakening this pattern.
 */
export const CREDENTIAL_TEXT = /Bearer |sk-|xai-|eyJ/u;
/** A default six-seed-turn probe cell (or one offline scenario) journals fewer records than this. */
export const MAX_LANE_RECORDS = 10;
const LANE_FIELDS = LaneRecordSchema.properties;
/**
 * Closed-vocabulary fields and their package schemas (literal unions, the
 * owned-code enum). A value there is exempt only when it validates against
 * its field's schema; any other value is scanned like free text.
 */
const CLOSED_FIELDS: ReadonlyMap<string, TSchema> = new Map<string, TSchema>([
  ["customType", LANE_FIELDS.customType],
  ["provider", LANE_FIELDS.provider],
  ["route", LANE_FIELDS.route],
  ["event", LANE_FIELDS.event],
  ["from", LANE_FIELDS.from],
  ["to", LANE_FIELDS.to],
  ["reason", LANE_FIELDS.reason],
]);

/** Exactly one of the package's own codes (REASONS) or lane ids; equality, not a pattern. */
export function isOwnedCode(text: string): boolean {
  return isOwnedReason(text) || Value.Check(LANE_FIELDS.from, text);
}

/** Maximal code-like tokens of free text (owned codes are lowercase words joined by `-`). */
const CODE_TOKEN = /[A-Za-z0-9-]+/gu;

/**
 * Whether free text (a notice) looks like it carries a credential: the plain
 * {@link CREDENTIAL_TEXT} over the text with every token that equals an owned
 * code blanked out. A token merely containing a code (`requestxai-0123`) stays.
 */
export function credentialLike(text: string): boolean {
  const residue = text.replace(CODE_TOKEN, (token) => (isOwnedCode(token) ? " " : token));
  return CREDENTIAL_TEXT.test(residue);
}

/** `notice <index> looks like a credential` for each such text (the text itself is never echoed). */
export function credentialNotices(texts: readonly string[]): string[] {
  return texts.flatMap((text, index) =>
    credentialLike(text) ? [`notice ${index} looks like a credential`] : [],
  );
}

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
  return Object.entries(record).flatMap(([key, value]) => {
    if (!Value.Check(TextSchema, value)) return [];
    const closed = CLOSED_FIELDS.get(key);
    if (closed !== undefined && Value.Check(closed, value)) return [];
    if (isOwnedCode(value)) return [];
    return CREDENTIAL_TEXT.test(value) ? [key] : [];
  });
}

export interface JournalRequirements {
  /**
   * Observed outcomes, one entry per observation: each event needs at least
   * as many records as it appears here (`[fallback, fallback]` needs two).
   */
  readonly events?: readonly LaneEvent[];
  /** Required reasons, counted the same way (a reason listed twice needs two records). */
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
  return {
    count: data.length,
    records: validRecords(data).map((item) => `${item.event}:${item.reason}`),
  };
}

/** The schema-valid lane records of `data`, in order. */
export function validRecords(data: readonly unknown[]): LaneRecord[] {
  return data.filter((item): item is LaneRecord => Value.Check(LaneRecordSchema, item));
}

/** Occurrences of each distinct value, in first-seen order. */
function tally(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** The shortfall message of `required` observations against `recorded` records, or undefined. */
function shortfall(
  required: number,
  recorded: number,
  none: string,
  some: string,
): string | undefined {
  if (recorded >= required) return undefined;
  return required === 1 ? none : `${some}: ${required} required, ${recorded} recorded`;
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
  for (const [event, required] of tally(requirements.events ?? [])) {
    const recorded = valid.filter((record) => record.event === event).length;
    const problem = shortfall(
      required,
      recorded,
      `observed ${event} has no lane record`,
      `observed ${event} outnumbers its lane records`,
    );
    if (problem !== undefined) reasons.push(problem);
  }
  for (const [reason, required] of tally(requirements.reasons ?? [])) {
    const recorded = valid.filter((record) => record.reason === reason).length;
    const problem = shortfall(
      required,
      recorded,
      `no lane record with reason ${reason}`,
      `too few lane records with reason ${reason}`,
    );
    if (problem !== undefined) reasons.push(problem);
  }
  for (const reason of requirements.forbiddenReasons ?? [])
    if (valid.some((record) => record.reason === reason))
      reasons.push(`unexpected lane record with reason ${reason}`);
  if (requirements.below !== undefined && data.length >= requirements.below)
    reasons.push(`${data.length} lane records (expected fewer than ${requirements.below})`);
  return reasons;
}
