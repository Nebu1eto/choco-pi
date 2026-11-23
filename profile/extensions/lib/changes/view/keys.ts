import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { isString } from "../../runtime-values.ts";

export type ChangesAction =
  | "extendDown"
  | "extendUp"
  | "down"
  | "up"
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
  | "copy"
  | "note"
  | "cycleSource"
  | "olderTurn"
  | "newerTurn"
  | "review"
  | "reveal"
  | "toggleItems"
  | "back";

export type KeyBinding = string | { key: KeyId };

type OptionalAction = "toggleItems";

export type ChangesKeyTable = Readonly<
  Record<Exclude<ChangesAction, OptionalAction>, readonly KeyBinding[]>
> &
  Readonly<Partial<Record<OptionalAction, readonly KeyBinding[]>>>;

export function copyKeyFor(platform: NodeJS.Platform): { key: KeyId; label: string } {
  return platform === "darwin"
    ? { key: "super+c", label: "Cmd+C" }
    : { key: "ctrl+c", label: "Ctrl+C" };
}

export const COPY_KEY = copyKeyFor(process.platform);

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
  cycleSource: ["s"],
  olderTurn: [{ key: "left" }],
  newerTurn: [{ key: "right" }],
  review: ["R"],
  reveal: ["v"],
  toggleItems: ["e"],
  back: [{ key: "escape" }, "q", { key: "tab" }, { key: "shift+left" }],
} as const satisfies ChangesKeyTable;

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
  "cycleSource",
  "olderTurn",
  "newerTurn",
  "review",
  "reveal",
  "toggleItems",
  "back",
];

function matches(data: string, binding: KeyBinding): boolean {
  return isString(binding) ? data === binding : matchesKey(data, binding.key);
}

export function actionFor(table: ChangesKeyTable, data: string): ChangesAction | undefined {
  return CHANGES_ACTIONS.find((action) =>
    (table[action] ?? []).some((binding) => matches(data, binding)),
  );
}
