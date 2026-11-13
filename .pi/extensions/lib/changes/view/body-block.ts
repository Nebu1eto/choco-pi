/**
 * A file's diff body as one block of rows, shared by the changes pane and the
 * interactive review. The pane's layout is the reference: every hunk row sits
 * behind a two-column gutter (`▌ ` on the hunk the caller marks), and text
 * that belongs to a line (a pane note or finding, a review comment) is
 * inserted as whole rows after that line.
 *
 * Pure: the caller passes the rendered hunks, widths and decorations; nothing
 * here holds host state. Hunk text is already terminal-safe when it reaches
 * this module (see `renderHunkRows`), and annotation lines are the caller's
 * own, already-styled rows.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { splitRowPairs } from "../render/split-rows.ts";
import type { DiffHunk } from "../types.ts";
import type { PaneColor, PaneStyler } from "./rows.ts";

/** Width of the gutter in front of every hunk row and note. */
export const BODY_INDENT = "  ";

/** One explanatory line in the body (loading, notices, hidden contents). */
export function bodyNote(
  text: string,
  width: number,
  styler: Pick<PaneStyler, "fg">,
  color: PaneColor = "dim",
): string {
  return truncateToWidth(`${BODY_INDENT}${styler.fg(color, text)}`, width, "…");
}

/**
 * One hunk's rendered rows. `mapped` is true when they are a header row plus
 * one row per diff line, so annotations can sit at their line.
 */
export type HunkRows = { lines: string[]; mapped: boolean };

/**
 * Render each hunk of `file` with `render` (which returns a file's hunk rows
 * without its file header), in one call for the whole file. The rows are
 * divided per hunk by `rowsOf`, the row count the renderer draws for a hunk
 * (the shared split pairing in split mode): rendering again only to learn the
 * layout would spend the frame's work twice. A renderer whose rows do not add
 * up (a host's own renderer) is called once per hunk instead.
 */
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

/** The shared split pairing (render/split-rows.ts), re-exported for the view's callers. */
export { splitRowPairs };

type SplitLayout = { rows: number; rowOfLine: Int32Array };

/**
 * The split rows of a hunk, computed once per hunk object: callers ask for
 * every line of a hunk on each frame, and a hunk can have many thousand lines.
 */
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

/** Split-mode row of a line, counted over the rows actually drawn (0 when the line is not in the hunk). */
export function splitRowForLine(hunk: DiffHunk, lineIndex: number): number {
  return splitLayout(hunk).rowOfLine[lineIndex] ?? 0;
}

/** Rows a hunk's lines occupy in split mode: every row drawn, not the last line's row. */
export function splitRowCount(hunk: DiffHunk): number {
  return splitLayout(hunk).rows;
}

/**
 * Row within a hunk's rendered rows (0 = its header) that shows `lineIndex`, or
 * undefined when the rows do not map to lines (a folded or custom-rendered hunk).
 */
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

/** Where an annotation goes: after the header, after one line, or after the hunk's last row. */
export type AnnotationPlace = "header" | "end" | { afterLine: number };

/** Caller-styled rows placed in the body, such as a note, a finding or a comment. */
export type BodyAnnotation = { hunkId: string; place: AnnotationPlace; lines: string[] };

export type BodyBlockInput = {
  hunks: readonly DiffHunk[];
  /** Rendered rows per hunk, in `hunks` order (see `renderHunkRows`). */
  rows: readonly HunkRows[];
  width: number;
  /** Only `accent` (the gutter marker) and inversion are used. */
  styler: { fg(color: "accent", text: string): string; inverse(text: string): string };
  /** Layout the rows were rendered in; maps a line to its row. */
  mode?: "unified" | "split";
  /** The hunk drawn with the `▌` gutter marker. */
  markedHunkId?: string;
  /** Rows (0 = header) drawn inverted, per hunk id. */
  inverted?: ReadonlyMap<string, ReadonlySet<number>>;
  /** Text appended to a hunk's header row. */
  headerSuffix?: (hunkId: string) => string | undefined;
  /** `▾ `/`▸ ` before a hunk's header row, as a file row has, when hunks fold. */
  foldMarker?: (hunkId: string) => string | undefined;
  /** In the order to place them; annotations at the same place keep this order. */
  annotations?: readonly BodyAnnotation[];
};

export type BodyBlock = {
  lines: string[];
  /** Row of each hunk's header in `lines`, by hunk id. */
  hunkStart: Map<string, number>;
  /** Row of a line in `lines`; the hunk's header row when the line has no row of its own. */
  rowOfLine(hunkId: string, lineIndex: number): number | undefined;
  /** First row of each annotation, in input order. */
  annotationRows: number[];
};

/**
 * Rows of a rendered hunk already cut to a width behind a gutter. A body is
 * laid out again on every cursor move, with the same rows except the few the
 * cursor inverts, and measuring a row costs far more than looking it up.
 */
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

/** Lay out hunk rows with the gutter, inverted rows, header suffixes and annotations. */
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
      // An inverted row is inverted whole, gutter included, so a selection reads as one block.
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
