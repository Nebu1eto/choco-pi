import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import {
  arr,
  bool,
  compile,
  lit,
  nul,
  nullable,
  obj,
  oneOf,
  opt,
  str,
  tuple,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { finiteInt, nonEmptyStr } from "./guards.ts";

const EntryIdRangeSchema = nullable(tuple([str(), str()]));

/**
 * Details written onto the compaction checkpoint produced here.
 *
 * `strategy` discriminates this producer from the host's and from any other
 * extension's checkpoint, and `schemaVersion` lets a later reader reject a
 * payload it does not understand instead of misreading it.
 */
export const LocalCompactionDetailsSchema = obj(
  {
    strategy: lit("local-reconciled"),
    schemaVersion: lit(1),
    readFiles: arr(str()),
    modifiedFiles: arr(str()),
    passes: oneOf([1, 2]),
    evidence: obj(
      {
        historyEntryIds: EntryIdRangeSchema,
        tailEntryIds: EntryIdRangeSchema,
        previousCheckpointId: opt(str()),
      },
      { open: true },
    ),
  },
  { open: true },
);
export const isLocalCompactionDetails = compile(LocalCompactionDetailsSchema).check;

export type LocalCompactionDetails = Static<typeof LocalCompactionDetailsSchema>;

/**
 * The file-tracking part of any compaction checkpoint's details.
 *
 * Checkpoints written by the host, by this package, and by other extensions
 * agree on these two arrays, so this is the contract used to carry file
 * history across a boundary regardless of who wrote it.
 */
const CarriedFileListsSchema = obj(
  { readFiles: arr(str()), modifiedFiles: arr(str()) },
  { open: true },
);
const isCarriedFileLists = compile(CarriedFileListsSchema).check;

export type CarriedFileLists = Static<typeof CarriedFileListsSchema>;

/** Validate a previous checkpoint's details; a mismatch is ignored, not guessed at. */
export function parseCarriedFileLists(entry: CompactionEntry): CarriedFileLists | undefined {
  const details = entry.details;
  if (!isCarriedFileLists(details)) {
    return undefined;
  }
  return { readFiles: [...details.readFiles], modifiedFiles: [...details.modifiedFiles] };
}

/** Validate details written by this package; used by readers and tests. */
export function parseLocalCompactionDetails(
  entry: CompactionEntry,
): LocalCompactionDetails | undefined {
  const details = entry.details;
  return isLocalCompactionDetails(details) ? details : undefined;
}

const NonEmptyString = nonEmptyStr();

/** User request that governs a turn split by a background checkpoint. */
const GoverningRequestSchema = obj({
  entryId: NonEmptyString,
  content: str(),
  /** True when `content` was capped before persisting. */
  truncated: bool(),
});

/** Frozen-prefix provenance of a text checkpoint prepared in the background. */
const TextBackgroundMetadataSchema = obj({
  schemaVersion: lit(1),
  mode: lit("frozen-prefix"),
  /** Last summarized entry. */
  cutEntryId: NonEmptyString,
  /** First retained entry; equals the draft's `firstKeptEntryId`. */
  firstKeptEntryId: NonEmptyString,
  splitTurn: bool(),
  governingRequest: nullable(GoverningRequestSchema),
  priorCheckpointId: nullable(NonEmptyString),
  priorCheckpointVersion: nullable(finiteInt(1)),
  /** Pre-cut messages the second pass read verbatim, or null for one pass. */
  evidenceEntryIds: EntryIdRangeSchema,
});

/**
 * Details of a text checkpoint prepared by the background text backend.
 *
 * It is a strict superset of {@link LocalCompactionDetailsSchema}, so existing
 * readers keep accepting it. `tailEntryIds` is always null: the background path
 * never reads retained entries. `candidateId` and `fingerprint` let the
 * coordinator acknowledge a commit by branch scan.
 */
const TextCheckpointDetailsSchema = obj({
  strategy: lit("local-reconciled"),
  schemaVersion: lit(1),
  readFiles: arr(str()),
  modifiedFiles: arr(str()),
  passes: oneOf([1, 2]),
  evidence: obj({
    historyEntryIds: EntryIdRangeSchema,
    tailEntryIds: nul(),
    previousCheckpointId: opt(NonEmptyString),
  }),
  candidateId: NonEmptyString,
  fingerprint: NonEmptyString,
  background: TextBackgroundMetadataSchema,
});
const isTextCheckpointDetails = compile(TextCheckpointDetailsSchema).check;

export type TextCheckpointDetails = Static<typeof TextCheckpointDetailsSchema>;

/** Validate details written by the background text backend. */
export function parseTextCheckpointDetails(
  entry: CompactionEntry,
): TextCheckpointDetails | undefined {
  const details = entry.details;
  return isTextCheckpointDetails(details) ? details : undefined;
}

/**
 * Re-validate constructed details before they are attached to a draft.
 *
 * The static type cannot rule out empty IDs, non-integer versions, or stray
 * keys from a spread, all of which the schema rejects.
 */
export function validTextCheckpointDetails(details: TextCheckpointDetails): boolean {
  return isTextCheckpointDetails(details);
}
