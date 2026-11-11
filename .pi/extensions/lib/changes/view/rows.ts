/**
 * One file row and the short texts around it, shared by the changes pane
 * (`/diff`) and the interactive review (`/review-assist`). The pane's layout
 * is the reference: `▾ M path  badges  +3 -1`, with a middle-truncated path.
 *
 * Pure: every function takes its data and width as arguments. Untrusted names
 * are sanitised here, once, so callers pass raw paths.
 */
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FileBody, FileStatus, FileSummary } from "../git/model.ts";
import type { DiffStyler } from "../render/diff-render.ts";
import { sanitizeTerminalText as safe } from "../terminal-text.ts";

export type PaneColor =
  | "accent"
  | "borderMuted"
  | "dim"
  | "muted"
  | "toolDiffAdded"
  | "toolDiffRemoved"
  | "toolDiffContext"
  | "warning"
  | "error"
  | "success"
  | "text";

/** Pi's `Theme` satisfies this; tests pass `plainPaneStyler`. */
export type PaneStyler = Omit<DiffStyler, "fg"> & {
  fg(color: PaneColor, text: string): string;
  bold(text: string): string;
};

export const plainPaneStyler: PaneStyler = {
  fg: (_color, text) => text,
  bold: (text) => text,
  inverse: (text) => text,
};

const STATUS_LETTERS = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "?",
  conflicted: "U",
  "type-changed": "T",
} satisfies Record<FileStatus, string>;

export function statusLetter(status: FileStatus): string {
  return STATUS_LETTERS[status];
}

/** Shorten `text` to `width` columns by replacing its middle with an ellipsis. */
export function middleTruncate(text: string, width: number): string {
  if (width <= 0) return "";
  const total = visibleWidth(text);
  if (total <= width) return text;
  if (width === 1) return "…";
  const head = Math.ceil((width - 1) / 2);
  const tail = width - 1 - head;
  const start = sliceByColumn(text, 0, head, true);
  const end = tail > 0 ? sliceByColumn(text, total - tail, tail, true) : "";
  return `${start}…${end}`;
}

export function displayPath(file: FileSummary): string {
  return file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
}

/** {@link displayPath} with each name made terminal-safe (the arrow is ours). */
export function terminalPath(file: FileSummary): string {
  return file.oldPath && file.oldPath !== file.path
    ? `${safe(file.oldPath)} → ${safe(file.path)}`
    : safe(file.path);
}

/** `+12 -3`, `bin`, or empty when git did not count lines. */
export function countsText(file: FileSummary): string {
  if (file.binary) return "bin";
  if (file.additions === null && file.deletions === null) return "";
  return `+${file.additions ?? 0} -${file.deletions ?? 0}`;
}

function styledCounts(file: FileSummary, styler: PaneStyler): string {
  if (file.binary) return styler.fg("dim", "bin");
  if (file.additions === null && file.deletions === null) return "";
  return `${styler.fg("toolDiffAdded", `+${file.additions ?? 0}`)} ${styler.fg("toolDiffRemoved", `-${file.deletions ?? 0}`)}`;
}

/** A short marker after the path, such as a finding or note count. */
export type RowBadge = { text: string; color: PaneColor };

/**
 * One file row without the selection marker column:
 * `▸ M path/to/file.ts  ⚑2 ✎1  +3 -1`, with the path middle-truncated so the
 * badges and counts stay right-aligned in `width` columns.
 */
export function fileRow(
  file: FileSummary,
  expanded: boolean,
  width: number,
  styler: PaneStyler,
  badges: readonly RowBadge[] = [],
): string {
  const prefix = `${expanded ? "▾" : "▸"} ${statusLetter(file.status)} `;
  const counts = countsText(file);
  const countsWidth = counts.length > 0 ? visibleWidth(counts) + 1 : 0;
  const badgeText = badges.map((badge) => badge.text).join(" ");
  const badgeWidth = badgeText.length > 0 ? visibleWidth(badgeText) + 1 : 0;
  const pathWidth = Math.max(0, width - visibleWidth(prefix) - countsWidth - badgeWidth);
  const path = middleTruncate(terminalPath(file), pathWidth);
  const padding = " ".repeat(Math.max(0, pathWidth - visibleWidth(path)));
  const letterColor: PaneColor =
    file.status === "deleted"
      ? "toolDiffRemoved"
      : file.status === "added" || file.status === "untracked"
        ? "toolDiffAdded"
        : file.status === "conflicted"
          ? "error"
          : "accent";
  const line = [
    styler.fg("dim", expanded ? "▾" : "▸"),
    " ",
    styler.fg(letterColor, statusLetter(file.status)),
    " ",
    path,
    padding,
    badgeWidth > 0 ? ` ${badges.map((badge) => styler.fg(badge.color, badge.text)).join(" ")}` : "",
    countsWidth > 0 ? ` ${styledCounts(file, styler)}` : "",
  ].join("");
  return truncateToWidth(line, width, "…");
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** One explanatory line for a file body that has no hunks to show. */
export function bodyNotice(body: FileBody): string | undefined {
  switch (body.kind) {
    case "text":
      return body.file.hunks.length === 0 ? "No textual changes" : undefined;
    case "binary":
      return "Binary file not shown";
    case "too-large":
      return `Diff too large to show (${formatBytes(body.bytes)}, limit ${formatBytes(body.limit)})`;
    case "unreadable":
      return `Cannot read diff: ${safe(body.reason)}`;
    case "gone":
      return "No longer changed";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
