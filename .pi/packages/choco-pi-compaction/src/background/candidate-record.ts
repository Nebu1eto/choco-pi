import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { fingerprintEntries, prefixReferences, touchesPrefix } from "./snapshot.ts";
import {
  isCandidateRecord,
  type CandidateRecord,
  type FrozenSnapshot,
  type PreparedCheckpoint,
  type ProviderScope,
  type ReasonCode,
  type SnapshotIdentity,
} from "./contract.ts";

export function fingerprintPrefix(
  entries: readonly SessionEntry[],
  cutEntryId: string,
): string | undefined {
  const cut = entries.findIndex((entry) => entry.id === cutEntryId);
  if (cut < 0) return undefined;
  return fingerprintEntries(entries.slice(0, cut + 1));
}

/** Strict scope identity: every provider, model, endpoint, auth, and account field is equal. */
function scopesStrictlyEqual(left: ProviderScope, right: ProviderScope): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.baseUrl === right.baseUrl &&
    left.authMode === right.authMode &&
    left.accountScope === right.accountScope
  );
}

function snapshotIdentity(snapshot: FrozenSnapshot): SnapshotIdentity {
  return {
    cutEntryId: snapshot.cutEntryId,
    prefixFingerprint: snapshot.prefixFingerprint,
    priorCheckpointId: snapshot.priorCheckpointId,
    priorCheckpointVersion: snapshot.priorCheckpointVersion,
    ownerKey: snapshot.ownerKey,
    ownerGeneration: snapshot.ownerGeneration,
    providerScope: structuredClone(snapshot.providerScope),
  };
}

export function buildRecord(
  snapshot: FrozenSnapshot,
  checkpoint: PreparedCheckpoint,
  createdAt: number,
  customInstructions?: string,
): CandidateRecord | undefined {
  const record = {
    customType: "choco-compaction-candidate",
    schemaVersion: 1,
    candidateId: checkpoint.candidateId,
    backendId: checkpoint.backendId,
    identity: snapshotIdentity(snapshot),
    createdAt,
    checkpoint: { ...checkpoint, reasonCodes: [...checkpoint.reasonCodes] },
  };
  return customInstructions === undefined
    ? parseRecord(record)
    : parseRecord({ ...record, customInstructions });
}

export function parseRecord<T>(value: T): CandidateRecord | undefined {
  return isCandidateRecord(value) ? structuredClone(value) : undefined;
}

interface IdentityComparison {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly providerScope: ProviderScope;
  readonly entries: readonly SessionEntry[];
  readonly latestCheckpoint: { readonly id: string; readonly version: number } | null;
}

interface RevalidateOptions {
  /** Recovery adopts records written by an earlier generation of the same owner. */
  readonly acceptEarlierGeneration?: boolean;
}

export function revalidateIdentity(
  identity: SnapshotIdentity,
  current: IdentityComparison,
  options: RevalidateOptions = {},
): ReasonCode | undefined {
  if (!sameOwner(identity, current, options)) return "owner-changed";
  if (!scopesStrictlyEqual(identity.providerScope, current.providerScope)) return "incompatible";
  if (!sameCheckpoint(identity, current)) return "checkpoint-changed";
  if (fingerprintPrefix(current.entries, identity.cutEntryId) !== identity.prefixFingerprint)
    return "stale-prefix";
  return suffixTouchesPrefix(current.entries, identity.cutEntryId) ? "stale-prefix" : undefined;
}

function sameOwner(
  identity: SnapshotIdentity,
  current: IdentityComparison,
  options: RevalidateOptions,
): boolean {
  if (identity.ownerKey !== current.ownerKey) return false;
  return (
    options.acceptEarlierGeneration === true || identity.ownerGeneration === current.ownerGeneration
  );
}

function sameCheckpoint(identity: SnapshotIdentity, current: IdentityComparison): boolean {
  return (
    (current.latestCheckpoint?.id ?? null) === identity.priorCheckpointId &&
    (current.latestCheckpoint?.version ?? null) === identity.priorCheckpointVersion
  );
}

function suffixTouchesPrefix(entries: readonly SessionEntry[], cutEntryId: string): boolean {
  const cut = entries.findIndex((entry) => entry.id === cutEntryId);
  const prefix = prefixReferences(entries.slice(0, cut + 1));
  return entries.slice(cut + 1).some((entry) => touchesPrefix(entry, prefix));
}
