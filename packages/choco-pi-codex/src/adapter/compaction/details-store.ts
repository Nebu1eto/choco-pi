import type {
  CompactionEntry,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { LaneRoute } from "../../../../choco-pi-compaction/src/background/lane-journal.ts";
import { jsonEqual } from "../../../../choco-pi-compaction/src/background/json-equal.ts";
import { isBoolean, isNumber, isString } from "../../value-guards.ts";
import { isJsonObject, type BoundaryValue } from "../runtime-values.ts";
import { isCanonicalCodexBaseUrl } from "../prompt/codex-model.ts";
import {
  isJsonRecord,
  isJsonValue,
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

/**
 * Checkpoint identity to match. `accountScope` (the background lane's
 * `sha256:` account digest) is compared only for entries that carry
 * `background.providerScope`; entries without it keep provider/api/model/baseUrl
 * matching.
 */
export type NativeCompactionEntryMatch = Partial<NativeCompactionIdentity> & {
  readonly accountScope?: string | undefined;
};

/**
 * Validate plain JSON-like data and construct a detached JSON tree in one walk: scalars (finite
 * numbers only), arrays, and plain objects (Object.prototype or null prototype) whose undefined
 * members are omitted. Anything else (functions, bigint, symbols, class instances, boxed
 * primitives, holes) yields undefined.
 */
function constructJsonValue<T>(value: T): JsonValue | undefined {
  if (value === null) return null;
  if (isBoolean(value)) return value;
  if (isNumber(value)) return value;
  if (isString(value)) return value;
  if (Array.isArray(value)) {
    const members: BoundaryValue[] = value;
    const output: JsonValue[] = [];
    for (let index = 0; index < members.length; index += 1) {
      const detached = constructJsonValue(members[index]);
      if (detached === undefined) return undefined;
      output.push(detached);
    }
    return output;
  }
  if (!isJsonObject(value)) return undefined;
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
  return constructJsonValue(value);
}

/** Legacy readers remain valid; background records require complete versioned lineage. */
export function isBackgroundNativeCompactionDetails<T>(
  value: T,
): value is T & BackgroundNativeCompactionDetails {
  if (
    !isJsonValue(value) ||
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
      isJsonRecord(item) &&
      (item["type"] === "compaction" || item["type"] === "compaction_summary"),
  );
  const compaction =
    nativeItems.length === 1 ? canonicalCompactionOutput(nativeItems[0]) : undefined;
  if (!compaction) return false;
  const records = value.compactedWindow.filter((item) => isJsonRecord(item));
  return (
    records.length === value.compactedWindow.length &&
    jsonEqual(value.compactedWindow, buildRemoteCompactionV2Window(records, compaction))
  );
}

/** Same-account/model replay only; portability must be proven outside this adapter. */
export function isCodexBackgroundScopeCompatible(
  details: BackgroundNativeCompactionDetails,
  scope: ProviderScope,
): boolean {
  return jsonEqual(details.background.providerScope, scope);
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

/**
 * The lane-journal route of a host compaction trigger: `manual` and
 * `threshold` as they are; overflow recovery (and any other trigger) is the
 * foreground route.
 */
export function codexLaneRoute(reason: SessionBeforeCompactEvent["reason"]): LaneRoute {
  return reason === "manual" || reason === "threshold" ? reason : "foreground";
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

  const recordedAccount = details.background?.providerScope.accountScope;
  return (
    (match.provider === undefined || details.provider === match.provider) &&
    (match.api === undefined || details.api === match.api) &&
    (match.model === undefined || details.model === match.model) &&
    (match.baseUrl === undefined || details.baseUrl === match.baseUrl) &&
    (match.accountScope === undefined ||
      details.background === undefined ||
      recordedAccount === match.accountScope)
  );
}

/**
 * Whether a found native entry also matches `match` (account and model
 * included). Callers locate the entry by provider/api/baseUrl and then check
 * this, so an account mismatch is reported instead of silently skipping to an
 * older entry.
 */
export function nativeCompactionEntryMatches(
  entry: NativeCompactionEntry,
  match: NativeCompactionEntryMatch,
): boolean {
  return entryMatches(entry, match);
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
