/**
 * Versioned persistence contract for Anthropic native on-demand compaction
 * checkpoints (`anthropic-compaction-on-demand-v1`).
 *
 * The returned `compaction` block is opaque provider JSON. It is stored exactly
 * as parsed from the provider stream: every returned field (including unknown
 * ones) is preserved, nothing is added, trimmed, or normalized. Its signature is
 * only ever persisted in the protected session file through these details;
 * diagnostics use `blockFingerprint` instead.
 */
import { createHash } from "node:crypto";

import { arr, bool, compile, lit, obj, oneOf } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { BackgroundUsageSchema, jsonRest, withJsonValueDefs } from "../background/contract.ts";
import { jsonEqual } from "../background/json-equal.ts";
import { finiteInt, finiteNum, nonEmptyStr } from "../guards.ts";

export const ANTHROPIC_STRATEGY = "anthropic-compaction-on-demand-v1";
const ANTHROPIC_DETAILS_SCHEMA_VERSION = 1;
/** Required on the compaction request and on every request that carries the block. */
export const COMPACT_BETA = "compact-2026-09-04";

const NonEmptyString = nonEmptyStr();
const Count = finiteInt(0);

/** A signed provider block; unknown returned fields stay attached as JSON values. */
const CompactionBlockSchema = jsonRest({
  type: lit("compaction"),
  content: NonEmptyString,
  signature: NonEmptyString,
});
export type CompactionBlock = Static<typeof CompactionBlockSchema>;
const isCompactionBlockFields = compile(withJsonValueDefs(CompactionBlockSchema)).check;

const AnthropicAuthModeSchema = oneOf(["oauth", "api-key"]);
export type AnthropicAuthMode = Static<typeof AnthropicAuthModeSchema>;

const AnthropicScopeSchema = obj({
  provider: NonEmptyString,
  model: NonEmptyString,
  baseUrl: NonEmptyString,
  authMode: AnthropicAuthModeSchema,
});

/**
 * Coordinator-owned keys (candidate ID, fingerprint, owner) may be added at
 * adoption, so the top level accepts additional JSON values; every key owned
 * here is validated strictly.
 */
const AnthropicDetailsSchema = jsonRest({
  strategy: lit(ANTHROPIC_STRATEGY),
  schemaVersion: lit(ANTHROPIC_DETAILS_SCHEMA_VERSION),
  block: CompactionBlockSchema,
  scope: AnthropicScopeSchema,
  /** Betas sent on the compaction request; always contains COMPACT_BETA. */
  betas: arr(NonEmptyString, { minItems: 1 }),
  cut: obj({ cutEntryId: NonEmptyString, firstKeptEntryId: NonEmptyString }),
  wire: obj({
    /** Number of captured wire messages summarized (the frozen prefix). */
    prefixLength: finiteInt(1),
    /** Number of messages in the captured request the prefix came from. */
    capturedLength: finiteInt(1),
    /** Whether captured kept messages carry thinking bound to `system`/`tools`. */
    keptThinking: bool(),
    /** sha256 of the captured `system` and non-deferred `tools` JSON. */
    systemDigest: NonEmptyString,
    toolsDigest: NonEmptyString,
    /** Wire keys in the summarized prefix that no branch entry produced. */
    unmappedPrefixKeys: Count,
  }),
  laneUsage: BackgroundUsageSchema,
  stopReason: lit("compaction"),
  preparedAt: finiteNum({ minimum: 0 }),
});
export type AnthropicDetails = Static<typeof AnthropicDetailsSchema>;
const isAnthropicDetailsFields = compile(withJsonValueDefs(AnthropicDetailsSchema)).check;

/** Structural check plus the cross-field invariants the schema cannot express. */
export function isAnthropicDetails<T>(value: T): value is T & AnthropicDetails {
  return (
    isAnthropicDetailsFields(value) &&
    value.betas.includes(COMPACT_BETA) &&
    value.cut.cutEntryId !== value.cut.firstKeptEntryId &&
    value.wire.prefixLength <= value.wire.capturedLength
  );
}

export function isCompactionBlock<T>(value: T): value is T & CompactionBlock {
  return isCompactionBlockFields(value);
}

/** Exactness check: structural equality plus exact content and signature strings. */
export function sameBlock(left: CompactionBlock, right: CompactionBlock): boolean {
  return (
    jsonEqual(left, right) && left.content === right.content && left.signature === right.signature
  );
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Non-secret identity for diagnostics: digest prefix and length, never the signature. */
export function blockFingerprint(block: CompactionBlock): string {
  return `${sha256(block.signature).slice(0, 16)}:${block.signature.length}`;
}
