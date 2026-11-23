import {
  type SessionBeforeCompactEvent,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

import { type CarriedFileLists, parseCarriedFileLists } from "./details.ts";
import type { CompactionMessage, EntryIdRange } from "./types.ts";

export interface CompactionInput {
  readonly history: readonly CompactionMessage[];
  readonly prefix: readonly CompactionMessage[];
  readonly tail: readonly CompactionMessage[];
  readonly previousSummary: string | undefined;
  readonly previousDetails: CarriedFileLists | undefined;
  readonly historyEntryIds: EntryIdRange | null;
  readonly tailEntryIds: EntryIdRange | null;
  readonly previousCheckpointId: string | undefined;
}

function entryMessages(entry: SessionEntry): CompactionMessage[] {
  if (entry.type === "compaction") {
    return [];
  }
  return sessionEntryToContextMessages(entry).filter((message) => message.role !== "system");
}

function rangeOf(
  entries: readonly SessionEntry[],
  start: number,
  end: number,
): EntryIdRange | null {
  let first: string | undefined;
  let last: string | undefined;
  for (let index = start; index < end; index++) {
    const entry = entries[index];
    if (!entry || entryMessages(entry).length === 0) {
      continue;
    }
    first ??= entry.id;
    last = entry.id;
  }
  if (first === undefined || last === undefined) {
    return null;
  }
  return [first, last];
}

function collectTail(entries: readonly SessionEntry[], start: number): CompactionMessage[] {
  const tail: CompactionMessage[] = [];
  for (let index = start; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    tail.push(...entryMessages(entry));
  }
  return tail;
}

function lastCompactionIndex(entries: readonly SessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.type === "compaction") {
      return index;
    }
  }
  return -1;
}

export function buildCompactionInput(event: SessionBeforeCompactEvent): CompactionInput {
  const entries = event.branchEntries;
  const preparation = event.preparation;
  const firstKeptIndex = entries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
  if (firstKeptIndex < 0) {
    throw new Error(
      `compaction boundary entry ${preparation.firstKeptEntryId} is not in the session branch`,
    );
  }

  const previousIndex = lastCompactionIndex(entries);
  const previousEntry = previousIndex >= 0 ? entries[previousIndex] : undefined;
  let boundaryStart = 0;
  let previousDetails: CarriedFileLists | undefined;
  let previousCheckpointId: string | undefined;
  if (previousEntry?.type === "compaction") {
    const boundaryIndex = entries.findIndex((entry) => entry.id === previousEntry.firstKeptEntryId);
    boundaryStart = boundaryIndex >= 0 ? boundaryIndex : previousIndex + 1;
    previousDetails = parseCarriedFileLists(previousEntry);
    previousCheckpointId = previousEntry.id;
  }

  return {
    history: preparation.messagesToSummarize,
    prefix: preparation.isSplitTurn ? preparation.turnPrefixMessages : [],
    tail: collectTail(entries, firstKeptIndex),
    previousSummary: preparation.previousSummary,
    previousDetails,
    historyEntryIds: rangeOf(entries, Math.min(boundaryStart, firstKeptIndex), firstKeptIndex),
    tailEntryIds: rangeOf(entries, firstKeptIndex, entries.length),
    previousCheckpointId,
  };
}
