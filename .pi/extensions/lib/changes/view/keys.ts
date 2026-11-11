/**
 * Which keys run which changes-view action. Each host passes its own table;
 * `PANE_KEYS` is the /diff pane's, and the baseline for shared concepts.
 */
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { isString } from "../../runtime-values.ts";

export type ChangesAction =
  /** Line cursor: extend the selection one line (Shift+↓ / Shift+↑). */
  | "extendDown"
  | "extendUp"
  | "down"
  | "up"
  /** The next or previous file row, whatever the cursor is on (the pane's j/k). */
  | "fileDown"
  | "fileUp"
  | "toggle"
  | "pageDown"
  | "pageUp"
  | "first"
  | "last"
  | "wider"
  | "narrower"
  | "refresh"
  | "help"
  | "nextHunk"
  | "previousHunk"
  | "nextFinding"
  | "previousFinding"
  | "ask"
  | "note"
  | "sendNotes"
  | "cycleSource"
  /** One turn's changes alone: the turn before or after the one shown (the pane's ←/→). */
  | "olderTurn"
  | "newerTurn"
  | "review"
  /** Show a hidden sensitive file's contents at once, for this view only. */
  | "reveal"
  | "back";

/** A literal character, or a named key matched with pi-tui's `matchesKey`. */
export type KeyBinding = string | { key: KeyId };

export type ChangesKeyTable = Readonly<Record<ChangesAction, readonly KeyBinding[]>>;

/**
 * The pane's bindings. j/k step through files and ↑/↓ through the lines of
 * open files; Tab and Shift+← join Esc and q for going back to the editor.
 */
export const PANE_KEYS = {
  extendDown: [{ key: "shift+down" }],
  extendUp: [{ key: "shift+up" }],
  down: [{ key: "down" }],
  up: [{ key: "up" }],
  fileDown: ["j"],
  fileUp: ["k"],
  toggle: [{ key: "enter" }, { key: "space" }],
  pageDown: [{ key: "pageDown" }],
  pageUp: [{ key: "pageUp" }],
  first: ["g"],
  last: ["G"],
  wider: ["["],
  narrower: ["]"],
  refresh: ["r"],
  help: ["?"],
  nextHunk: ["n"],
  previousHunk: ["N"],
  nextFinding: ["f"],
  previousFinding: ["F"],
  ask: ["a"],
  note: ["c"],
  sendNotes: ["C"],
  cycleSource: ["s"],
  olderTurn: [{ key: "left" }],
  newerTurn: [{ key: "right" }],
  review: ["R"],
  reveal: ["v"],
  back: [{ key: "escape" }, "q", { key: "tab" }, { key: "shift+left" }],
} as const satisfies ChangesKeyTable;

/** Every action, in matching order: the first action bound to `data` wins. */
export const CHANGES_ACTIONS: readonly ChangesAction[] = [
  "extendDown",
  "extendUp",
  "down",
  "up",
  "fileDown",
  "fileUp",
  "toggle",
  "pageDown",
  "pageUp",
  "first",
  "last",
  "wider",
  "narrower",
  "refresh",
  "help",
  "nextHunk",
  "previousHunk",
  "nextFinding",
  "previousFinding",
  "ask",
  "note",
  "sendNotes",
  "cycleSource",
  "olderTurn",
  "newerTurn",
  "review",
  "reveal",
  "back",
];

function matches(data: string, binding: KeyBinding): boolean {
  return isString(binding) ? data === binding : matchesKey(data, binding.key);
}

/** The action `data` runs under `table`, if any. */
export function actionFor(table: ChangesKeyTable, data: string): ChangesAction | undefined {
  return CHANGES_ACTIONS.find((action) => table[action].some((binding) => matches(data, binding)));
}
