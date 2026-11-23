import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionTurnsFromEntries } from "../../checkpoints/turns.ts";
import type { DiffSource } from "../../lib/changes/git/model.ts";
import { shortPrompt } from "../../lib/changes/session-baseline.ts";
import type { SessionBaselineChoice, TurnTreeProvider } from "../../lib/changes/types.ts";

export {
  SESSION_WITHOUT_CHECKPOINTS,
  sessionBaselineOf,
} from "../../lib/changes/session-baseline.ts";

export type TurnCheckpointInfo = {
  turn: number;
  tree: string;
  checkpointTurnIndex: number;
  prompt: string;
  through?: { turn: number; prompt: string };
};

export function turnCheckpointsOf(entries: readonly SessionEntry[]): TurnCheckpointInfo[] {
  const turns: TurnCheckpointInfo[] = [];
  for (const turn of sessionTurnsFromEntries(entries)) {
    if (turn.checkpoint && turn.checkpointEntryId) {
      turns.push({
        turn: turn.index,
        tree: turn.checkpoint.worktreeTree,
        checkpointTurnIndex: turn.checkpoint.turnIndex,
        prompt: turn.label,
      });
      continue;
    }
    const covering = turns.at(-1);
    if (covering) covering.through = { turn: turn.index, prompt: turn.label };
  }
  return turns;
}

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

export function turnSource(turn: TurnCheckpointInfo): DiffSource {
  return {
    kind: "since-checkpoint",
    checkpointId: turn.tree,
    label: `turn ${turn.turn} (${shortPrompt(turn.prompt)})`,
  };
}

export function turnOnlySource(
  turns: readonly TurnCheckpointInfo[],
  index: number,
): DiffSource | undefined {
  const turn = turns[index];
  if (!turn) return undefined;
  const label = turn.through
    ? `turns ${turn.turn}–${turn.through.turn} (${shortPrompt(turn.through.prompt)})`
    : `turn ${turn.turn} (${shortPrompt(turn.prompt)})`;
  const next = turns[index + 1];
  return next
    ? { kind: "range", base: turn.tree, head: next.tree, label, turnOnly: true }
    : { kind: "since-checkpoint", checkpointId: turn.tree, label, turnOnly: true };
}

export type TurnChoice =
  | { kind: "found"; turn: TurnCheckpointInfo }
  | { kind: "none"; message: string };

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
