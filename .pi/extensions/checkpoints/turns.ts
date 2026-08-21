import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  isNumber,
  isObject,
  isString,
  propertiesWhen,
  type RuntimeValue,
} from "../lib/runtime-values.ts";
import { summarizeChanges, type ChangeSummary, type GitSnapshot } from "./git-snapshot.ts";

export const CHECKPOINT_ENTRY = "choco-pi:file-checkpoint";
export const RESTORE_ENTRY = "choco-pi:file-checkpoint-restored";

/**
 * A checkpoint as persisted in the session.
 *
 * Version 1 stored `indexTree` plus `worktreeTree` and kept one ref per turn.
 * Version 2 adds the raw index blob and the anchoring commit. Both remain
 * readable so sessions recorded before the upgrade stay rewindable.
 */
export type FileCheckpoint = GitSnapshot & {
  version: 1 | 2;
  timestamp: string;
  turnIndex: number;
  label: string;
};

/** One user prompt on the active branch, with the file state captured before it. */
export type SessionTurn = {
  /** Entry id of the user message; the navigation and fork target. */
  entryId: string;
  /** 1-based position among the user turns of this branch. */
  index: number;
  label: string;
  timestamp: string;
  checkpoint?: FileCheckpoint;
  checkpointEntryId?: string;
};

export type TurnTimelineItem = {
  turn: SessionTurn;
  /** Code changes this turn produced. Absent without a usable checkpoint pair. */
  changes?: ChangeSummary;
};

function textParts(part: RuntimeValue): string[] {
  if (!isObject(part) || part === null) return [];
  if (!("type" in part) || part.type !== "text") return [];
  return "text" in part && isString(part.text) ? [part.text] : [];
}

/** A one-line prompt summary for the picker, from either message content shape. */
export function messageContentLabel(content: RuntimeValue): string {
  const text = isString(content)
    ? content
    : Array.isArray(content)
      ? content.flatMap(textParts).join(" ")
      : "";
  return text.replaceAll(/\s+/g, " ").trim().slice(0, 240) || "User turn";
}

function parseCheckpoint(data: RuntimeValue): FileCheckpoint | undefined {
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const value = data as Partial<FileCheckpoint> | undefined;
  if (!value) return undefined;
  const versioned = value.version === 1 || value.version === 2;
  if (!versioned) return undefined;
  if (!isString(value.worktreeTree)) return undefined;
  if (!isString(value.timestamp) || !isNumber(value.turnIndex) || !isString(value.label)) {
    return undefined;
  }
  // Version 1 recorded a safety snapshot under this label; it is not a turn start.
  if (value.label === "Before rewind") return undefined;
  if (value.version === 1 && !isString(value.indexTree)) return undefined;
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  return value as FileCheckpoint;
}

/**
 * Lists the user turns on a branch, newest last.
 *
 * Pi appends the pre-turn checkpoint before persisting the user message, so the
 * last checkpoint seen before a user entry is the state that entry started from.
 * Turns without a checkpoint still appear: conversation rewind and fork do not
 * need Git, and hiding those turns would make the picker useless in a working
 * tree where snapshots are unavailable.
 */
export function sessionTurnsFromEntries(entries: readonly SessionEntry[]): SessionTurn[] {
  let pendingCheckpoint: FileCheckpoint | undefined;
  let pendingEntryId: string | undefined;
  let index = 0;
  const turns: SessionTurn[] = [];

  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "user") {
      index += 1;
      turns.push({
        entryId: entry.id,
        index,
        label: messageContentLabel(entry.message.content),
        timestamp: pendingCheckpoint?.timestamp ?? entry.timestamp,
        ...propertiesWhen(pendingCheckpoint, () => ({ checkpoint: pendingCheckpoint })),
        ...propertiesWhen(pendingEntryId, () => ({ checkpointEntryId: pendingEntryId })),
      });
      pendingCheckpoint = undefined;
      pendingEntryId = undefined;
      continue;
    }
    if (entry.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY) continue;
    const checkpoint = parseCheckpoint(entry.data);
    if (!checkpoint) continue;
    pendingCheckpoint = checkpoint;
    pendingEntryId = entry.id;
  }
  return turns;
}

/** The shape the review extension consumes; only turns backed by a checkpoint. */
export type TurnCheckpoint = {
  checkpoint: FileCheckpoint;
  checkpointEntryId: string;
  conversationTargetId: string;
  userTurnIndex: number;
  label: string;
};

export function turnCheckpointsFromEntries(entries: readonly SessionEntry[]): TurnCheckpoint[] {
  return sessionTurnsFromEntries(entries).flatMap((turn) =>
    turn.checkpoint && turn.checkpointEntryId
      ? [
          {
            checkpoint: turn.checkpoint,
            checkpointEntryId: turn.checkpointEntryId,
            conversationTargetId: turn.entryId,
            userTurnIndex: turn.index,
            label: turn.label,
          },
        ]
      : [],
  );
}

/**
 * Attaches the code changes each turn produced.
 *
 * A turn's changes span its own checkpoint and the next captured state, which is
 * the next checkpointed turn or, for the newest one, the live working tree.
 */
export async function buildTurnTimeline(
  cwd: string,
  turns: readonly SessionTurn[],
  current: GitSnapshot | undefined,
): Promise<TurnTimelineItem[]> {
  const nextSnapshots: Array<GitSnapshot | undefined> = Array.from({ length: turns.length });
  let following = current;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    nextSnapshots[index] = following;
    following = turns[index]?.checkpoint ?? following;
  }

  return Promise.all(
    turns.map(async (turn, index) => {
      const next = nextSnapshots[index];
      if (!turn.checkpoint || !next) return { turn };
      const changes = await summarizeChanges(cwd, turn.checkpoint, next).catch(() => undefined);
      return changes ? { turn, changes } : { turn };
    }),
  );
}
