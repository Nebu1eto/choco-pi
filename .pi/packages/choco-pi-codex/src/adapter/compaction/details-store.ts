import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { isCanonicalCodexBaseUrl } from "../prompt/codex-model.ts";
import { type Static, Type } from "typebox";
import {
  JsonValueSchema,
  type JsonValue,
} from "../../../../choco-pi-compaction/src/background/contract.ts";
import type { ProviderScope } from "../../../../choco-pi-compaction/src/background/contract.ts";
import { buildRemoteCompactionV2Window, canonicalCompactionOutput } from "./remote-v2-history.ts";
import {
  isNativeCompactionEntry,
  isNativeCompactionDetails,
  type BackgroundNativeCompactionDetails,
  type NativeCompactionEntry,
  type NativeCompactionIdentity,
} from "../compaction/types.ts";

export type NativeCompactionEntryMatch = Partial<NativeCompactionIdentity>;

const JsonScalarSchema = Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String()]);
const PersistableJsonSchema = Type.Cyclic(
  {
    CodexPersistableJson: Type.Union([
      JsonScalarSchema,
      Type.Array(Type.Ref("CodexPersistableJson")),
      Type.Record(Type.String(), Type.Union([Type.Ref("CodexPersistableJson"), Type.Undefined()])),
    ]),
  },
  "CodexPersistableJson",
);
type PersistableJson = Static<typeof PersistableJsonSchema>;
const PersistableObjectSchema = Type.Record(
  Type.String(),
  Type.Union([PersistableJsonSchema, Type.Undefined()]),
);
function constructJsonValue(value: PersistableJson): JsonValue | undefined {
  if (Value.Check(JsonScalarSchema, value)) return value;
  if (Value.Check(Type.Array(PersistableJsonSchema), value)) {
    const output: JsonValue[] = [];
    for (const member of value) {
      const detached = constructJsonValue(member);
      if (detached === undefined) return undefined;
      output.push(detached);
    }
    return output;
  }
  if (!Value.Check(PersistableObjectSchema, value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const output: Record<string, JsonValue> = {};
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined) continue;
    const detached = constructJsonValue(member);
    if (detached === undefined) return undefined;
    Object.defineProperty(output, key, {
      value: detached,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return output;
}
/** Validate plain JSON-like data, construct a detached JSON tree and omit undefined object fields. */
export function cloneCodexCompactionJson<T>(value: T): JsonValue | undefined {
  return Value.Check(PersistableJsonSchema, value) ? constructJsonValue(value) : undefined;
}

/** Legacy readers remain valid; background records require complete versioned lineage. */
export function isBackgroundNativeCompactionDetails<T>(
  value: T,
): value is T & BackgroundNativeCompactionDetails {
  if (
    !Value.Check(JsonValueSchema, value) ||
    !isNativeCompactionDetails(value) ||
    value.strategy !== "openai-responses-compaction-v2" ||
    value.schemaVersion !== 1 ||
    !value.candidateId ||
    !value.prefixFingerprint ||
    !value.background
  )
    return false;
  const scope = value.background.providerScope;
  if (
    value.api !== "openai-codex-responses" ||
    scope.provider !== "openai-codex" ||
    scope.authMode !== "oauth" ||
    !/^sha256:[a-f0-9]{64}$/.test(scope.accountScope ?? "") ||
    !isCanonicalCodexBaseUrl(scope.baseUrl)
  )
    return false;
  if (
    value.provider !== scope.provider ||
    value.model !== scope.model ||
    value.baseUrl !== scope.baseUrl
  )
    return false;
  const nativeItems = value.compactedWindow.filter(
    (item) =>
      Value.Check(Type.Record(Type.String(), JsonValueSchema), item) &&
      (item["type"] === "compaction" || item["type"] === "compaction_summary"),
  );
  const compaction =
    nativeItems.length === 1 ? canonicalCompactionOutput(nativeItems[0]) : undefined;
  if (!compaction) return false;
  const records = value.compactedWindow.filter((item) =>
    Value.Check(Type.Record(Type.String(), JsonValueSchema), item),
  );
  return (
    records.length === value.compactedWindow.length &&
    Value.Equal(value.compactedWindow, buildRemoteCompactionV2Window(records, compaction))
  );
}

/** Same-account/model replay only; portability must be proven outside this adapter. */
export function isCodexBackgroundScopeCompatible(
  details: BackgroundNativeCompactionDetails,
  scope: ProviderScope,
): boolean {
  return Value.Equal(details.background.providerScope, scope);
}

export function persistCodexBackgroundDetails(
  details: BackgroundNativeCompactionDetails,
): BackgroundNativeCompactionDetails {
  const detached = cloneCodexCompactionJson({
    strategy: details.strategy,
    schemaVersion: details.schemaVersion,
    candidateId: details.candidateId,
    prefixFingerprint: details.prefixFingerprint,
    provider: details.provider,
    api: details.api,
    model: details.model,
    baseUrl: details.baseUrl,
    compactedWindow: details.compactedWindow,
    compactResponseId: details.compactResponseId,
    createdAt: details.createdAt,
    usage: details.usage,
    requestMeta: details.requestMeta,
    background: {
      sessionId: details.background.sessionId,
      ownerKey: details.background.ownerKey,
      ownerGeneration: details.background.ownerGeneration,
      cutEntryId: details.background.cutEntryId,
      retentionPolicyVersion: details.background.retentionPolicyVersion,
      providerScope: {
        provider: details.background.providerScope.provider,
        model: details.background.providerScope.model,
        baseUrl: details.background.providerScope.baseUrl,
        authMode: details.background.providerScope.authMode,
        accountScope: details.background.providerScope.accountScope,
      },
    },
  });
  if (!isBackgroundNativeCompactionDetails(detached))
    throw new Error("Invalid background native compaction details");
  return detached;
}

export type LatestNativeCompactionResolutionFailureReason =
  | "no-compaction"
  | "latest-compaction-not-native"
  | "latest-native-compaction-mismatch";

export type LatestNativeCompactionResolution =
  | {
      ok: true;
      entry: NativeCompactionEntry;
      index: number;
      latestCompactionIndex: number;
    }
  | {
      ok: false;
      reason: LatestNativeCompactionResolutionFailureReason;
      latestCompactionIndex?: number | undefined;
      latestCompaction?: CompactionEntry | undefined;
    };

function entryMatches(entry: NativeCompactionEntry, match: NativeCompactionEntryMatch): boolean {
  const details = entry.details;
  if (!details) {
    return false;
  }

  return (
    (match.provider === undefined || details.provider === match.provider) &&
    (match.api === undefined || details.api === match.api) &&
    (match.model === undefined || details.model === match.model) &&
    (match.baseUrl === undefined || details.baseUrl === match.baseUrl)
  );
}

export function isPersistedNativeCompactionEntry(
  entry: CompactionEntry | SessionEntry | undefined,
): entry is NativeCompactionEntry {
  return isNativeCompactionEntry(entry);
}

export function findLatestCompactionEntryIndex(
  entries: readonly SessionEntry[],
): number | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.type === "compaction") {
      return index;
    }
  }

  return undefined;
}

