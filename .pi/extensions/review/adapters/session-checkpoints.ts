import { propertiesWhen } from "../../lib/runtime-values.ts";
import { isFunction } from "../../lib/runtime-values.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { turnCheckpointsFromEntries, type TurnCheckpoint } from "../../file-checkpoints.ts";
import type { ReviewRecord, SessionCheckpointProvider } from "../core/types.ts";

export const REVIEW_STATE_ENTRY = "choco-pi:review-state";

export type SessionCheckpointAdapterOptions = {
  /** A getter keeps the provider current if the session branch changes. */
  entries: readonly SessionEntry[] | (() => readonly SessionEntry[]);
  /** Pi's appendEntry seam; omitted when review state should not enter the session. */
  appendEntry?: (customType: string, data: ReviewRecord) => void;
};

export function reviewTurnsFromEntries(
  entries: readonly SessionEntry[],
): Array<{ turnIndex: number; tree: string; label: string }> {
  return turnCheckpointsFromEntries(entries).map((turn: TurnCheckpoint) => ({
    turnIndex: turn.checkpoint.turnIndex,
    tree: turn.checkpoint.worktreeTree,
    label: turn.label,
  }));
}

/** Adapt choco-pi's pre-turn Git trees to the host-independent review seam. */
export function createSessionCheckpointProvider(
  options: SessionCheckpointAdapterOptions,
): SessionCheckpointProvider {
  const readEntries = isFunction(options.entries)
    ? options.entries
    : // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
      () => options.entries as readonly SessionEntry[];
  return {
    listTurns: async () => reviewTurnsFromEntries(readEntries()),
    ...propertiesWhen(options.appendEntry, () => ({
      appendReviewState: (record: ReviewRecord) => {
        options.appendEntry?.(REVIEW_STATE_ENTRY, record);
      },
    })),
  };
}
