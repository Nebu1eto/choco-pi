import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const EntryIdRangeSchema = Type.Union([Type.Tuple([Type.String(), Type.String()]), Type.Null()]);

/**
 * Details written onto the compaction checkpoint produced here.
 *
 * `strategy` discriminates this producer from the host's and from any other
 * extension's checkpoint, and `schemaVersion` lets a later reader reject a
 * payload it does not understand instead of misreading it.
 */
export const LocalCompactionDetailsSchema = Type.Object({
  strategy: Type.Literal("local-reconciled"),
  schemaVersion: Type.Literal(1),
  readFiles: Type.Array(Type.String()),
  modifiedFiles: Type.Array(Type.String()),
  passes: Type.Union([Type.Literal(1), Type.Literal(2)]),
  evidence: Type.Object({
    historyEntryIds: EntryIdRangeSchema,
    tailEntryIds: EntryIdRangeSchema,
    previousCheckpointId: Type.Optional(Type.String()),
  }),
});

export type LocalCompactionDetails = Static<typeof LocalCompactionDetailsSchema>;

/**
 * The file-tracking part of any compaction checkpoint's details.
 *
 * Checkpoints written by the host, by this package, and by other extensions
 * agree on these two arrays, so this is the contract used to carry file
 * history across a boundary regardless of who wrote it.
 */
const CarriedFileListsSchema = Type.Object({
  readFiles: Type.Array(Type.String()),
  modifiedFiles: Type.Array(Type.String()),
});

export type CarriedFileLists = Static<typeof CarriedFileListsSchema>;

/** Validate a previous checkpoint's details; a mismatch is ignored, not guessed at. */
export function parseCarriedFileLists(entry: CompactionEntry): CarriedFileLists | undefined {
  const details = entry.details;
  if (!Value.Check(CarriedFileListsSchema, details)) {
    return undefined;
  }
  return { readFiles: [...details.readFiles], modifiedFiles: [...details.modifiedFiles] };
}

/** Validate details written by this package; used by readers and tests. */
export function parseLocalCompactionDetails(
  entry: CompactionEntry,
): LocalCompactionDetails | undefined {
  const details = entry.details;
  return Value.Check(LocalCompactionDetailsSchema, details) ? details : undefined;
}
