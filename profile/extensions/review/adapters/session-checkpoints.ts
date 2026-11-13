import { propertiesWhen } from "../../lib/runtime-values.ts";
import { isFunction } from "../../lib/runtime-values.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { turnCheckpointsFromEntries, type TurnCheckpoint } from "../../checkpoints/turns.ts";
import { sessionBaselineOf } from "../../lib/changes/session-baseline.ts";
import type { ReviewRecord, SessionCheckpointProvider } from "../core/types.ts";

export const REVIEW_STATE_ENTRY = "choco-pi:review-state";

export type SessionCheckpointAdapterOptions = {
  /** A getter keeps the provider current if the session branch changes. */
  entries: readonly SessionEntry[] | (() => readonly SessionEntry[]);
  /**
   * Every entry of the session file (`getEntries()`), for the session
   * baseline `/diff` uses: the first checkpoint anywhere in the session.
   * Without it a session review starts at the active branch's first turn.
   */
  sessionEntries?: () => readonly SessionEntry[];
  /** Pi's appendEntry seam; omitted when review state should not enter the session. */
  appendEntry?: (customType: string, data: ReviewRecord) => void;
};

/**
 * Checkpointed turns of the active branch, oldest first, numbered by
 * position: 1 is the first checkpointed turn. (The checkpoint's own
 * `turnIndex` restarts with every prompt, so it cannot tell turns apart.)
 */
export function reviewTurnsFromEntries(
  entries: readonly SessionEntry[],
): Array<{ turnIndex: number; tree: string; label: string }> {
  return turnCheckpointsFromEntries(entries).map((turn: TurnCheckpoint, index) => ({
    turnIndex: index + 1,
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
