import { str } from "@earendil-works/pi-schema";
import type { JsonRecord, RuntimeValue } from "../../../profile/extensions/lib/runtime-values.ts";
import { isRecord, matches } from "./schema-check.ts";

import {
  isOwnedReason,
  LANE_RECORD_TYPE,
  type LaneEvent,
  type LaneRecord,
  LaneRecordSchema,
} from "../../../packages/choco-pi-compaction/src/background/lane-journal.ts";

export { LANE_RECORD_TYPE };

export const CREDENTIAL_TEXT = /Bearer |sk-|xai-|eyJ/u;
export const MAX_LANE_RECORDS = 10;
const LANE_FIELDS = LaneRecordSchema.properties;
const CLOSED_FIELDS: ReadonlyMap<string, object> = new Map<string, object>([
  ["customType", LANE_FIELDS.customType],
  ["provider", LANE_FIELDS.provider],
  ["route", LANE_FIELDS.route],
  ["event", LANE_FIELDS.event],
  ["from", LANE_FIELDS.from],
  ["to", LANE_FIELDS.to],
  ["reason", LANE_FIELDS.reason],
]);

export function isOwnedCode(text: string): boolean {
  return isOwnedReason(text) || matches(LANE_FIELDS.from, text);
}

const CODE_TOKEN = /[A-Za-z0-9-]+/gu;

export function credentialLike(text: string): boolean {
  const residue = text.replace(CODE_TOKEN, (token) => (isOwnedCode(token) ? " " : token));
  return CREDENTIAL_TEXT.test(residue);
}

export function credentialNotices(texts: readonly string[]): string[] {
  return texts.flatMap((text, index) =>
    credentialLike(text) ? [`notice ${index} looks like a credential`] : [],
  );
}

export interface JournalEntry {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

export function laneRecordData(entries: readonly JournalEntry[]): unknown[] {
  return entries.flatMap((entry) =>
    entry.type === "custom" && entry.customType === LANE_RECORD_TYPE ? [entry.data] : [],
  );
}

type JournalFields = JsonRecord;
const TextSchema = str();

export function credentialFields(record: JournalFields): string[] {
  return Object.entries(record).flatMap(([key, value]) => {
    if (!matches(TextSchema, value)) return [];
    const closed = CLOSED_FIELDS.get(key);
    if (closed !== undefined && matches(closed, value)) return [];
    if (isOwnedCode(value)) return [];
    return CREDENTIAL_TEXT.test(value) ? [key] : [];
  });
}

export interface JournalRequirements {
  readonly events?: readonly LaneEvent[];
  readonly reasons?: readonly string[];
  readonly forbiddenReasons?: readonly string[];
  readonly below?: number;
}

export interface JournalSummary {
  readonly count: number;
  readonly records: string[];
}

export function summarizeJournal(data: readonly unknown[]): JournalSummary {
  return {
    count: data.length,
    records: validRecords(data).map((item) => `${item.event}:${item.reason}`),
  };
}

function isLaneRecord(item: RuntimeValue): item is LaneRecord {
  return matches(LaneRecordSchema, item);
}

export function validRecords(data: readonly unknown[]): LaneRecord[] {
  return data.filter(isLaneRecord);
}

function tally(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function shortfall(
  required: number,
  recorded: number,
  none: string,
  some: string,
): string | undefined {
  if (recorded >= required) return undefined;
  return required === 1 ? none : `${some}: ${required} required, ${recorded} recorded`;
}

export function journalReasons(
  data: readonly unknown[],
  requirements: JournalRequirements = {},
): string[] {
  const reasons: string[] = [];
  const valid: LaneRecord[] = [];
  data.forEach((item, index) => {
    if (isLaneRecord(item)) valid.push(item);
    else reasons.push(`lane record ${index} fails the lane record schema`);
    if (!isRecord(item)) return;
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
