import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { WireMapping } from "./anthropic/capture.ts";

export function retainableEntryIds(entries: readonly SessionEntry[]): string[] {
  return entries.flatMap((entry) => (entry.type === "compaction" ? [] : [entry.id]));
}

export function latestCompactionId(entries: readonly SessionEntry[]): string | undefined {
  return entries.findLast((entry) => entry.type === "compaction")?.id;
}

export function capturedSince(
  mapping: WireMapping | undefined,
  compactionId: string | undefined,
): boolean {
  if (compactionId === undefined) return true;
  return mapping?.projection.some((ref) => ref.entryId === compactionId) === true;
}
