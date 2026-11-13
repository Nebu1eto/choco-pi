import {
  type SessionBeforeCompactEvent,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

import { type CarriedFileLists, parseCarriedFileLists } from "./details.ts";
import type { CompactionMessage, EntryIdRange } from "./types.ts";

/** Everything the summarizer needs, with boundaries expressed as entry IDs. */
export interface CompactionInput {
  /** Messages the host is about to discard. */
  readonly history: readonly CompactionMessage[];
  /** Prefix of a split turn, which the host also discards. */
  readonly prefix: readonly CompactionMessage[];
  /** Messages the host retains: the current state of the work. */
  readonly tail: readonly CompactionMessage[];
  readonly previousSummary: string | undefined;
  readonly previousDetails: CarriedFileLists | undefined;
  /** First and last summarized entry IDs, or null when nothing is summarized. */
  readonly historyEntryIds: EntryIdRange | null;
  /** First and last retained entry IDs, or null when the tail is empty. */
  readonly tailEntryIds: EntryIdRange | null;
  readonly previousCheckpointId: string | undefined;
}

/**
 * Messages an entry contributes to the summarizer.
 *
 * Compaction entries are checkpoints rather than conversation, and system
 * messages are prompt state that the checkpoint replays separately, so the
 * host excludes both (`core/compaction/compaction.js`). Unlike the host, every
 * non-system message of an entry is kept rather than only the first: the tail
 * is evidence about the current state, and silently dropping part of an entry
 * there would reintroduce the defect this package exists to fix.
 */
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

/**
 * Derive the summarizer's inputs from the host's preparation and branch.
 *
 * `CompactionPreparation` carries only what the host is about to discard. The
 * retained tail is reconstructed from `branchEntries`, starting at the
 * preparation's `firstKeptEntryId`.
 */
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
