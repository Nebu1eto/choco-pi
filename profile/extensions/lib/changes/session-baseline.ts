import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionTurnsFromEntries, turnCheckpointsFromEntries } from "../../checkpoints/turns.ts";
import { NO_SESSION_CHECKPOINT } from "./git/snapshot.ts";
import type { SessionBaselineChoice } from "./types.ts";

export type { SessionBaselineChoice } from "./types.ts";

export const SESSION_WITHOUT_CHECKPOINTS =
  "This session has prompts but no file checkpoint (file checkpoints are off or failed), so its changes cannot be told apart from older ones. /diff source uncommitted shows every uncommitted change.";

const LABEL_PROMPT_CHARS = 40;

export function shortPrompt(prompt: string): string {
  const flat = prompt.replaceAll(/\s+/gu, " ").trim();
  return flat.length > LABEL_PROMPT_CHARS ? `${flat.slice(0, LABEL_PROMPT_CHARS - 1)}…` : flat;
}

export function sessionBaselineOf(entries: readonly SessionEntry[]): SessionBaselineChoice {
  const first = turnCheckpointsFromEntries(entries)[0];
  if (first) {
    return {
      kind: "checkpoint",
      tree: first.checkpoint.worktreeTree,
      label: `turn ${first.userTurnIndex} (${shortPrompt(first.label)})`,
    };
  }
  const prompts = sessionTurnsFromEntries(entries).length;
  return {
    kind: "none",
    reason: prompts > 0 ? SESSION_WITHOUT_CHECKPOINTS : NO_SESSION_CHECKPOINT,
  };
}
