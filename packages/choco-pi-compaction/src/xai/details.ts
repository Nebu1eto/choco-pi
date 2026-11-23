import { compile, lit, obj, oneOf } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { opaqueFingerprint } from "../shared/details.ts";
import { BackgroundUsageSchema, jsonRest, withJsonValueDefs } from "../background/contract.ts";
import { jsonEqual } from "../background/json-equal.ts";
import { finiteInt, finiteNum, nonEmptyStr } from "../guards.ts";

export const XAI_STRATEGY = "xai-responses-compaction-v1";
const XAI_DETAILS_SCHEMA_VERSION = 1;

const NonEmptyString = nonEmptyStr();
const Count = finiteInt(0);

const xaiCompactionItem = jsonRest({
  type: lit("compaction"),
  encrypted_content: NonEmptyString,
});
export const XaiCompactionItemSchema = withJsonValueDefs(xaiCompactionItem);
export type XaiCompactionItem = Static<typeof xaiCompactionItem>;
const isXaiCompactionItemFields = compile(XaiCompactionItemSchema).check;

const XaiAuthModeSchema = oneOf(["oauth", "api-key"]);
export type XaiAuthMode = Static<typeof XaiAuthModeSchema>;

const XaiDetailsSchema = jsonRest({
  strategy: lit(XAI_STRATEGY),
  schemaVersion: lit(XAI_DETAILS_SCHEMA_VERSION),
  item: xaiCompactionItem,
  compactionId: NonEmptyString,
  scope: obj({
    provider: NonEmptyString,
    model: NonEmptyString,
    baseUrl: NonEmptyString,
    authMode: XaiAuthModeSchema,
  }),
  cut: obj({ cutEntryId: NonEmptyString, firstKeptEntryId: NonEmptyString }),
  wire: obj({
    prefixLength: finiteInt(1),
    capturedLength: finiteInt(1),
    compactedItems: finiteInt(1),
    prefixDigest: NonEmptyString,
    instructionDigest: NonEmptyString,
    unmappedPrefixKeys: Count,
  }),
  droppedMessageCount: Count,
  laneUsage: BackgroundUsageSchema,
  preparedAt: finiteNum({ minimum: 0 }),
});
export type XaiDetails = Static<typeof XaiDetailsSchema>;
const isXaiDetailsFields = compile(withJsonValueDefs(XaiDetailsSchema)).check;

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

export function sameItem(left: XaiCompactionItem, right: XaiCompactionItem): boolean {
  return jsonEqual(left, right) && left.encrypted_content === right.encrypted_content;
}

export function itemFingerprint(item: XaiCompactionItem): string {
  return opaqueFingerprint(item.encrypted_content);
}

export function placeholderSummary(compactedItems: number): string {
  const noun = compactedItems === 1 ? "item" : "items";
  return `xAI server-side compaction checkpoint (${compactedItems} earlier conversation ${noun} compacted). The compacted record is opaque and only xAI can replay it; when it is not replayed, that earlier history is unavailable.`;
}
