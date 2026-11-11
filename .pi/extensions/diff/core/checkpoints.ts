/**
 * Turn checkpoints for the "since a turn" source.
 *
 * choco-pi's file-checkpoints extension appends one checkpoint entry before
 * each user turn; `turnCheckpointsFromEntries` reads them from the active
 * branch. The store resolves a `since-checkpoint` source by the checkpoint's
 * worktree tree, which is unique per captured state (a reused snapshot appends
 * no entry), so the tree is the checkpoint id.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { turnCheckpointsFromEntries } from "../../checkpoints/turns.ts";
import type { DiffSource } from "../../lib/changes/git/model.ts";
import { shortPrompt } from "../../lib/changes/session-baseline.ts";
import type { SessionBaselineChoice, TurnTreeProvider } from "../../lib/changes/types.ts";

export {
  SESSION_WITHOUT_CHECKPOINTS,
  sessionBaselineOf,
} from "../../lib/changes/session-baseline.ts";

/** One user turn that has a checkpoint, oldest first. */
export type TurnCheckpointInfo = {
  /** 1-based position among the user turns of the active branch, as in the checkpoint picker. */
  turn: number;
  /** Worktree tree captured before the turn started. */
  tree: string;
  /** The checkpoint's own turn index, as recorded by file-checkpoints. */
  checkpointTurnIndex: number;
  /** One-line prompt summary. */
  prompt: string;
};

export function turnCheckpointsOf(entries: readonly SessionEntry[]): TurnCheckpointInfo[] {
  return turnCheckpointsFromEntries(entries).map((turn) => ({
    turn: turn.userTurnIndex,
    tree: turn.checkpoint.worktreeTree,
    checkpointTurnIndex: turn.checkpoint.turnIndex,
    prompt: turn.label,
  }));
}

/** The provider the store uses to resolve a checkpoint id to its tree and the session baseline. */
export function createTurnCheckpointProvider(
  turns: () => readonly TurnCheckpointInfo[],
  baseline?: () => SessionBaselineChoice,
): TurnTreeProvider {
  const provider: TurnTreeProvider = {
    listTurns: async () =>
      turns().map((turn) => ({
        turnIndex: turn.checkpointTurnIndex,
        tree: turn.tree,
        label: `turn ${turn.turn}`,
      })),
  };
  if (baseline) provider.sessionBaseline = async () => baseline();
  return provider;
}

/** `{ kind: "since-checkpoint" }` for one turn; the label names the turn and its prompt. */
export function turnSource(turn: TurnCheckpointInfo): DiffSource {
  return {
    kind: "since-checkpoint",
    checkpointId: turn.tree,
    label: `turn ${turn.turn} (${shortPrompt(turn.prompt)})`,
  };
}

export type TurnChoice =
  | { kind: "found"; turn: TurnCheckpointInfo }
  | { kind: "none"; message: string };

/** The requested turn, or the latest one with a checkpoint when `turn` is omitted. */
export function chooseTurn(
  turns: readonly TurnCheckpointInfo[],
  turn: number | undefined,
): TurnChoice {
  if (turns.length === 0) {
    return {
      kind: "none",
      message: "No turn checkpoint exists in this session yet; the diff source is unchanged.",
    };
  }
  if (turn === undefined) {
    const latest = turns.at(-1);
    return latest
      ? { kind: "found", turn: latest }
      : { kind: "none", message: "No turn checkpoint exists in this session yet." };
  }
  const match = turns.find((candidate) => candidate.turn === turn);
  if (match) return { kind: "found", turn: match };
  const available = turns.map((candidate) => candidate.turn).join(", ");
  return {
    kind: "none",
    message: `Turn ${turn} has no checkpoint (turns with one: ${available}); the diff source is unchanged.`,
  };
}
