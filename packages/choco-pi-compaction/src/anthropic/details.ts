import { arr, bool, compile, lit, obj, oneOf } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { BackgroundUsageSchema, jsonRest, withJsonValueDefs } from "../background/contract.ts";
import { jsonEqual } from "../background/json-equal.ts";
import { finiteInt, finiteNum, nonEmptyStr } from "../guards.ts";
import { opaqueFingerprint } from "../shared/details.ts";

export { sha256 } from "../shared/details.ts";

export const ANTHROPIC_STRATEGY = "anthropic-compaction-on-demand-v1";
const ANTHROPIC_DETAILS_SCHEMA_VERSION = 1;
export const COMPACT_BETA = "compact-2026-09-04";

const NonEmptyString = nonEmptyStr();
const Count = finiteInt(0);

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

const AnthropicDetailsSchema = jsonRest({
  strategy: lit(ANTHROPIC_STRATEGY),
  schemaVersion: lit(ANTHROPIC_DETAILS_SCHEMA_VERSION),
  block: CompactionBlockSchema,
  scope: AnthropicScopeSchema,
  betas: arr(NonEmptyString, { minItems: 1 }),
  cut: obj({ cutEntryId: NonEmptyString, firstKeptEntryId: NonEmptyString }),
  wire: obj({
    prefixLength: finiteInt(1),
    capturedLength: finiteInt(1),
    keptThinking: bool(),
    systemDigest: NonEmptyString,
    toolsDigest: NonEmptyString,
    unmappedPrefixKeys: Count,
  }),
  laneUsage: BackgroundUsageSchema,
  stopReason: lit("compaction"),
  preparedAt: finiteNum({ minimum: 0 }),
});
export type AnthropicDetails = Static<typeof AnthropicDetailsSchema>;
const isAnthropicDetailsFields = compile(withJsonValueDefs(AnthropicDetailsSchema)).check;

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

export function sameBlock(left: CompactionBlock, right: CompactionBlock): boolean {
  return (
    jsonEqual(left, right) && left.content === right.content && left.signature === right.signature
  );
}

export function blockFingerprint(block: CompactionBlock): string {
  return opaqueFingerprint(block.signature);
}
