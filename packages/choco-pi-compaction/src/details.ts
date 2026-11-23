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

const CarriedFileListsSchema = obj(
  { readFiles: arr(str()), modifiedFiles: arr(str()) },
  { open: true },
);
const isCarriedFileLists = compile(CarriedFileListsSchema).check;

export type CarriedFileLists = Static<typeof CarriedFileListsSchema>;

export function parseCarriedFileLists(entry: CompactionEntry): CarriedFileLists | undefined {
  const details = entry.details;
  if (!isCarriedFileLists(details)) {
    return undefined;
  }
  return { readFiles: [...details.readFiles], modifiedFiles: [...details.modifiedFiles] };
}

export function parseLocalCompactionDetails(
  entry: CompactionEntry,
): LocalCompactionDetails | undefined {
  const details = entry.details;
  return isLocalCompactionDetails(details) ? details : undefined;
}

const NonEmptyString = nonEmptyStr();

const GoverningRequestSchema = obj({
  entryId: NonEmptyString,
  content: str(),
  truncated: bool(),
});

const TextBackgroundMetadataSchema = obj({
  schemaVersion: lit(1),
  mode: lit("frozen-prefix"),
  cutEntryId: NonEmptyString,
  firstKeptEntryId: NonEmptyString,
  splitTurn: bool(),
  governingRequest: nullable(GoverningRequestSchema),
  priorCheckpointId: nullable(NonEmptyString),
  priorCheckpointVersion: nullable(finiteInt(1)),
  evidenceEntryIds: EntryIdRangeSchema,
});

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

export function parseTextCheckpointDetails(
  entry: CompactionEntry,
): TextCheckpointDetails | undefined {
  const details = entry.details;
  return isTextCheckpointDetails(details) ? details : undefined;
}

export function validTextCheckpointDetails(details: TextCheckpointDetails): boolean {
  return isTextCheckpointDetails(details);
}