export function findLatestCompactionEntry(
  entries: readonly SessionEntry[],
): CompactionEntry | undefined {
  const index = findLatestCompactionEntryIndex(entries);
  const entry = index === undefined ? undefined : entries[index];
  return entry?.type === "compaction" ? entry : undefined;
}

export function findLatestNativeCompactionEntryIndex(
  entries: readonly SessionEntry[],
  match: NativeCompactionEntryMatch = {},
): number | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isPersistedNativeCompactionEntry(entry)) {
      continue;
    }

    if (!entryMatches(entry, match)) {
      continue;
    }

    return index;
  }

  return undefined;
}

export function findLatestNativeCompactionEntry(
  entries: readonly SessionEntry[],
  match: NativeCompactionEntryMatch = {},
): NativeCompactionEntry | undefined {
  const index = findLatestNativeCompactionEntryIndex(entries, match);
  const entry = index === undefined ? undefined : entries[index];
  return isPersistedNativeCompactionEntry(entry) ? entry : undefined;
}

export function resolveLatestNativeCompactionEntry(
  entries: readonly SessionEntry[],
  match: NativeCompactionEntryMatch = {},
): LatestNativeCompactionResolution {
  const latestCompactionIndex = findLatestCompactionEntryIndex(entries);
  if (latestCompactionIndex === undefined) {
    return {
      ok: false,
      reason: "no-compaction",
    };
  }

  const latestCompaction = entries[latestCompactionIndex];
  if (
    !latestCompaction ||
    latestCompaction.type !== "compaction" ||
    !isPersistedNativeCompactionEntry(latestCompaction)
  ) {
    const latestCompactionEntry =
      latestCompaction?.type === "compaction" ? latestCompaction : undefined;
    return {
      ok: false,
      reason: "latest-compaction-not-native",
      latestCompactionIndex,
      latestCompaction: latestCompactionEntry,
    };
  }

  if (!entryMatches(latestCompaction, match)) {
    return {
      ok: false,
      reason: "latest-native-compaction-mismatch",
      latestCompactionIndex,
      latestCompaction,
    };
  }

  return {
    ok: true,
    entry: latestCompaction,
    index: latestCompactionIndex,
    latestCompactionIndex,
  };
}
