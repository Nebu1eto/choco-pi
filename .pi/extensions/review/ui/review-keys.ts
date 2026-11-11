/**
 * The full-screen review's keys. Shared concepts use the pane's bindings
 * (`PANE_KEYS`); `[`/`]` move by hunk here, as resizing has no meaning in a
 * full-screen view. Review-only keys are handled by the host before the
 * shared view sees a key; `REVIEW_ONLY_KEYS` lists them so no key means two things.
 */
import type { ChangesKeyTable } from "../../lib/changes/view/keys.ts";

export const REVIEW_KEYS = {
  extendDown: [{ key: "shift+down" }],
  extendUp: [{ key: "shift+up" }],
  down: ["j", { key: "down" }],
  up: ["k", { key: "up" }],
  fileDown: [],
  fileUp: [],
  toggle: [{ key: "enter" }, { key: "space" }],
  pageDown: [{ key: "pageDown" }],
  pageUp: [{ key: "pageUp" }],
  first: ["g"],
  last: ["G"],
  wider: [],
  narrower: [],
  refresh: ["r"],
  help: ["?"],
  nextHunk: ["n", "]"],
  previousHunk: ["N", "["],
  nextFinding: ["f"],
  previousFinding: ["F"],
  ask: [],
  note: [],
  sendNotes: [],
  cycleSource: [],
  review: [],
  reveal: ["v"],
  back: [{ key: "escape" }, "q"],
} as const satisfies ChangesKeyTable;

/** The review's split-view toggle; free in both hosts (the pane binds nothing to it). */
export const SPLIT_TOGGLE_KEY = "|";

/** Literal keys the full-screen host handles itself (arrows, Tab and Ctrl+O aside). */
export const REVIEW_ONLY_KEYS: readonly string[] = [
  "c",
  "a",
  "e",
  "E",
  "m",
  "S",
  "/",
  ">",
  "<",
  "+",
  "-",
  SPLIT_TOGGLE_KEY,
  "t",
];

/** Shown under the header while the review has focus. */
export const REVIEW_KEY_HINT =
  "j/k line · ⏎/space fold · n/N or [/] hunk · g/G first/last · r refresh · f/F finding · v show sensitive · ? help";

/** The `?` key list, one entry per line. */
export const REVIEW_HELP_LINES: readonly string[] = [
  "j/k ↑/↓   move by line             g/G       first/last line",
  "⏎/space   fold or unfold the hunk; on a file row, expand or collapse the file",
  "n/N [/]   next/previous hunk       ←/→       previous/next file",
  "Shift+↑/↓ select lines             PgUp/PgDn page",
  "c         comment on the selected lines      m   mark the hunk reviewed",
  "a         ask in a side chat (the diff stays out of the main conversation)",
  "/         search changed lines     >/<       next/previous match",
  "+/-       more/less context        |         split or unified layout",
  "v         show a sensitive file's contents (this review only, not saved)",
  "r         read the changes again   f/F       next/previous review finding",
  "e/E       open the file/project in the editor",
  "S         finish                   q/esc     save and leave    ? close this list",
];
