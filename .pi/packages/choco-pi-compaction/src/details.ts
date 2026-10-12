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

const NonEmptyString = Type.String({ minLength: 1 });
const StrictObject = { additionalProperties: false };

/** User request that governs a turn split by a background checkpoint. */
const GoverningRequestSchema = Type.Object(
  {
    entryId: NonEmptyString,
    content: Type.String(),
    /** True when `content` was capped before persisting. */
    truncated: Type.Boolean(),
  },
  StrictObject,
);

/** Frozen-prefix provenance of a text checkpoint prepared in the background. */
const TextBackgroundMetadataSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    mode: Type.Literal("frozen-prefix"),
    /** Last summarized entry. */
    cutEntryId: NonEmptyString,
    /** First retained entry; equals the draft's `firstKeptEntryId`. */
    firstKeptEntryId: NonEmptyString,
    splitTurn: Type.Boolean(),
    governingRequest: Type.Union([GoverningRequestSchema, Type.Null()]),
    priorCheckpointId: Type.Union([NonEmptyString, Type.Null()]),
    priorCheckpointVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    /** Pre-cut messages the second pass read verbatim, or null for one pass. */
    evidenceEntryIds: EntryIdRangeSchema,
  },
  StrictObject,
);

/**
 * Details of a text checkpoint prepared by the background text backend.
 *
 * It is a strict superset of {@link LocalCompactionDetailsSchema}, so existing
 * readers keep accepting it. `tailEntryIds` is always null: the background path
 * never reads retained entries. `candidateId` and `fingerprint` let the
 * coordinator acknowledge a commit by branch scan.
 */
const TextCheckpointDetailsSchema = Type.Object(
  {
    strategy: Type.Literal("local-reconciled"),
    schemaVersion: Type.Literal(1),
    readFiles: Type.Array(Type.String()),
    modifiedFiles: Type.Array(Type.String()),
    passes: Type.Union([Type.Literal(1), Type.Literal(2)]),
    evidence: Type.Object(
      {
        historyEntryIds: EntryIdRangeSchema,
        tailEntryIds: Type.Null(),
        previousCheckpointId: Type.Optional(NonEmptyString),
      },
      StrictObject,
    ),
    candidateId: NonEmptyString,
    fingerprint: NonEmptyString,
    background: TextBackgroundMetadataSchema,
  },
  StrictObject,
);

export type TextCheckpointDetails = Static<typeof TextCheckpointDetailsSchema>;

/** Validate details written by the background text backend. */
export function parseTextCheckpointDetails(
  entry: CompactionEntry,
): TextCheckpointDetails | undefined {
  const details = entry.details;
  return Value.Check(TextCheckpointDetailsSchema, details) ? details : undefined;
}

/**
 * Re-validate constructed details before they are attached to a draft.
 *
 * The static type cannot rule out empty IDs, non-integer versions, or stray
 * keys from a spread, all of which the schema rejects.
 */
export function validTextCheckpointDetails(details: TextCheckpointDetails): boolean {
  return Value.Check(TextCheckpointDetailsSchema, details);
}
