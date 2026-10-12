import type { CompactionEntryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";

import type { CommittedCandidate } from "../background/adoption.ts";
import { CANDIDATE_RECORD_TYPE } from "../background/entry-types.ts";
import { readAdoptionIdentity } from "./adoption-signal.ts";

// ---------------------------------------------------------------------------
// Branch helpers
// ---------------------------------------------------------------------------

/** Latest compaction on the branch with its 1-based count (the text checkpoint version). */
export function latestCompactionOf(
  branch: readonly SessionEntry[],
): { readonly id: string; readonly version: number } | null {
  let latest: string | undefined;
  let count = 0;
  for (const entry of branch) {
    if (entry.type !== "compaction") continue;
    count += 1;
    latest = entry.id;
  }
  return latest === undefined ? null : { id: latest, version: count };
}

/** A committed compaction entry of this owner carrying the candidate's identity. */
export function findCommittedAdoption(
  branch: readonly SessionEntry[],
  ownerKey: string,
  candidateId: string,
  fingerprint: string,
): CommittedCandidate | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "compaction") continue;
    const identity = readAdoptionIdentity(entry);
    if (
      identity !== undefined &&
      identity.ownerKey === ownerKey &&
      identity.candidateId === candidateId &&
      identity.prefixFingerprint === fingerprint
    ) {
      return { id: entry.id, candidateId, fingerprint };
    }
  }
  return undefined;
}

/** Persisted candidate record payloads on the branch, oldest first (unvalidated). */
export function candidateRecordsOf(branch: readonly SessionEntry[]): unknown[] {
  const records: unknown[] = [];
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === CANDIDATE_RECORD_TYPE) {
      records.push(entry.data);
    }
  }
  return records;
}

/** Only the draft members the host reads; drops CompactionResult-only fields. */
export function boundaryDraft(draft: CompactionEntryDraft): CompactionEntryDraft {
  const clean: CompactionEntryDraft = {
    type: "compaction",
    summary: draft.summary,
    firstKeptEntryId: draft.firstKeptEntryId,
    details: draft.details,
  };
  if (draft.usage !== undefined) clean.usage = draft.usage;
  return clean;
}
