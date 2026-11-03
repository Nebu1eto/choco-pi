import { isBoolean, isNumber, isString } from "../../value-guards.ts";
import { conditionalProperties } from "../runtime-values.ts";
import { jsonValueType, isJsonObject } from "../runtime-values.ts";
import type { JsonObject, BoundaryValue } from "../runtime-values.ts";
import { compile, int, lit, obj, opt, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import type { CompactionEntry, CompactionResult } from "@earendil-works/pi-coding-agent";
import { isCodexCompactionDiagnostic, type CodexCompactionDiagnostic } from "./diagnostics.ts";

const LEGACY_NATIVE_COMPACTION_STRATEGY = "openai-native-compact-v1";
export const NATIVE_COMPACTION_STRATEGY = "openai-responses-compaction-v2";
export const NATIVE_COMPACTION_SHIM_SUMMARY = "[OpenAI native compaction checkpoint]";
export const NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE = "codex-native-compaction-display";
export const NATIVE_COMPACTION_DISPLAY_TEXT = [
  "Codex native compaction was used for this checkpoint.",
  "",
  "The compaction result is encrypted by OpenAI and is not human-readable in Pi.",
  "",
  "Warning: do not turn Responses compaction off or switch providers mid-session; old context may be much less reliable.",
].join("\n");

export type NativeCompactionDisplayEntry = {
  content: string;
  compactionEntryId: string;
  kind?: "usage" | undefined;
};

export type NativeCompactionStrategy = typeof NATIVE_COMPACTION_STRATEGY;
type PersistedNativeCompactionStrategy =
  | NativeCompactionStrategy
  | typeof LEGACY_NATIVE_COMPACTION_STRATEGY;
export type NativeCompactionRequestMeta = {
  tokensBefore?: number | undefined;
  previousSummaryPresent?: boolean | undefined;
  compactedKeptWindow?: boolean | undefined;
};

export type NativeCompactionUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  diagnostic?: CodexCompactionDiagnostic | undefined;
};

export type NativeCompactionIdentity = {
  provider: string;
  api: string;
  model: string;
  baseUrl: string;
};

/** Closed objects: unknown keys are rejected, as with the former `additionalProperties: false`. */
export const BackgroundNativeMetadataSchema = obj({
  sessionId: str({ minLength: 1 }),
  ownerKey: str({ minLength: 1 }),
  ownerGeneration: int({ minimum: 0 }),
  cutEntryId: str({ minLength: 1 }),
  retentionPolicyVersion: lit(1),
  providerScope: obj({
    provider: str({ minLength: 1 }),
    baseUrl: opt(str({ minLength: 1 })),
    model: str({ minLength: 1 }),
    authMode: opt(str({ minLength: 1 })),
    accountScope: opt(str({ minLength: 1 })),
  }),
});
const isBackgroundNativeMetadata = compile(BackgroundNativeMetadataSchema).check;
export type BackgroundNativeMetadata = Static<typeof BackgroundNativeMetadataSchema>;

export type BackgroundNativeCompactionDetails = NativeCompactionDetails & {
  compactedWindow: JsonObject[];
  schemaVersion: 1;
  candidateId: string;
  prefixFingerprint: string;
  background: BackgroundNativeMetadata;
};

export type NativeCompactionDetails = NativeCompactionIdentity & {
  schemaVersion?: 1 | undefined;
  candidateId?: string | undefined;
  prefixFingerprint?: string | undefined;
  background?: BackgroundNativeMetadata | undefined;
  strategy: PersistedNativeCompactionStrategy;
  compactedWindow: BoundaryValue[];
  compactResponseId?: string | undefined;
  createdAt: string;
  requestMeta?: NativeCompactionRequestMeta | undefined;
  usage?: NativeCompactionUsage | undefined;
};

export type NativeCompactionEntry = CompactionEntry<NativeCompactionDetails>;

export type CreateNativeCompactionDetailsInput = NativeCompactionIdentity & {
  compactedWindow: BoundaryValue[];
  compactResponseId?: string | undefined;
  createdAt?: string | undefined;
  requestMeta?: NativeCompactionRequestMeta | undefined;
  usage?: NativeCompactionUsage | undefined;
};

export type CreateNativeCompactionShimResultInput = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: NativeCompactionDetails;
};

function isRecord(value: BoundaryValue): value is JsonObject {
  return isJsonObject(value);
}

function isNonEmptyString(value: BoundaryValue): value is string {
  return isString(value) && value.trim().length > 0;
}

function isFiniteNonNegativeNumber(value: BoundaryValue): value is number {
  return isNumber(value) && Number.isFinite(value) && value >= 0;
}

function normalizeString(value: string): string {
  return value.trim();
}

function isStructuredValue(value: BoundaryValue): boolean {
  if (value === null || isString(value) || isNumber(value) || isBoolean(value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isStructuredValue);
  }

  if (isRecord(value)) {
    return Object.values(value).every(isStructuredValue);
  }

  return false;
}

