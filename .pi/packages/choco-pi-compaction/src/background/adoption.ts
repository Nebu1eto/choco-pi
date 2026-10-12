import type {
  CompactionEntryDraft,
  CompactionResult,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Adoption, AdoptionConsumer, CandidateRecord } from "./contract.ts";

export interface CommittedCandidate {
  readonly id: string;
  readonly candidateId: string;
  readonly fingerprint: string;
}

/** The adapter must append a model-invisible custom entry and return its real branch ID. */
export function firstRetainedEntry(
  entries: readonly SessionEntry[],
  cutEntryId: string,
): string | undefined {
  const cut = entries.findIndex((entry) => entry.id === cutEntryId);
  return cut < 0 ? undefined : entries[cut + 1]?.id;
}

interface DraftAdoptionContext {
  readonly firstKeptEntryId: string;
  readonly fingerprint: string;
  readonly ownerKey: string;
  readonly tokensBefore: number;
}

export function adoptionDraft(
  checkpoint: CandidateRecord["checkpoint"],
  context: DraftAdoptionContext,
): CompactionEntryDraft & CompactionResult {
  const { firstKeptEntryId, fingerprint, ownerKey, tokensBefore } = context;
  return {
    ...checkpoint.draft,
    firstKeptEntryId,
    tokensBefore,
    details: {
      ...checkpoint.details,
      candidateId: checkpoint.candidateId,
      prefixFingerprint: fingerprint,
      ownerKey,
    },
  };
}

/** Delivery IDs are marked before invoking user code, including throws and late callbacks. */
export class AdoptionDelivery {
  private readonly delivered = new Map<string, Set<string>>();
  readonly associations = new Map<string, string>();

  async deliver(
    adoption: Adoption,
    consumers: readonly AdoptionConsumer[],
    isCurrent: () => boolean,
  ): Promise<void> {
    this.associations.set(adoption.committedEntryId, adoption.candidateId);
    let seen = this.delivered.get(adoption.adoptionId);
    if (!seen) {
      seen = new Set();
      this.delivered.set(adoption.adoptionId, seen);
    }
    let failure: { cause: unknown } | undefined;
    for (const consumer of consumers) {
      if (!isCurrent()) {
        if (failure) throw failure.cause;
        return;
      }
      if (seen.has(consumer.id)) continue;
      seen.add(consumer.id);
      try {
        await consumer.onAdopted(adoption);
      } catch (cause) {
        failure ??= { cause };
      }
      if (!isCurrent()) {
        if (failure) throw failure.cause;
        return;
      }
    }
    if (failure) throw failure.cause;
  }
}
