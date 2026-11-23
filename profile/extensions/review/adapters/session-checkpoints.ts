import { propertiesWhen } from "../../lib/runtime-values.ts";
import { isFunction } from "../../lib/runtime-values.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { turnCheckpointsFromEntries, type TurnCheckpoint } from "../../checkpoints/turns.ts";
import { sessionBaselineOf } from "../../lib/changes/session-baseline.ts";
import type { ReviewRecord, SessionCheckpointProvider } from "../core/types.ts";

export const REVIEW_STATE_ENTRY = "choco-pi:review-state";

export type SessionCheckpointAdapterOptions = {
  entries: readonly SessionEntry[] | (() => readonly SessionEntry[]);
  sessionEntries?: () => readonly SessionEntry[];
  appendEntry?: (customType: string, data: ReviewRecord) => void;
};

export function reviewTurnsFromEntries(
  entries: readonly SessionEntry[],
): Array<{ turnIndex: number; tree: string; label: string }> {
  return turnCheckpointsFromEntries(entries).map((turn: TurnCheckpoint, index) => ({
    turnIndex: index + 1,
    tree: turn.checkpoint.worktreeTree,
    label: turn.label,
  }));
}

export function createSessionCheckpointProvider(
  options: SessionCheckpointAdapterOptions,
): SessionCheckpointProvider {
  const readEntries = isFunction(options.entries)
    ? options.entries
    : // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
      () => options.entries as readonly SessionEntry[];
  return {
    listTurns: async () => reviewTurnsFromEntries(readEntries()),
    ...propertiesWhen(options.sessionEntries, () => ({
      sessionBaseline: async () => sessionBaselineOf(options.sessionEntries?.() ?? []),
    })),
    ...propertiesWhen(options.appendEntry, () => ({
      appendReviewState: (record: ReviewRecord) => {
        options.appendEntry?.(REVIEW_STATE_ENTRY, record);
      },
    })),
  };
}
