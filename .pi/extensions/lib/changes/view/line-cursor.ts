/**
 * The line cursor of the changes view (the interactive review's cursor): pure
 * functions over the files as displayed. A stop is a file row, a folded
 * hunk's placeholder, or one displayed line of an unfolded hunk; a host may
 * make an unfolded hunk's header a stop too (the pane, where it selects the
 * whole hunk).
 *
 * Line indexes count the hunk's displayed lines, which include any context
 * the reviewer revealed around it; hunk ids stay the content-hash ids.
 *
 * An item (a recorded finding or a review comment shown in the body) is a
 * stop too, at the place the body draws it; see {@link ItemPlace}.
 */
import type { DiffFile, DiffHunk, DiffLine, DiffSide } from "../types.ts";

/** Where the cursor sits. */
export type LineCursor = {
  path: string;
  /** Absent on a file row and on an item. */
  hunkId?: string;
  /** Index into the hunk's displayed lines; absent on a file row or a folded hunk. */
  lineIndex?: number;
  /** Fixed end of a multi-line selection in the same hunk; absent for one line. */
  anchorIndex?: number;
  /** The item the cursor is on (a finding or comment row); absent everywhere else. */
  itemId?: string;
};

/**
 * Where an item sits in its file's body:
 * - `line`: after a displayed line of a hunk (after the hunk's only row when it is folded);
 * - `header`: after a hunk's header;
 * - `before`: between hunks, before the hunk at `hunkIndex` (`hunks.length`: after the last);
 * - `end`: after everything else in the body.
 */
export type ItemPlace =
  | { kind: "line"; hunkId: string; lineIndex: number }
  | { kind: "header"; hunkId: string }
  | { kind: "before"; hunkIndex: number }
  | { kind: "end" };

export type CursorItem = { id: string; place: ItemPlace };

/** One listed file as the cursor walks it. */
export type CursorFile = {
  path: string;
  /** False while collapsed, hidden or loading: only its row is a stop. */
  open: boolean;
  /** Displayed hunks; undefined while loading. */
  hunks: readonly DiffHunk[] | undefined;
  folded(hunkId: string): boolean;
  /** The header of an unfolded hunk is a stop before its lines. */
  hunkStops?: boolean;
  /** Items in the body, in the order the body draws those at one place. */
  items?: readonly CursorItem[];
  /**
   * The body lists the items without its contents (a hidden sensitive file
   * that is expanded): they follow the file row, in order.
   */
  itemsOnly?: boolean;
};

export type CursorRow = { path: string; hunkId?: string; lineIndex?: number; itemId?: string };

/** Items of `file` at one place, in their given order. */
function itemsAt(
  file: CursorFile,
  test: (place: ItemPlace) => boolean,
): Array<{ path: string; itemId: string }> {
  return (file.items ?? [])
    .filter((item) => test(item.place))
    .map((item) => ({ path: file.path, itemId: item.id }));
}

/** Every stop, in display order. */
export function cursorRows(files: readonly CursorFile[]): CursorRow[] {
  const rows: CursorRow[] = [];
  for (const file of files) {
    rows.push({ path: file.path });
    if (!file.open && file.itemsOnly) {
      rows.push(...itemsAt(file, () => true));
      continue;
    }
    if (!file.open || !file.hunks) continue;
    const hunks = file.hunks;
    hunks.forEach((hunk, hunkIndex) => {
      rows.push(
        ...itemsAt(file, (place) => place.kind === "before" && place.hunkIndex === hunkIndex),
      );
      const inHunk = (place: ItemPlace) =>
        (place.kind === "line" || place.kind === "header") && place.hunkId === hunk.id;
      if (file.folded(hunk.id) || hunk.lines.length === 0) {
        rows.push({ path: file.path, hunkId: hunk.id });
        rows.push(...itemsAt(file, inHunk));
        return;
      }
      if (file.hunkStops) rows.push({ path: file.path, hunkId: hunk.id });
      rows.push(...itemsAt(file, (place) => place.kind === "header" && place.hunkId === hunk.id));
      const lineItems = (file.items ?? []).filter(
        (item) => item.place.kind === "line" && item.place.hunkId === hunk.id,
      );
      hunk.lines.forEach((_line, lineIndex) => {
        rows.push({ path: file.path, hunkId: hunk.id, lineIndex });
        for (const item of lineItems) {
          if (item.place.kind === "line" && item.place.lineIndex === lineIndex) {
            rows.push({ path: file.path, itemId: item.id });
          }
        }
      });
      // A line past the hunk's displayed lines (its context collapsed): after its last row.
      for (const item of lineItems) {
        if (item.place.kind === "line" && item.place.lineIndex >= hunk.lines.length) {
          rows.push({ path: file.path, itemId: item.id });
        }
      }
    });
    rows.push(
      ...itemsAt(
        file,
        (place) =>
          (place.kind === "before" && place.hunkIndex >= hunks.length) ||
          // An item naming a hunk the file no longer shows goes to the end with the rest.
          ((place.kind === "line" || place.kind === "header") &&
            !hunks.some((hunk) => hunk.id === place.hunkId)),
      ),
    );
    rows.push(...itemsAt(file, (place) => place.kind === "end"));
  }
  return rows;
}

