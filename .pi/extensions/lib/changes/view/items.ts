/**
 * Recorded review findings and `/review-assist` comments as items in a
 * file's body: where each one goes, which lines of the file are quoted around
 * the ones outside every hunk, and the rows each draws open or closed.
 *
 * Pure: the view passes the displayed hunks and its own state; nothing here
 * reads files or holds host state. Every recorded string is made
 * terminal-safe here before it is drawn.
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RecordedFinding } from "../findings.ts";
import { MAX_EXCERPT_LINES } from "../git/model.ts";
import { sanitizeTerminalText as safe } from "../terminal-text.ts";
import type { DiffFile, DiffHunk, DiffSide } from "../types.ts";
import { BODY_INDENT } from "./body-block.ts";
import type { ItemPlace } from "./line-cursor.ts";
import type { PaneColor, PaneStyler } from "./rows.ts";

/** Lines quoted above a finding's first line and below its last. */
export const EXCERPT_RADIUS = 2;

/** Where a comment is in the diff the view shows. */
export type CommentPlacement =
  | { status: "placed"; hunkId: string; side: DiffSide; line: number; startLine: number }
  | { status: "outdated"; message: string };

/** A `/review-assist` comment as the view shows it; read-only. */
export type PaneComment = {
  /** Unique among every comment the view is given. */
  id: string;
  path: string;
  side: DiffSide;
  line: number;
  startLine?: number;
  body: string;
  /** Which review it belongs to, such as "session review". */
  label: string;
  /** Where its text is in `file` now (the file as displayed). */
  locate(file: DiffFile): CommentPlacement;
};

export type ViewItem =
  | { kind: "finding"; id: string; finding: RecordedFinding }
  | {
      kind: "comment";
      id: string;
      comment: PaneComment;
      outdated?: string;
      /**
       * Where a placed comment's lines are in the diff shown, on its placement's
       * side (the stored range shifted, its length kept). Absent while it is not
       * placed: the stored range is drawn.
       */
      placedRange?: { start: number; end: number };
    };

export type PlacedItem = {
  item: ViewItem;
  place: ItemPlace;
  /** Between hunks: the file line the item follows, in its excerpt group. */
  line?: number;
};

/** Lines `from`..`to` of the file quoted between two hunks, with the items placed in them. */
export type ExcerptGroup = { hunkIndex: number; from: number; to: number };

export type FileItems = {
  /** In display order: the order the body draws them and the cursor visits them. */
  items: PlacedItem[];
  groups: ExcerptGroup[];
  /** The group each item between hunks belongs to, by item id. */
  groupOf: ReadonlyMap<string, ExcerptGroup>;
};

export const EMPTY_FILE_ITEMS: FileItems = { items: [], groups: [], groupOf: new Map() };

export function findingItemId(finding: Pick<RecordedFinding, "workTask" | "id">): string {
  return `finding:${finding.workTask}/${finding.id}`;
}

export function commentItemId(comment: Pick<PaneComment, "id">): string {
  return `comment:${comment.id}`;
}

export function hunkContains(hunk: DiffHunk, line: number): boolean {
  return hunk.newLines > 0 && line >= hunk.newStart && line <= hunk.newStart + hunk.newLines - 1;
}

/** Last new-side line a hunk covers; the line before it for a hunk that adds none. */
function hunkEnd(hunk: DiffHunk): number {
  return hunk.newLines > 0 ? hunk.newStart + hunk.newLines - 1 : hunk.newStart;
}

/**
 * Index of the last line at or before new-side line `target`, after which a
 * finding on that line is shown; undefined when it belongs after the header.
 */
function insertionLine(hunk: DiffHunk, target: number): number | undefined {
  let index: number | undefined;
  hunk.lines.forEach((line, lineIndex) => {
    if (line.newLine !== undefined && line.newLine <= target) index = lineIndex;
  });
  return index;
}

/** The displayed line a comment sits under, or -1 when its line is not displayed. */
function commentLineIndex(hunk: DiffHunk, side: DiffSide, line: number): number {
  return hunk.lines.findIndex((entry) =>
    side === "LEFT"
      ? entry.kind !== "add" && entry.oldLine === line
      : entry.kind !== "del" && entry.newLine === line,
  );
}

