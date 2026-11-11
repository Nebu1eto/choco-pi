/**
 * Where a session's changes start, shared by `/diff` and `/review-assist
 * session` so both list the same files: the first file checkpoint anywhere in
 * the session file, so `/tree` navigation and compaction do not move it.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionTurnsFromEntries, turnCheckpointsFromEntries } from "../../checkpoints/turns.ts";
import { NO_SESSION_CHECKPOINT } from "./git/snapshot.ts";
import type { SessionBaselineChoice } from "./types.ts";

export type { SessionBaselineChoice } from "./types.ts";

/** Said when prompts ran but none recorded a checkpoint (checkpoints off or failing). */
export const SESSION_WITHOUT_CHECKPOINTS =
  "This session has prompts but no file checkpoint (file checkpoints are off or failed), so its changes cannot be told apart from older ones. /diff source uncommitted shows every uncommitted change.";

const LABEL_PROMPT_CHARS = 40;

/** A prompt flattened to one line of at most 40 characters, for turn labels. */
export function shortPrompt(prompt: string): string {
  const flat = prompt.replaceAll(/\s+/gu, " ").trim();
  return flat.length > LABEL_PROMPT_CHARS ? `${flat.slice(0, LABEL_PROMPT_CHARS - 1)}…` : flat;
}

/**
 * The session's baseline. A resumed session keeps its first checkpoint; a
 * fork starts from the first checkpoint it copied from its parent, or its own
 * first one when it copied none. `entries` is every entry of the session file
 * (`getEntries()`), in file order.
 */
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
