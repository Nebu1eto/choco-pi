import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { WireMapping } from "./anthropic/capture.ts";

/**
 * Branch entry IDs a native compaction may name as its first kept entry: every
 * branch entry except compaction entries.
 *
 * A host compaction between a tool result and the next request puts its
 * compaction entry directly after the newest capture's last entry, so "the
 * branch entry after the cut" would be that compaction entry. Keeping an older
 * compaction entry retains it invisibly in the next projection while the wire
 * never carries it, and every later capture then fails to map. Skipping it
 * names the next real entry instead, which keeps the same messages.
 */
export function retainableEntryIds(entries: readonly SessionEntry[]): string[] {
  return entries.flatMap((entry) => (entry.type === "compaction" ? [] : [entry.id]));
}

/** ID of the newest compaction entry on the branch, if any. */
export function latestCompactionId(entries: readonly SessionEntry[]): string | undefined {
  return entries.findLast((entry) => entry.type === "compaction")?.id;
}

/**
 * Whether a capture was sent after the branch's newest compaction: every
 * request after a compaction projects that compaction entry first, so its
 * mapping contains the entry. With no compaction on the branch every capture
 * qualifies; an unmapped capture never does once one exists.
 */
export function capturedSince(
  mapping: WireMapping | undefined,
  compactionId: string | undefined,
): boolean {
  if (compactionId === undefined) return true;
  return mapping?.projection.some((ref) => ref.entryId === compactionId) === true;
}