function findingSpan(finding: RecordedFinding): { start: number; end: number } | undefined {
  const start = finding.startLine;
  if (start === undefined) return undefined;
  const end = finding.endLine;
  return { start, end: end !== undefined && end >= start ? end : start };
}

type Draft = PlacedItem & { start?: number };

/**
 * Place a file's findings and comments. `file` holds the hunks as displayed;
 * undefined when the body shows no hunks (hidden, binary, too large,
 * unreadable, gone): every item then goes to the end and nothing is quoted.
 */
export function placeItems(
  findings: readonly RecordedFinding[],
  comments: readonly PaneComment[],
  file: DiffFile | undefined,
): FileItems {
  const drafts: Draft[] = [];
  const hunks = file?.hunks ?? [];
  const hunkIndex = new Map(hunks.map((hunk, index) => [hunk.id, index]));
  for (const finding of findings) {
    const item: ViewItem = { kind: "finding", id: findingItemId(finding), finding };
    const span = findingSpan(finding);
    if (!file) {
      const draft: Draft = { item, place: { kind: "end" } };
      if (span) draft.start = span.start;
      drafts.push(draft);
      continue;
    }
    if (!span) {
      drafts.push({ item, place: { kind: "before", hunkIndex: 0 } });
      continue;
    }
    const hunk = hunks.find((entry) => hunkContains(entry, span.start));
    if (hunk) {
      const after = insertionLine(hunk, span.end);
      drafts.push({
        item,
        place:
          after === undefined
            ? { kind: "header", hunkId: hunk.id }
            : { kind: "line", hunkId: hunk.id, lineIndex: after },
      });
      continue;
    }
    const next = hunks.findIndex((entry) => entry.newStart > span.start);
    drafts.push({
      item,
      place: { kind: "before", hunkIndex: next < 0 ? hunks.length : next },
      line: span.end,
      start: span.start,
    });
  }
  for (const comment of comments) {
    const id = commentItemId(comment);
    if (!file) {
      drafts.push({
        item: { kind: "comment", id, comment },
        place: { kind: "end" },
        start: comment.line,
      });
      continue;
    }
    let placement: CommentPlacement;
    try {
      placement = comment.locate(file);
    } catch (error) {
      placement = {
        status: "outdated",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const hunk =
      placement.status === "placed" ? hunks[hunkIndex.get(placement.hunkId) ?? -1] : undefined;
    if (placement.status !== "placed" || !hunk) {
      const message =
        placement.status === "outdated" ? placement.message : "Its hunk is not in this diff.";
      drafts.push({
        item: { kind: "comment", id, comment, outdated: message },
        place: { kind: "end" },
        start: comment.line,
      });
      continue;
    }
    const lineIndex = commentLineIndex(hunk, placement.side, placement.line);
    drafts.push({
      item: {
        kind: "comment",
        id,
        comment,
        placedRange: { start: placement.startLine, end: placement.line },
      },
      place:
        lineIndex < 0
          ? { kind: "header", hunkId: hunk.id }
          : { kind: "line", hunkId: hunk.id, lineIndex },
    });
  }
  return arrange(drafts, hunks);
}

/** Group the items between hunks into excerpts, then put every item in display order. */
function arrange(drafts: Draft[], hunks: readonly DiffHunk[]): FileItems {
  const groups: ExcerptGroup[] = [];
  const groupOf = new Map<string, ExcerptGroup>();
  const between = drafts
    .filter((draft) => draft.place.kind === "before" && draft.start !== undefined)
    .sort((left, right) => (left.start ?? 0) - (right.start ?? 0));
  let current: ExcerptGroup | undefined;
  for (const draft of between) {
    if (draft.place.kind !== "before") continue;
    const at = draft.place.hunkIndex;
    const start = draft.start ?? 1;
    const end = draft.line ?? start;
    const previous = hunks[at - 1];
    const next = hunks[at];
    const low = previous ? hunkEnd(previous) + 1 : 1;
    const high = next ? next.newStart - (next.newLines > 0 ? 1 : 0) : Number.MAX_SAFE_INTEGER;
    let from = Math.max(low, start - EXCERPT_RADIUS);
    if (current && current.hunkIndex === at && from <= current.to + 1) {
      const to = Math.min(high, Math.max(current.to, end + EXCERPT_RADIUS));
      if (to - current.from + 1 <= MAX_EXCERPT_LINES) {
        current.to = to;
        groupOf.set(draft.item.id, current);
        continue;
      }
      from = Math.max(from, current.to + 1);
    }
    const to = Math.min(high, end + EXCERPT_RADIUS, from + MAX_EXCERPT_LINES - 1);
    current = { hunkIndex: at, from, to: Math.max(from, to) };
    groups.push(current);
    groupOf.set(draft.item.id, current);
  }
  for (const draft of drafts) {
    const group = groupOf.get(draft.item.id);
    if (group && draft.line !== undefined)
      draft.line = Math.max(group.from, Math.min(draft.line, group.to));
  }
  const indexOf = new Map(hunks.map((hunk, index) => [hunk.id, index]));
  const key = (draft: Draft): [number, number, number] => {
    const place = draft.place;
    switch (place.kind) {
      case "before": {
        const group = groupOf.get(draft.item.id);
        return [2 * place.hunkIndex, group ? group.from : -1, draft.line ?? -1];
      }
      case "header":
        return [2 * (indexOf.get(place.hunkId) ?? hunks.length) + 1, -1, -1];
      case "line":
        return [2 * (indexOf.get(place.hunkId) ?? hunks.length) + 1, place.lineIndex, 0];
      case "end":
        return [2 * hunks.length + 3, draft.start ?? 0, 0];
    }
  };
  const keyed = drafts.map((draft) => ({ draft, key: key(draft) }));
  keyed.sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      const difference = (left.key[index] ?? 0) - (right.key[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  });
  const items = keyed.map(({ draft }) => {
    const placed: PlacedItem = { item: draft.item, place: draft.place };
    if (draft.line !== undefined && groupOf.has(draft.item.id)) placed.line = draft.line;
    return placed;
  });
  return { items, groups, groupOf };
}

/* ------------------------------------------------------------- drawing */

export type ItemDrawing = {
  open: boolean;
  selected: boolean;
  width: number;
  styler: PaneStyler;
  /** Finding: the record predates the file's last change. */
  mayBeOutdated?: boolean;
  /** Finding: its work task's review verdict, when recorded. */
  verdict?: string;
};

function rangeText(start: number | undefined, end: number | undefined): string {
  if (start === undefined) return "";
  return end !== undefined && end !== start ? `L${start}-${end}` : `L${start}`;
}

export function severityColor(finding: RecordedFinding): PaneColor {
  if (finding.class === "candidate") return "muted";
  if (finding.severity === "critical" || finding.severity === "high") return "error";
  if (finding.severity === "medium") return "warning";
  return "muted";
}

/** `text`'s lines made terminal-safe and wrapped to `width`, each behind `indent`. */
function paragraph(
  text: string,
  width: number,
  indent: string,
  paint: (text: string) => string,
): string[] {
  const room = Math.max(1, width - visibleWidth(indent));
  return text
    .split("\n")
    .flatMap((line) => wrapTextWithAnsi(safe(line), room))
    .map((line) => `${indent}${paint(line)}`);
}

/**
 * An item's rows: one when closed (marker, severity or range, and the start
 * of its text), its full record when open. The first row is the cursor's;
 * it is drawn inverted while selected.
 */
export function itemLines(item: ViewItem, drawing: ItemDrawing): string[] {
  const { styler, width, open } = drawing;
  const marker = open ? "▾" : "▸";
  const detailIndent = `${BODY_INDENT}    `;
  const muted = (text: string) => styler.fg("muted", text);
  let first: string;
  const rest: string[] = [];
  if (item.kind === "finding") {
    const finding = item.finding;
    const color = severityColor(finding);
    const range = rangeText(finding.startLine, finding.endLine);
    if (!open) {
      const claim = finding.invariant.split("\n")[0] ?? "";
      first = styler.fg(
        color,
        safe(`${marker} ⚑ ${finding.severity} ${finding.workTask}: ${claim}`),
      );
    } else {
      const outcome = finding.outcome ? ` [${finding.outcome}]` : "";
      const outdated = drawing.mayBeOutdated ? " (may be outdated)" : "";
      first = styler.fg(
        color,
        safe(
          `${marker} ⚑ ${finding.severity} ${finding.class} ${finding.id}${range ? ` ${range}` : ""}${outcome}${outdated}`,
        ),
      );
      rest.push(
        ...paragraph(finding.invariant, width, detailIndent, (text) => styler.fg("text", text)),
      );
      if (finding.reproduction.trim().length > 0) {
        rest.push(
          ...paragraph(`Reproduction: ${finding.reproduction}`, width, detailIndent, muted),
        );
      }
      if (finding.angle !== undefined && finding.angle.trim().length > 0) {
        rest.push(...paragraph(`Angle: ${finding.angle}`, width, detailIndent, muted));
      }
      const verdict = [
        drawing.verdict === undefined ? "" : `verdict ${drawing.verdict}`,
        finding.outcome === undefined ? "" : `outcome ${finding.outcome}`,
        `evidence ${finding.evidence}`,
      ].filter((part) => part.length > 0);
      rest.push(...paragraph(`Review: ${verdict.join(" · ")}`, width, detailIndent, muted));
      rest.push(
        ...paragraph(
          `Work task: ${finding.workTask} (${finding.agentId})`,
          width,
          detailIndent,
          muted,
        ),
      );
      if (drawing.mayBeOutdated) {
        rest.push(
          ...paragraph(
            "May be outdated: the file changed after the review.",
            width,
            detailIndent,
            (text) => styler.fg("warning", text),
          ),
        );
      }
    }
  } else {
    const comment = item.comment;
    const color: PaneColor = item.outdated === undefined ? "accent" : "dim";
    // A placed comment is labelled where it was found; the stored range may predate an edit above it.
    const range = item.placedRange
      ? rangeText(item.placedRange.start, item.placedRange.end)
      : rangeText(comment.startLine ?? comment.line, comment.line);
    const state = item.outdated === undefined ? "" : " (outdated)";
    if (!open) {
      const text = comment.body.split("\n")[0] ?? "";
      first = styler.fg(color, safe(`${marker} ● ${range}${state} ${text}`));
    } else {
      first = styler.fg(color, safe(`${marker} ● ${range}${state} · ${comment.label}`));
      const body = item.outdated === undefined ? muted : (text: string) => styler.fg("dim", text);
      rest.push(...paragraph(comment.body, width, detailIndent, body));
      if (item.outdated !== undefined) {
        rest.push(
          ...paragraph(`Outdated: ${item.outdated}`, width, detailIndent, (text) =>
            styler.fg("dim", text),
          ),
        );
      }
    }
  }
  // The cursor's item is marked as well as inverted, so it shows without colors too.
  const lead = drawing.selected ? styler.fg("accent", "▶ ") : BODY_INDENT;
  const head = truncateToWidth(`${lead}${first}`, width, "…");
  return [
    drawing.selected ? styler.inverse(head) : head,
    ...rest.map((line) => truncateToWidth(line, width, "…")),
  ];
}

/** One quoted line of the file: its number and its text, dimmed. */
export function excerptLine(
  number: number,
  text: string,
  numberWidth: number,
  width: number,
  styler: PaneStyler,
): string {
  const gutter = styler.fg("dim", `${String(number).padStart(numberWidth)} ┆ `);
  return truncateToWidth(
    `${BODY_INDENT}${gutter}${styler.fg("toolDiffContext", safe(text))}`,
    width,
    "…",
  );
}

/** The row above a quote: which lines of the file it shows. */
export function excerptHeader(
  group: ExcerptGroup,
  width: number,
  styler: PaneStyler,
  note = "",
): string {
  const label = `┄ L${group.from}-${group.to} as the file is now${note ? `: ${safe(note)}` : ""}`;
  return truncateToWidth(`${BODY_INDENT}${styler.fg("dim", label)}`, width, "…");
}
