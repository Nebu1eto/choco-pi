import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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
