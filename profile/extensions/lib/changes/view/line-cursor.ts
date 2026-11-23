import type { DiffFile, DiffHunk, DiffLine, DiffSide } from "../types.ts";

export type LineCursor = {
  path: string;
  hunkId?: string;
  lineIndex?: number;
  anchorIndex?: number;
  itemId?: string;
};

export type ItemPlace =
  | { kind: "line"; hunkId: string; lineIndex: number }
  | { kind: "header"; hunkId: string }
  | { kind: "before"; hunkIndex: number }
  | { kind: "end" };

export type CursorItem = { id: string; place: ItemPlace };

export type CursorFile = {
  path: string;
  open: boolean;
  hunks: readonly DiffHunk[] | undefined;
  folded(hunkId: string): boolean;
  hunkStops?: boolean;
  items?: readonly CursorItem[];
  itemsOnly?: boolean;
};

export type CursorRow = { path: string; hunkId?: string; lineIndex?: number; itemId?: string };

function itemsAt(
  file: CursorFile,
  test: (place: ItemPlace) => boolean,
): Array<{ path: string; itemId: string }> {
  return (file.items ?? [])
    .filter((item) => test(item.place))
    .map((item) => ({ path: file.path, itemId: item.id }));
}

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
  const hunk = rows.findIndex(
    (row) =>
      row.path === cursor.path && cursor.hunkId !== undefined && row.hunkId === cursor.hunkId,
  );
  if (hunk >= 0) return hunk;
  return rows.findIndex((row) => row.path === cursor.path);
}

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

export function lineCommentSide(line: DiffLine): DiffSide | undefined {
  if (line.newLine !== undefined) return "RIGHT";
  return line.oldLine === undefined ? undefined : "LEFT";
}

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

function selectionIn(hunk: DiffHunk, cursor: LineCursor): Selection | undefined {
  const index = cursor.lineIndex;
  if (cursor.hunkId !== hunk.id || index === undefined || hunk.lines[index] === undefined) {
    return undefined;
  }
  const anchor = cursor.anchorIndex;
  const anchored = anchor !== undefined && anchor >= 0 && anchor < hunk.lines.length;
  return { cursorIndex: index, anchorIndex: anchored ? anchor : index };
}

export function selectedLineIndexes(hunk: DiffHunk, cursor: LineCursor): number[] {
  const selection = selectionIn(hunk, cursor);
  if (!selection) return [];
  const from = Math.min(selection.anchorIndex, selection.cursorIndex);
  const to = Math.max(selection.anchorIndex, selection.cursorIndex);
  return Array.from({ length: to - from + 1 }, (_unused, offset) => from + offset);
}

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
    if (rangeSide(hunk, selection.anchorIndex, next) === undefined) break;
    index = next;
  }
  if (index === selection.cursorIndex) return cursor;
  return { ...cursor, lineIndex: index, anchorIndex: selection.anchorIndex };
}

export type CommentPosition = {
  path: string;
  hunkId: string;
  side: DiffSide;
  line: number;
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

export type LineTarget = { path: string; hunkId: string; lineIndex: number };

export type SearchMatch = LineTarget & { side: DiffSide; line: number; text: string };

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
