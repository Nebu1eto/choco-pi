import { conditionalProperties } from "../runtime-values.ts";
import { jsonValueType, JsonObjectSchema } from "../runtime-values.ts";
import type { JsonObject, BoundaryValue } from "../runtime-values.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
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

export type NativeCompactionDetails = NativeCompactionIdentity & {
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
  return Value.Check(JsonObjectSchema, value);
}

function isNonEmptyString(value: BoundaryValue): value is string {
  return Value.Check(Type.String(), value) && value.trim().length > 0;
}

function isFiniteNonNegativeNumber(value: BoundaryValue): value is number {
  return Value.Check(Type.Number(), value) && Number.isFinite(value) && value >= 0;
}

function normalizeString(value: string): string {
  return value.trim();
}

function isStructuredValue(value: BoundaryValue): boolean {
  if (
    value === null ||
    Value.Check(Type.String(), value) ||
    Value.Check(Type.Number(), value) ||
    Value.Check(Type.Boolean(), value)
  ) {
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
  if (
    value === null ||
    Value.Check(Type.String(), value) ||
    Value.Check(Type.Number(), value) ||
    Value.Check(Type.Boolean(), value)
  ) {
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

  if (
    previousSummaryPresent !== undefined &&
    !Value.Check(Type.Boolean(), previousSummaryPresent)
  ) {
    return false;
  }

  if (compactedKeptWindow !== undefined && !Value.Check(Type.Boolean(), compactedKeptWindow)) {
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
    isNonEmptyString(candidate["provider"]!) &&
    isNonEmptyString(candidate["api"]!) &&
    isNonEmptyString(candidate["model"]!) &&
    isNonEmptyString(candidate["baseUrl"]!) &&
    Array.isArray(candidate["compactedWindow"]!) &&
    candidate["compactedWindow"]!.every(isCompactedWindowItem) &&
    isNonEmptyString(candidate["createdAt"]!) &&
    (candidate["compactResponseId"] === undefined ||
      isNonEmptyString(candidate["compactResponseId"]!)) &&
    (candidate["requestMeta"] === undefined ||
      isNativeCompactionRequestMeta(candidate["requestMeta"]!)) &&
    (candidate["usage"] === undefined || isNativeCompactionUsage(candidate["usage"]!))
  );
}

export function isNativeCompactionEntry(value: BoundaryValue): value is NativeCompactionEntry {
  return (
    isRecord(value) &&
    value["type"] === "compaction" &&
    isNativeCompactionDetails(value["details"]!)
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
