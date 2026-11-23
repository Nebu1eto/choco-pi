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

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function cutName(name: string, width: number): string {
  const total = visibleWidth(name);
  if (total <= width) return name;
  const extension = extensionOf(name);
  const extensionWidth = visibleWidth(extension);
  if (extensionWidth === 0 || extensionWidth + 2 > width) return middleTruncate(name, width);
  const available = width - 1;
  let tail = Math.floor(available / 2);
  if (tail < extensionWidth) tail = extensionWidth;
  const head = available - tail;
  const start = sliceByColumn(name, 0, head, true);
  const end = sliceByColumn(name, total - tail, tail, true);
  return `${start}…${end}`;
}

export function fitPath(path: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(path) <= width) return path;
  const segments = path.split("/");
  const name = segments.at(-1) ?? path;
  if (segments.length >= 3) {
    const first = segments[0] ?? "";
    const directories = segments.slice(1, -1);
    for (let kept = directories.length - 1; kept >= 0; kept -= 1) {
      const tail = [...directories.slice(directories.length - kept), name].join("/");
      const candidate = `${first}/…/${tail}`;
      if (visibleWidth(candidate) <= width) return candidate;
    }
  }
  if (segments.length >= 2) {
    const short = `…/${name}`;
    if (visibleWidth(short) <= width) return short;
  }
  return cutName(name, width);
}

export function fitRename(oldPath: string, path: string, width: number): string {
  if (width <= 0) return "";
  const full = `${oldPath} → ${path}`;
  if (visibleWidth(full) <= width) return full;
  const oldName = oldPath.split("/").at(-1) ?? oldPath;
  const named = `${oldName} → ${path}`;
  if (visibleWidth(named) <= width) return named;
  const lead = `${oldName} → `;
  const name = path.split("/").at(-1) ?? path;
  const room = width - visibleWidth(lead);
  if (room >= visibleWidth(name)) return `${lead}${fitPath(path, room)}`;
  const arrow = " → ";
  if (width < 12) return fitPath(path, width);
  const oldRoom = Math.max(2, Math.floor((width - arrow.length) / 3));
  const oldPart = cutName(oldName, oldRoom);
  return `${oldPart}${arrow}${fitPath(path, width - visibleWidth(oldPart) - arrow.length)}`;
}

export function fittedFilePath(file: FileSummary, width: number): string {
  return file.oldPath && file.oldPath !== file.path
    ? fitRename(safe(file.oldPath), safe(file.path), width)
    : fitPath(safe(file.path), width);
}

export function terminalPath(file: FileSummary): string {
  return file.oldPath && file.oldPath !== file.path
    ? `${safe(file.oldPath)} → ${safe(file.path)}`
    : safe(file.path);
}

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

export type RowBadge = { text: string; color: PaneColor };

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
  const path = fittedFilePath(file, pathWidth);
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