function cloneStructuredValue(value: BoundaryValue): BoundaryValue {
  if (value === null || isString(value) || isNumber(value) || isBoolean(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(cloneStructuredValue);
  }

  if (isRecord(value)) {
    const clone: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      clone[key] = cloneStructuredValue(nested);
    }
    return clone;
  }

  throw new Error(`Unsupported structured value: ${jsonValueType(value)}`);
}

function isCompactedWindowItem(value: BoundaryValue): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isStructuredValue);
}

export function isNativeCompactionRequestMeta(
  value: BoundaryValue,
): value is NativeCompactionRequestMeta {
  if (!isRecord(value)) {
    return false;
  }

  const { tokensBefore, previousSummaryPresent, compactedKeptWindow } = value;
  if (tokensBefore !== undefined && !isFiniteNonNegativeNumber(tokensBefore)) {
    return false;
  }

  if (previousSummaryPresent !== undefined && !isBoolean(previousSummaryPresent)) {
    return false;
  }

  if (compactedKeptWindow !== undefined && !isBoolean(compactedKeptWindow)) {
    return false;
  }

  return true;
}

export function isNativeCompactionUsage(value: BoundaryValue): value is NativeCompactionUsage {
  if (!isRecord(value)) return false;
  return (
    [
      value["inputTokens"],
      value["cachedInputTokens"],
      value["cacheWriteInputTokens"],
      value["outputTokens"],
    ].every(isFiniteNonNegativeNumber) &&
    (value["diagnostic"] === undefined || isCodexCompactionDiagnostic(value["diagnostic"]))
  );
}

export function isNativeCompactionDetails(value: BoundaryValue): value is NativeCompactionDetails {
  if (!isRecord(value)) {
    return false;
  }
  const candidate = value;

  return (
    (candidate["strategy"] === NATIVE_COMPACTION_STRATEGY ||
      candidate["strategy"] === LEGACY_NATIVE_COMPACTION_STRATEGY) &&
    isNonEmptyString(candidate["provider"]) &&
    isNonEmptyString(candidate["api"]) &&
    isNonEmptyString(candidate["model"]) &&
    isNonEmptyString(candidate["baseUrl"]) &&
    Array.isArray(candidate["compactedWindow"]) &&
    candidate["compactedWindow"].every(isCompactedWindowItem) &&
    isNonEmptyString(candidate["createdAt"]) &&
    (candidate["compactResponseId"] === undefined ||
      isNonEmptyString(candidate["compactResponseId"])) &&
    (candidate["requestMeta"] === undefined ||
      isNativeCompactionRequestMeta(candidate["requestMeta"])) &&
    (candidate["usage"] === undefined || isNativeCompactionUsage(candidate["usage"])) &&
    (candidate["schemaVersion"] === undefined || candidate["schemaVersion"] === 1) &&
    (candidate["candidateId"] === undefined || isNonEmptyString(candidate["candidateId"])) &&
    (candidate["prefixFingerprint"] === undefined ||
      isNonEmptyString(candidate["prefixFingerprint"])) &&
    (candidate["background"] === undefined || isBackgroundNativeMetadata(candidate["background"]))
  );
}

export function isNativeCompactionEntry(value: BoundaryValue): value is NativeCompactionEntry {
  return (
    isRecord(value) && value["type"] === "compaction" && isNativeCompactionDetails(value["details"])
  );
}

export function createNativeCompactionDetails(
  input: CreateNativeCompactionDetailsInput,
): NativeCompactionDetails {
  return {
    strategy: NATIVE_COMPACTION_STRATEGY,
    provider: normalizeString(input.provider),
    api: normalizeString(input.api),
    model: normalizeString(input.model),
    baseUrl: normalizeString(input.baseUrl),
    compactedWindow: input.compactedWindow.map((item) => cloneStructuredValue(item)),
    compactResponseId: isNonEmptyString(input.compactResponseId)
      ? normalizeString(input.compactResponseId)
      : undefined,
    createdAt: isNonEmptyString(input.createdAt)
      ? normalizeString(input.createdAt)
      : new Date().toISOString(),
    requestMeta: input.requestMeta
      ? {
          ...conditionalProperties(Boolean(input.requestMeta.tokensBefore !== undefined), {
            tokensBefore: input.requestMeta.tokensBefore,
          }),
          ...conditionalProperties(
            Boolean(input.requestMeta.previousSummaryPresent !== undefined),
            { previousSummaryPresent: input.requestMeta.previousSummaryPresent },
          ),
          ...conditionalProperties(Boolean(input.requestMeta.compactedKeptWindow !== undefined), {
            compactedKeptWindow: input.requestMeta.compactedKeptWindow,
          }),
        }
      : undefined,
    usage: input.usage ? { ...input.usage } : undefined,
  };
}

export function createNativeCompactionShimResult(
  input: CreateNativeCompactionShimResultInput,
): CompactionResult<NativeCompactionDetails> {
  return {
    summary: input.summary,
    firstKeptEntryId: input.firstKeptEntryId,
    tokensBefore: input.tokensBefore,
    details: input.details,
  };
}
