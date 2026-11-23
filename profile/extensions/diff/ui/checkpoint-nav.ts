import type { DefaultBaseChoice } from "../../lib/changes/git/default-base.ts";
import type { DiffSource } from "../../lib/changes/git/model.ts";
import { sourceKey } from "../../lib/changes/git/snapshot.ts";
import {
  chooseTurn,
  turnOnlySource,
  turnSource,
  type TurnCheckpointInfo,
} from "../core/checkpoints.ts";
import { FALLBACK_BRANCH_BASE } from "./command.ts";
import { sourceLabel } from "./format.ts";
import {
  type Session,
  type DiffPaneController,
  type BranchChoice,
  SESSION_SOURCE,
} from "./pane-state.ts";
import { ensureStore, say, saySource } from "./pane-session.ts";
import { userOpen } from "./host-binding.ts";

export function applySource(pane: DiffPaneController, session: Session, source: DiffSource): void {
  if (source.kind === "branch-base") session.branchBase = source.base;
  session.source = source;
  delete session.turnOnly;
  session.sourceGeneration += 1;
  const store = ensureStore(pane, session);
  store.setSource(source);
  if (session.view) {
    session.view.source = source;
    session.view.selectedHunk = undefined;
  }
}

export function resetToSessionSource(pane: DiffPaneController, session: Session): void {
  if (session.source.kind === "session") return;
  applySource(pane, session, SESSION_SOURCE);
}

export function turnsOf(pane: DiffPaneController, session: Session): readonly TurnCheckpointInfo[] {
  try {
    return pane.deps.listTurns?.(session.ctx) ?? [];
  } catch {
    return [];
  }
}

export async function branchSource(
  pane: DiffPaneController,
  session: Session,
  base: string | undefined,
): Promise<BranchChoice> {
  if (base !== undefined) return { kind: "found", source: { kind: "branch-base", base } };
  const known = session.branchBase;
  if (known !== undefined) return { kind: "found", source: { kind: "branch-base", base: known } };
  const resolve = pane.deps.defaultBranchBase;
  if (!resolve) {
    return { kind: "found", source: { kind: "branch-base", base: FALLBACK_BRANCH_BASE } };
  }
  const generation = session.sourceGeneration;
  let choice: DefaultBaseChoice;
  let detail: string | undefined;
  try {
    choice = await resolve(session.ctx.cwd);
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
    choice = { kind: "none", message: `Cannot find the default base branch: ${detail}` };
  }
  if (!session.alive || generation !== session.sourceGeneration) return { kind: "stale" };
  if (choice.kind === "none") {
    return detail === undefined
      ? { kind: "none", message: choice.message }
      : { kind: "none", message: choice.message, detail };
  }
  session.branchBase = choice.base;
  return { kind: "found", source: { kind: "branch-base", base: choice.base } };
}

export async function showSource(
  pane: DiffPaneController,
  session: Session,
  source: DiffSource,
): Promise<void> {
  applySource(pane, session, source);
  if (session.host) {
    saySource(pane, session, source);
    return;
  }
  if (await userOpen(pane, session, { keepSource: true })) {
    saySource(pane, session, source);
    return;
  }
  if (session.alive) resetToSessionSource(pane, session);
}

export async function sourceBranch(
  pane: DiffPaneController,
  session: Session,
  base: string | undefined,
): Promise<void> {
  const choice = await branchSource(pane, session, base);
  if (choice.kind === "stale") return;
  if (choice.kind === "none") {
    say(pane, session, `${choice.message} The diff source is unchanged.`, "warning");
    return;
  }
  await showSource(pane, session, choice.source);
}

export async function sourceTurn(
  pane: DiffPaneController,
  session: Session,
  turn: number | undefined,
): Promise<void> {
  const choice = chooseTurn(turnsOf(pane, session), turn);
  if (choice.kind === "none") {
    say(pane, session, choice.message, "warning");
    return;
  }
  await showSource(pane, session, turnSource(choice.turn));
}

export async function cycleSource(pane: DiffPaneController, session: Session): Promise<void> {
  if (session.turnOnly !== undefined) {
    applySource(pane, session, SESSION_SOURCE);
    saySource(pane, session, SESSION_SOURCE);
    return;
  }
  const now = session.source;
  let next: DiffSource = SESSION_SOURCE;
  let note = "";
  if (now.kind === "session") {
    next = { kind: "uncommitted" };
  } else if (now.kind === "uncommitted") {
    const choice = chooseTurn(turnsOf(pane, session), undefined);
    if (choice.kind === "found") next = turnSource(choice.turn);
    else {
      note = "No turn checkpoint exists in this session yet, so the turn source was skipped. ";
      const branch = await branchSource(pane, session, undefined);
      if (branch.kind === "stale") return;
      if (branch.kind === "found") next = branch.source;
      else note += `${branch.message} `;
    }
  } else if (now.kind === "since-checkpoint") {
    const branch = await branchSource(pane, session, undefined);
    if (branch.kind === "stale") return;
    if (branch.kind === "found") next = branch.source;
    else note = `${branch.message} `;
  }
  applySource(pane, session, next);
  if (note) say(pane, session, `${note}Diff source: ${sourceLabel(next)}.`, "warning");
  else saySource(pane, session, next);
}

export function showTurnOnly(
  pane: DiffPaneController,
  session: Session,
  turns: readonly TurnCheckpointInfo[],
  index: number,
): boolean {
  const turn = turns[index];
  const source = turnOnlySource(turns, index);
  if (!turn || !source) return false;
  applySource(pane, session, source);
  session.turnOnly = turn.turn;
  return true;
}

export function stepTurn(pane: DiffPaneController, session: Session, delta: -1 | 1): void {
  const turns = turnsOf(pane, session);
  const shown =
    session.turnOnly === undefined ? -1 : turns.findIndex((turn) => turn.turn === session.turnOnly);
  const index = (shown < 0 ? turns.length : shown) + delta;
  if (index >= turns.length) {
    if (session.source.kind === "session") {
      say(pane, session, "Every change of the session is shown; ← shows its newest turn alone.");
      return;
    }
    applySource(pane, session, SESSION_SOURCE);
    saySource(pane, session, SESSION_SOURCE);
    return;
  }
  if (turns.length === 0) {
    say(
      pane,
      session,
      "No turn of this session has a file checkpoint, so no turn can be shown alone.",
    );
    return;
  }
  if (!showTurnOnly(pane, session, turns, index)) {
    say(pane, session, "This is the session's first turn with a file checkpoint.");
    return;
  }
  say(
    pane,
    session,
    `Diff source: ${sourceLabel(session.source)}, ${index + 1} of ${turns.length} (← older, → newer).`,
  );
}

export function followTurn(pane: DiffPaneController, session: Session): void {
  if (session.turnOnly === undefined) return;
  const turns = turnsOf(pane, session);
  const index = turns.findIndex((turn) => turn.turn === session.turnOnly);
  const source = turnOnlySource(turns, index);
  if (!source) {
    applySource(pane, session, SESSION_SOURCE);
    say(
      pane,
      session,
      "The turn that was shown is not on this branch any more. Diff source: Session changes.",
    );
    return;
  }
  if (sourceKey(source) !== sourceKey(session.source)) showTurnOnly(pane, session, turns, index);
}