function rowIndex(rows: readonly CursorRow[], cursor: LineCursor | undefined): number {
  if (!cursor) return -1;
  if (cursor.itemId !== undefined) {
    const item = rows.findIndex((row) => row.path === cursor.path && row.itemId === cursor.itemId);
    if (item >= 0) return item;
    return rows.findIndex((row) => row.path === cursor.path);
  }
  const exact = rows.findIndex(
    (row) =>
      row.path === cursor.path &&
      row.itemId === undefined &&
      row.hunkId === cursor.hunkId &&
      row.lineIndex === cursor.lineIndex,
  );
  if (exact >= 0) return exact;
  // A line that is no longer shown (its hunk folded, its context collapsed): the hunk, then the file.
  const hunk = rows.findIndex(
    (row) =>
      row.path === cursor.path && cursor.hunkId !== undefined && row.hunkId === cursor.hunkId,
  );
  if (hunk >= 0) return hunk;
  return rows.findIndex((row) => row.path === cursor.path);
}

/** Move `delta` stops, clamping at either end; any selection collapses. */
export function moveLine(
  files: readonly CursorFile[],
  cursor: LineCursor | undefined,
  delta: number,
): LineCursor | undefined {
  if (!Number.isInteger(delta) || delta === 0) return cursor;
  const rows = cursorRows(files);
  if (rows.length === 0) return cursor;
  const index = rowIndex(rows, cursor);
  const next = index < 0 ? (delta > 0 ? delta - 1 : rows.length + delta) : index + delta;
  const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
  return row ? { ...row } : cursor;
}

/**
 * The side a comment on this row takes, as GitHub maps it: removed lines
 * exist only in the base (LEFT); added and unchanged lines are addressed on
 * the head (RIGHT) at their new number, the one a person finds in the file as
 * it is now and GitHub's own choice for an unchanged line.
 */
export function lineCommentSide(line: DiffLine): DiffSide | undefined {
  if (line.newLine !== undefined) return "RIGHT";
  return line.oldLine === undefined ? undefined : "LEFT";
}

/**
 * The one side that numbers every line from `from` to `to`: RIGHT when they
 * all have a new number, else LEFT when they all have an old one (a range
 * over removed lines and the unchanged lines around them). Undefined when
 * the range mixes removed and added lines, which no single side can address.
 */
function rangeSide(hunk: DiffHunk, from: number, to: number): DiffSide | undefined {
  const lines = hunk.lines.slice(Math.min(from, to), Math.max(from, to) + 1);
  if (lines.length === 0) return undefined;
  if (lines.every((line) => line.newLine !== undefined)) return "RIGHT";
  if (lines.every((line) => line.oldLine !== undefined)) return "LEFT";
  return undefined;
}

function sideNumber(line: DiffLine | undefined, side: DiffSide): number | undefined {
  if (!line) return undefined;
  return side === "LEFT" ? line.oldLine : line.newLine;
}

type Selection = { cursorIndex: number; anchorIndex: number };

/** The cursor and anchor in `hunk`; an anchor outside its lines reads as collapsed. */
function selectionIn(hunk: DiffHunk, cursor: LineCursor): Selection | undefined {
  const index = cursor.lineIndex;
  if (cursor.hunkId !== hunk.id || index === undefined || hunk.lines[index] === undefined) {
    return undefined;
  }
  const anchor = cursor.anchorIndex;
  const anchored = anchor !== undefined && anchor >= 0 && anchor < hunk.lines.length;
  return { cursorIndex: index, anchorIndex: anchored ? anchor : index };
}

