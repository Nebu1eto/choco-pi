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
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { sha256 } from "../anthropic/details.ts";
import { BackgroundUsageSchema, JsonValueSchema } from "../background/contract.ts";

export const XAI_STRATEGY = "xai-responses-compaction-v1";
const XAI_DETAILS_SCHEMA_VERSION = 1;

const NonEmptyString = Type.String({ minLength: 1 });
const Count = Type.Integer({ minimum: 0 });
const Strict = { additionalProperties: false };

/** One opaque compaction item; unknown returned fields stay attached as JSON values. */
export const XaiCompactionItemSchema = Type.Object(
  {
    type: Type.Literal("compaction"),
    encrypted_content: NonEmptyString,
  },
  { additionalProperties: JsonValueSchema },
);
export type XaiCompactionItem = Static<typeof XaiCompactionItemSchema>;

const XaiAuthModeSchema = Type.Union([Type.Literal("oauth"), Type.Literal("api-key")]);
export type XaiAuthMode = Static<typeof XaiAuthModeSchema>;

/**
 * Coordinator-owned keys may be added at adoption, so the top level accepts
 * additional JSON values; every key owned here is validated strictly.
 */
const XaiDetailsSchema = Type.Object(
  {
    strategy: Type.Literal(XAI_STRATEGY),
    schemaVersion: Type.Literal(XAI_DETAILS_SCHEMA_VERSION),
    item: XaiCompactionItemSchema,
    /** Response `id` of the compaction call (`cmp_<uuid>`). */
    compactionId: NonEmptyString,
    scope: Type.Object(
      {
        provider: NonEmptyString,
        model: NonEmptyString,
        baseUrl: NonEmptyString,
        authMode: XaiAuthModeSchema,
      },
      Strict,
    ),
    cut: Type.Object({ cutEntryId: NonEmptyString, firstKeptEntryId: NonEmptyString }, Strict),
    wire: Type.Object(
      {
        /** Captured input items before the cut (the frozen prefix, instruction item included). */
        prefixLength: Type.Integer({ minimum: 1 }),
        /** Input items of the captured request the prefix came from. */
        capturedLength: Type.Integer({ minimum: 1 }),
        /** Items actually sent to the compact endpoint (the prefix without its leading instruction). */
        compactedItems: Type.Integer({ minimum: 1 }),
        /** sha256 of the compacted input JSON: binds the item to exactly what was sent. */
        prefixDigest: NonEmptyString,
        /** sha256 of the captured leading instruction item JSON (null when absent). */
        instructionDigest: NonEmptyString,
        /** Wire keys in the summarized prefix that no branch entry produced. */
        unmappedPrefixKeys: Count,
      },
      Strict,
    ),
    droppedMessageCount: Count,
    laneUsage: BackgroundUsageSchema,
    preparedAt: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: JsonValueSchema },
);
export type XaiDetails = Static<typeof XaiDetailsSchema>;

/** Structural check plus the cross-field invariants the schema cannot express. */
export function isXaiDetails<T>(value: T): value is T & XaiDetails {
  return (
    Value.Check(XaiDetailsSchema, value) &&
    value.cut.cutEntryId !== value.cut.firstKeptEntryId &&
    value.wire.prefixLength <= value.wire.capturedLength &&
    value.wire.compactedItems <= value.wire.prefixLength
  );
}

export function isXaiCompactionItem<T>(value: T): value is T & XaiCompactionItem {
  return Value.Check(XaiCompactionItemSchema, value);
}

/** Exactness check: structural equality plus the exact encrypted content string. */
export function sameItem(left: XaiCompactionItem, right: XaiCompactionItem): boolean {
  return Value.Equal(left, right) && left.encrypted_content === right.encrypted_content;
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
