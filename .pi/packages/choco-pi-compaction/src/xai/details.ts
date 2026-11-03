/**
 * Versioned persistence contract for xAI server-side compaction checkpoints
 * (`xai-responses-compaction-v1`).
 *
 * The compaction item returned by `POST /v1/responses/compact` is opaque
 * provider JSON and is stored exactly as parsed: every returned field is kept,
 * nothing is added, trimmed or normalized. Its `encrypted_content` is only ever
 * persisted in the protected session file through these details and only ever
 * sent back to xAI; diagnostics use {@link itemFingerprint} instead.
 */
import { compile, lit, obj, oneOf } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { sha256 } from "../anthropic/details.ts";
import { BackgroundUsageSchema, jsonRest, withJsonValueDefs } from "../background/contract.ts";
import { jsonEqual } from "../background/json-equal.ts";
import { finiteInt, finiteNum, nonEmptyStr } from "../guards.ts";

export const XAI_STRATEGY = "xai-responses-compaction-v1";
const XAI_DETAILS_SCHEMA_VERSION = 1;

const NonEmptyString = nonEmptyStr();
const Count = finiteInt(0);

/** One opaque compaction item; unknown returned fields stay attached as JSON values. */
const xaiCompactionItem = jsonRest({
  type: lit("compaction"),
  encrypted_content: NonEmptyString,
});
export const XaiCompactionItemSchema = withJsonValueDefs(xaiCompactionItem);
export type XaiCompactionItem = Static<typeof xaiCompactionItem>;
const isXaiCompactionItemFields = compile(XaiCompactionItemSchema).check;

const XaiAuthModeSchema = oneOf(["oauth", "api-key"]);
export type XaiAuthMode = Static<typeof XaiAuthModeSchema>;

/**
 * Coordinator-owned keys may be added at adoption, so the top level accepts
 * additional JSON values; every key owned here is validated strictly.
 */
const XaiDetailsSchema = jsonRest({
  strategy: lit(XAI_STRATEGY),
  schemaVersion: lit(XAI_DETAILS_SCHEMA_VERSION),
  item: xaiCompactionItem,
  /** Response `id` of the compaction call (`cmp_<uuid>`). */
  compactionId: NonEmptyString,
  scope: obj({
    provider: NonEmptyString,
    model: NonEmptyString,
    baseUrl: NonEmptyString,
    authMode: XaiAuthModeSchema,
  }),
  cut: obj({ cutEntryId: NonEmptyString, firstKeptEntryId: NonEmptyString }),
  wire: obj({
    /** Captured input items before the cut (the frozen prefix, instruction item included). */
    prefixLength: finiteInt(1),
    /** Input items of the captured request the prefix came from. */
    capturedLength: finiteInt(1),
    /** Items actually sent to the compact endpoint (the prefix without its leading instruction). */
    compactedItems: finiteInt(1),
    /** sha256 of the compacted input JSON: binds the item to exactly what was sent. */
    prefixDigest: NonEmptyString,
    /** sha256 of the captured leading instruction item JSON (null when absent). */
    instructionDigest: NonEmptyString,
    /** Wire keys in the summarized prefix that no branch entry produced. */
    unmappedPrefixKeys: Count,
  }),
  droppedMessageCount: Count,
  laneUsage: BackgroundUsageSchema,
  preparedAt: finiteNum({ minimum: 0 }),
});
export type XaiDetails = Static<typeof XaiDetailsSchema>;
const isXaiDetailsFields = compile(withJsonValueDefs(XaiDetailsSchema)).check;

/** Structural check plus the cross-field invariants the schema cannot express. */
export function isXaiDetails<T>(value: T): value is T & XaiDetails {
  return (
    isXaiDetailsFields(value) &&
    value.cut.cutEntryId !== value.cut.firstKeptEntryId &&
    value.wire.prefixLength <= value.wire.capturedLength &&
    value.wire.compactedItems <= value.wire.prefixLength
  );
}

export function isXaiCompactionItem<T>(value: T): value is T & XaiCompactionItem {
  return isXaiCompactionItemFields(value);
}

/** Exactness check: structural equality plus the exact encrypted content string. */
export function sameItem(left: XaiCompactionItem, right: XaiCompactionItem): boolean {
  return jsonEqual(left, right) && left.encrypted_content === right.encrypted_content;
}

/** Non-secret identity for diagnostics: digest prefix and length, never the content. */
export function itemFingerprint(item: XaiCompactionItem): string {
  return `${sha256(item.encrypted_content).slice(0, 16)}:${item.encrypted_content.length}`;
}

/**
 * The checkpoint's model-visible summary. The encrypted record is never
 * model-visible text; this neutral line is what the host shows and what the
 * model would see if the item could not be replayed.
 */
export function placeholderSummary(compactedItems: number): string {
  const noun = compactedItems === 1 ? "item" : "items";
  return `xAI server-side compaction checkpoint (${compactedItems} earlier conversation ${noun} compacted). The compacted record is opaque and only xAI can replay it; when it is not replayed, that earlier history is unavailable.`;
}
