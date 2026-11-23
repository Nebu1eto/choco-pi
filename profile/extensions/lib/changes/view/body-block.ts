import { truncateToWidth } from "@earendil-works/pi-tui";
import { splitRowPairs } from "../render/split-rows.ts";
import type { DiffHunk } from "../types.ts";
import type { PaneColor, PaneStyler } from "./rows.ts";

export const BODY_INDENT = "  ";

export function bodyNote(
  text: string,
  width: number,
  styler: Pick<PaneStyler, "fg">,
  color: PaneColor = "dim",
): string {
  return truncateToWidth(`${BODY_INDENT}${styler.fg(color, text)}`, width, "…");
}

export type HunkRows = { lines: string[]; mapped: boolean };

export function renderHunkRows<File extends { hunks: readonly DiffHunk[] }>(
  file: File,
  render: (file: File) => string[],
  rowsOf: (hunk: DiffHunk) => number = (hunk) => 1 + hunk.lines.length,
): HunkRows[] {
  const whole = render(file);
  const counts = file.hunks.map(rowsOf);
  const expected = counts.reduce((sum, count) => sum + count, 0);
  if (whole.length === expected) {
    const parts: HunkRows[] = [];
    let offset = 0;
    file.hunks.forEach((hunk, index) => {
      const count = counts[index] ?? 0;
      const lines = whole.slice(offset, offset + count);
      parts.push({ lines, mapped: lines.length === 1 + hunk.lines.length });
      offset += count;
    });
    return parts;
  }
  return file.hunks.map((hunk) => {
    const lines = render({ ...file, hunks: [hunk] });
    return { lines, mapped: lines.length === 1 + hunk.lines.length };
  });
}

export { splitRowPairs };

type SplitLayout = { rows: number; rowOfLine: Int32Array };

const splitLayouts = new WeakMap<DiffHunk, SplitLayout>();

function splitLayout(hunk: DiffHunk): SplitLayout {
  const known = splitLayouts.get(hunk);
  if (known) return known;
  const pairs = splitRowPairs(hunk.lines);
  const rowOfLine = new Int32Array(hunk.lines.length);
  pairs.forEach(([left, right], row) => {
    if (left !== undefined) rowOfLine[left] = row;
    if (right !== undefined) rowOfLine[right] = row;
  });
  const layout = { rows: pairs.length, rowOfLine };
  splitLayouts.set(hunk, layout);
  return layout;
}

export function splitRowForLine(hunk: DiffHunk, lineIndex: number): number {
  return splitLayout(hunk).rowOfLine[lineIndex] ?? 0;
}

export function splitRowCount(hunk: DiffHunk): number {
  return splitLayout(hunk).rows;
}

export function hunkRowOfLine(
  hunk: DiffHunk,
  rows: number,
  lineIndex: number,
  mode: "unified" | "split",
): number | undefined {
  if (mode === "unified" && rows === 1 + hunk.lines.length) return 1 + lineIndex;
  if (mode === "split" && rows === 1 + splitRowCount(hunk))
    return 1 + splitRowForLine(hunk, lineIndex);
  return undefined;
}

export type AnnotationPlace = "header" | "end" | { afterLine: number };

export type BodyAnnotation = { hunkId: string; place: AnnotationPlace; lines: string[] };

export type BodyBlockInput = {
  hunks: readonly DiffHunk[];
  rows: readonly HunkRows[];
  width: number;
  styler: { fg(color: "accent", text: string): string; inverse(text: string): string };
  mode?: "unified" | "split";
  markedHunkId?: string;
  inverted?: ReadonlyMap<string, ReadonlySet<number>>;
  headerSuffix?: (hunkId: string) => string | undefined;
  foldMarker?: (hunkId: string) => string | undefined;
  annotations?: readonly BodyAnnotation[];
};

export type BodyBlock = {
  lines: string[];
  hunkStart: Map<string, number>;
  rowOfLine(hunkId: string, lineIndex: number): number | undefined;
  annotationRows: number[];
};

const fittedRows = new WeakMap<HunkRows, Map<string, Array<string | undefined>>>();

function fitted(part: HunkRows, row: number, prefix: string, width: number): string {
  let byGutter = fittedRows.get(part);
  if (!byGutter) {
    byGutter = new Map();
    fittedRows.set(part, byGutter);
  }
  const key = `${width}\u0000${prefix}`;
  let rows = byGutter.get(key);
  if (!rows) {
    rows = Array.from({ length: part.lines.length }, () => undefined);
    byGutter.set(key, rows);
  }
  return (rows[row] ??= truncateToWidth(`${prefix}${part.lines[row] ?? ""}`, width, "…"));
}

export function bodyBlock(input: BodyBlockInput): BodyBlock {
  const { styler, width } = input;
  const mode = input.mode ?? "unified";
  const lines: string[] = [];
  const hunkStart = new Map<string, number>();
  const lineRows = new Map<string, Map<number, number>>();
  const annotationRows = Array.from({ length: input.annotations?.length ?? 0 }, () => -1);
  input.hunks.forEach((hunk, hunkIndex) => {
    const part = input.rows[hunkIndex] ?? { lines: [], mapped: false };
    const prefix = hunk.id === input.markedHunkId ? `${styler.fg("accent", "▌")} ` : BODY_INDENT;
    const inverted = input.inverted?.get(hunk.id);
    const after = new Map<number, number[]>();
    const place = (row: number, index: number) =>
      after.set(row, [...(after.get(row) ?? []), index]);
    const end: number[] = [];
    input.annotations?.forEach((annotation, index) => {
      if (annotation.hunkId !== hunk.id) return;
      if (part.lines.length === 0 || annotation.place === "end") end.push(index);
      else if (annotation.place === "header") place(0, index);
      else {
        const row = hunkRowOfLine(hunk, part.lines.length, annotation.place.afterLine, mode);
        place(row ?? part.lines.length - 1, index);
      }
    });
    const rows = new Map<number, number>();
    const emit = (index: number) => {
      annotationRows[index] = lines.length;
      lines.push(...(input.annotations?.[index]?.lines ?? []));
    };
    hunkStart.set(hunk.id, lines.length);
    part.lines.forEach((line, row) => {
      rows.set(row, lines.length);
      const suffix = row === 0 ? input.headerSuffix?.(hunk.id) : undefined;
      const marker = row === 0 ? input.foldMarker?.(hunk.id) : undefined;
      const lead = marker === undefined ? prefix : `${prefix}${marker} `;
      const drawn = suffix
        ? truncateToWidth(`${lead}${line} ${suffix}`, width, "…")
        : fitted(part, row, lead, width);
      lines.push(inverted?.has(row) ? styler.inverse(drawn) : drawn);
      for (const index of after.get(row) ?? []) emit(index);
    });
    for (const index of end) emit(index);
    const byLine = new Map<number, number>();
    hunk.lines.forEach((_line, lineIndex) => {
      const row = hunkRowOfLine(hunk, part.lines.length, lineIndex, mode);
      const at = rows.get(row ?? 0);
      if (at !== undefined) byLine.set(lineIndex, at);
    });
    lineRows.set(hunk.id, byLine);
  });
  return {
    lines,
    hunkStart,
    annotationRows,
    rowOfLine: (hunkId, lineIndex) => lineRows.get(hunkId)?.get(lineIndex) ?? hunkStart.get(hunkId),
  };
}