/** Displayed line indexes the selection covers, ascending; empty off a line. */
export function selectedLineIndexes(hunk: DiffHunk, cursor: LineCursor): number[] {
  const selection = selectionIn(hunk, cursor);
  if (!selection) return [];
  const from = Math.min(selection.anchorIndex, selection.cursorIndex);
  const to = Math.max(selection.anchorIndex, selection.cursorIndex);
  return Array.from({ length: to - from + 1 }, (_unused, offset) => from + offset);
}

/**
 * Extend the selection by `delta` displayed rows, keeping the anchor fixed.
 *
 * Extension stops at a row with no line number on the anchor's side instead
 * of skipping it: GitHub takes one side per comment, so a range across that
 * boundary would be posted against lines the highlight never showed.
 */
export function extendSelection(hunk: DiffHunk, cursor: LineCursor, delta: number): LineCursor {
  if (!Number.isInteger(delta) || delta === 0) return cursor;
  const selection = selectionIn(hunk, cursor);
  if (!selection) return cursor;
  if (rangeSide(hunk, selection.anchorIndex, selection.anchorIndex) === undefined) return cursor;
  const step = delta > 0 ? 1 : -1;
  let index = selection.cursorIndex;
  for (let moved = 0; moved < Math.abs(delta); moved += 1) {
    const next = index + step;
    if (next < 0 || next >= hunk.lines.length) break;
    // A range stays one that a single side numbers throughout.
    if (rangeSide(hunk, selection.anchorIndex, next) === undefined) break;
    index = next;
  }
  if (index === selection.cursorIndex) return cursor;
  return { ...cursor, lineIndex: index, anchorIndex: selection.anchorIndex };
}

/** Where a comment written now attaches. */
export type CommentPosition = {
  path: string;
  hunkId: string;
  side: DiffSide;
  line: number;
  /** Absent for one line: `start_line` equal to `line` is a different comment to GitHub. */
  startLine?: number;
};

function positionAt(path: string, hunk: DiffHunk, index: number): CommentPosition | undefined {
  const line = hunk.lines[index];
  if (!line) return undefined;
  const side = lineCommentSide(line);
  const number = side === undefined ? undefined : sideNumber(line, side);
  return side === undefined || number === undefined
    ? undefined
    : { path, hunkId: hunk.id, side, line: number };
}

/** The range spans the anchor and the cursor; its side is the one that numbers all of it. */
export function currentCommentPosition(
  path: string,
  hunk: DiffHunk,
  cursor: LineCursor,
): CommentPosition | undefined {
  const selection = selectionIn(hunk, cursor);
  if (!selection) return undefined;
  const at = positionAt(path, hunk, selection.cursorIndex);
  if (!at || selection.anchorIndex === selection.cursorIndex) return at;
  const side = rangeSide(hunk, selection.anchorIndex, selection.cursorIndex);
  const anchorLine = side && sideNumber(hunk.lines[selection.anchorIndex], side);
  const cursorLine = side && sideNumber(hunk.lines[selection.cursorIndex], side);
  if (side === undefined || anchorLine === undefined || cursorLine === undefined) return at;
  const line = Math.max(anchorLine, cursorLine);
  const startLine = Math.min(anchorLine, cursorLine);
  const position: CommentPosition = { path, hunkId: hunk.id, side, line };
  if (startLine !== line) position.startLine = startLine;
  return position;
}

/** A line the cursor can be sent to; `lineIndex` counts the hunk's own lines. */
export type LineTarget = { path: string; hunkId: string; lineIndex: number };

export type SearchMatch = LineTarget & { side: DiffSide; line: number; text: string };

/** Changed (added or removed) lines containing `query`, case-insensitively, in file order. */
export function changedLineMatches(files: readonly DiffFile[], query: string): SearchMatch[] {
  const needle = query.toLocaleLowerCase();
  const matches: SearchMatch[] = [];
  for (const file of files) {
    for (const hunk of file.hunks) {
      hunk.lines.forEach((line, lineIndex) => {
        if (line.kind === "context" || !line.text.toLocaleLowerCase().includes(needle)) return;
        const side: DiffSide = line.kind === "del" ? "LEFT" : "RIGHT";
        const number = side === "LEFT" ? line.oldLine : line.newLine;
        if (number === undefined) return;
        matches.push({
          path: file.path,
          hunkId: hunk.id,
          lineIndex,
          side,
          line: number,
          text: line.text,
        });
      });
    }
  }
  return matches;
}
