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
  /** Copy the cursor's lines, or its hunk, to the clipboard ({@link COPY_KEY}). */
  | "copy"
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
 * The key that copies, by platform: Cmd+C on macOS, where Ctrl+C is the
 * interrupt key, and Ctrl+C elsewhere. Cmd+C reaches a program only from a
 * terminal that speaks the Kitty keyboard protocol and does not keep the key
 * for its own copy command.
 */
export function copyKeyFor(platform: NodeJS.Platform): { key: KeyId; label: string } {
  return platform === "darwin"
    ? { key: "super+c", label: "Cmd+C" }
    : { key: "ctrl+c", label: "Ctrl+C" };
}

export const COPY_KEY = copyKeyFor(process.platform);

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
  copy: [{ key: COPY_KEY.key }],
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
  "copy",
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
