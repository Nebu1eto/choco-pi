import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  isNumber,
  isObject,
  isString,
  propertiesWhen,
  type RuntimeValue,
} from "../lib/runtime-values.ts";
import {
  summarizeChanges,
  type ChangeSummary,
  type CheckpointAnchors,
  type GitSnapshot,
} from "./git-snapshot.ts";

export const CHECKPOINT_ENTRY = "choco-pi:file-checkpoint";
export const RESTORE_ENTRY = "choco-pi:file-checkpoint-restored";

export type FileCheckpoint = GitSnapshot & {
  version: 1 | 2;
  timestamp: string;
  turnIndex: number;
  label: string;
};

export type SessionTurn = {
  entryId: string;
  index: number;
  label: string;
  timestamp: string;
  checkpoint?: FileCheckpoint;
  checkpointEntryId?: string;
};

export type TurnTimelineItem = {
  turn: SessionTurn;
  changes?: ChangeSummary;
};

function textParts(part: RuntimeValue): string[] {
  if (!isObject(part) || part === null) return [];
  if (!("type" in part) || part.type !== "text") return [];
  return "text" in part && isString(part.text) ? [part.text] : [];
}

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
  if (value.label === "Before rewind") return undefined;
  if (value.version === 1 && !isString(value.indexTree)) return undefined;
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  return value as FileCheckpoint;
}

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

export function checkpointAnchorsFromEntries(entries: readonly SessionEntry[]): CheckpointAnchors {
  const commits = new Set<string>();
  const trees = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY) continue;
    const checkpoint = parseCheckpoint(entry.data);
    if (!checkpoint) continue;
    if (checkpoint.commit) {
      commits.add(checkpoint.commit);
      continue;
    }
    trees.add(checkpoint.worktreeTree);
    if (checkpoint.indexTree) trees.add(checkpoint.indexTree);
  }
  return { commits: [...commits], trees: [...trees] };
}

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
