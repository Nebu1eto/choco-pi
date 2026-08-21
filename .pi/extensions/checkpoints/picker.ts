import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ChangeSummary } from "./git-snapshot.ts";
import type { TurnTimelineItem } from "./turns.ts";

/** What the picker can do with the focused turn. */
export type TurnAction =
  /** Move the conversation branch back to this turn; files are untouched. */
  | "rewind"
  /** Move the conversation back and restore files and the index to this turn. */
  | "rollback"
  /** Branch a new session from this turn; conversation and files are untouched. */
  | "fork";

export type PickerKey =
  | { kind: "move"; delta: number }
  | { kind: "jump"; position: "first" | "last" }
  | { kind: "act"; action: TurnAction }
  | { kind: "choose" }
  | { kind: "cancel" };

export const TURN_ACTION_LABELS = {
  rewind: "Rewind",
  rollback: "Rollback",
  fork: "Fork",
} satisfies Record<TurnAction, string>;

function printableKey(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data);
  if (kitty) return kitty.toLowerCase();
  if (data.length !== 1) return undefined;
  const code = data.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f ? data.toLowerCase() : undefined;
}

export function resolvePickerKey(data: string): PickerKey | undefined {
  if (matchesKey(data, "escape")) return { kind: "cancel" };
  if (matchesKey(data, "enter")) return { kind: "choose" };
  if (matchesKey(data, "up")) return { kind: "move", delta: -1 };
  if (matchesKey(data, "down")) return { kind: "move", delta: 1 };
  if (matchesKey(data, "pageUp")) return { kind: "move", delta: -5 };
  if (matchesKey(data, "pageDown")) return { kind: "move", delta: 5 };
  if (matchesKey(data, "home")) return { kind: "jump", position: "first" };
  if (matchesKey(data, "end")) return { kind: "jump", position: "last" };

  switch (printableKey(data)) {
    case "k":
      return { kind: "move", delta: -1 };
    case "j":
      return { kind: "move", delta: 1 };
    case "r":
      return { kind: "act", action: "rewind" };
    case "b":
      return { kind: "act", action: "rollback" };
    case "f":
      return { kind: "act", action: "fork" };
    default:
      return undefined;
  }
}

export function changeSummaryText(changes: ChangeSummary | undefined, theme: Theme): string {
  if (!changes) return theme.fg("dim", "No checkpoint");
  if (changes.files === 0) return theme.fg("dim", "No code changes");
  return [
    theme.fg("dim", `${changes.files} file${changes.files === 1 ? "" : "s"}`),
    theme.fg("toolDiffAdded", `+${changes.added}`),
    theme.fg("toolDiffRemoved", `-${changes.deleted}`),
  ].join(" ");
}

export type PickerView = {
  items: readonly TurnTimelineItem[];
  selectedIndex: number;
  width: number;
  theme: Theme;
  /** Inline feedback, such as why rollback is unavailable for this turn. */
  notice?: string;
};

const VISIBLE_TURNS = 7;

export function renderCheckpointPicker(view: PickerView): string[] {
  const { items, selectedIndex, width, theme } = view;
  const innerWidth = Math.max(20, width - 4);
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(VISIBLE_TURNS / 2), items.length - VISIBLE_TURNS),
  );
  const end = Math.min(items.length, start + VISIBLE_TURNS);

  const lines = [
    theme.fg("accent", theme.bold("Checkpoints")),
    "",
    "Pick the turn to act on, then choose rewind, rollback, or fork.",
    "",
  ];

  if (start > 0) lines.push(theme.fg("dim", `  ↑ ${start} earlier turns`), "");
  for (let index = start; index < end; index += 1) {
    const item = items[index];
    if (!item) continue;
    const selected = index === selectedIndex;
    const prefix = selected ? theme.fg("accent", "❯") : " ";
    const label = selected ? theme.fg("accent", item.turn.label) : item.turn.label;
    const timestamp = new Date(item.turn.timestamp).toLocaleString();
    lines.push(
      truncateToWidth(`${prefix} ${label}`, innerWidth),
      truncateToWidth(
        `  Turn ${item.turn.index} · ${timestamp} · ${changeSummaryText(item.changes, theme)}`,
        innerWidth,
      ),
      "",
    );
  }
  if (end < items.length) lines.push(theme.fg("dim", `  ↓ ${items.length - end} later turns`), "");

  if (view.notice) lines.push(theme.fg("warning", view.notice), "");
  lines.push(
    theme.fg(
      "dim",
      theme.italic("↑↓ navigate · r rewind · b rollback · f fork · Enter choose · Esc cancel"),
    ),
  );

  const top = theme.fg("border", `┌${"─".repeat(Math.max(1, width - 2))}┐`);
  const bottom = theme.fg("border", `└${"─".repeat(Math.max(1, width - 2))}┘`);
  return [
    top,
    ...lines.map((line) => {
      const clipped = truncateToWidth(line, innerWidth);
      return `${theme.fg("border", "│")} ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${theme.fg("border", "│")}`;
    }),
    bottom,
  ];
}
