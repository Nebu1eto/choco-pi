import { visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens } from "../session-usage.ts";

/**
 * A step line chart in box-drawing characters, after asciichart: one column
 * per sample, horizontal runs in ─, vertical moves in │ with ╭ ╮ ╰ ╯ corners.
 * Each series has its own colour. Where series overlap, the series with the
 * higher value at that sample owns the cell, then the earlier series. An
 * aggregate series may be drawn heavy; it is never below its parts, so it wins
 * every overlap and the hidden part is exactly where the aggregate runs.
 */

export type ChartSeries = {
  /** Series values, one per sample (day); zeros plot at the baseline. */
  values: readonly number[];
  /** Applies the series colour to a run of glyphs. */
  paint: (text: string) => string;
  /** Heavy box-drawing (━ ┃ ┏ ┓ ┗ ┛) for an aggregate line; light by default. */
  weight?: "light" | "heavy";
};

const HEAVY = new Map([
  ["─", "━"],
  ["│", "┃"],
  ["╭", "┏"],
  ["╮", "┓"],
  ["╰", "┗"],
  ["╯", "┛"],
]);

/** The crossing glyph for a vertical of one weight over a horizontal of another. */
function crossing(verticalHeavy: boolean, horizontalHeavy: boolean): string {
  if (verticalHeavy && horizontalHeavy) return "╋";
  if (verticalHeavy) return "╂";
  if (horizontalHeavy) return "┿";
  return "┼";
}

export type ChartOptions = {
  /** Plot rows, excluding the tick row. */
  rows: number;
  /** Total width of every returned line, axis labels included. */
  width: number;
  /** Width reserved for the y-axis labels, separator included. */
  gutter: number;
  /** Tick labels for the x-axis, one per sample; empty strings draw no tick. */
  ticks: readonly string[];
  /** Dims axis text. */
  dim: (text: string) => string;
};

/** Levels (0 = baseline) that carry a y-axis label for `rows` plot rows: 0, the top, and evenly spaced levels between. */
export function axisLevels(rows: number): number[] {
  if (rows <= 1) return [0];
  const top = rows - 1;
  // Every other level when the height allows it (odd row counts), else every level.
  const step = top % 2 === 0 && top >= 4 ? 2 : 1;
  const out: number[] = [];
  for (let level = top; level >= 0; level -= step) out.push(level);
  return out;
}

/** Cells per sample so that `samples` columns fill `plotWidth`; the last samples absorb the remainder. */
export function columnWidths(samples: number, plotWidth: number): number[] {
  const base = Math.max(1, Math.floor(plotWidth / samples));
  const spare = Math.max(0, plotWidth - base * samples);
  return Array.from({ length: samples }, (_, index) => base + (index >= samples - spare ? 1 : 0));
}

type Cell = { glyph: string; series: number; value: number; vertical: boolean; heavy: boolean };

/**
 * Render the chart. Returns `rows + 1` lines (plot rows top first, then the
 * tick row); every line is at most `width` columns.
 */
export function lineChart(series: readonly ChartSeries[], options: ChartOptions): string[] {
  const { rows, width, gutter, dim } = options;
  const samples = Math.max(...series.map((s) => s.values.length), options.ticks.length, 1);
  const plotWidth = Math.max(samples, width - gutter);
  const widths = columnWidths(samples, plotWidth);
  const starts: number[] = [];
  let at = 0;
  for (const w of widths) {
    starts.push(at);
    at += w;
  }
  const peak = Math.max(0, ...series.flatMap((s) => [...s.values]));
  const levelOf = (value: number): number =>
    peak <= 0 ? 0 : Math.min(rows - 1, Math.round((value / peak) * (rows - 1)));

  const grid: Array<Array<Cell | undefined>> = Array.from({ length: rows }, () =>
    Array.from({ length: plotWidth }, (): Cell | undefined => undefined),
  );
  const put = (
    row: number,
    column: number,
    glyph: string,
    s: number,
    value: number,
    vertical: boolean,
    heavy: boolean,
  ): void => {
    if (row < 0 || row >= rows || column < 0 || column >= plotWidth) return;
    const line = grid[row];
    if (!line) return;
    const current = line[column];
    if (current !== undefined && current.series !== s) {
      // A horizontal never displaces a connector. A connector crossing another
      // series' horizontal becomes a crossing glyph in the connector's colour, so
      // both lines read through the cell; two connectors cannot meet (columns
      // are staggered).
      if (current.vertical && !vertical) return;
      // A light corner meeting the aggregate's horizontal merges into it: the
      // part is coincident with the whole there, and the heavy line stays whole.
      if (!current.vertical && current.heavy && vertical && !heavy && glyph !== "│") return;
      if (!current.vertical && vertical && glyph === "│") {
        line[column] = { glyph: crossing(heavy, current.heavy), series: s, value, vertical, heavy };
        return;
      }
      if (current.vertical === vertical && current.value >= value) return;
    }
    line[column] = { glyph, series: s, value, vertical, heavy };
  };

  // Each series puts its vertical at a different column inside the day (its
  // rank, clamped to the day's width), so connectors never share a cell.
  // Verticals outrank horizontals in a cell; among equals the higher value
  // wins, then the earlier series. A horizontal that reaches another series'
  // vertical is cut there, so every line stays connected.
  series.forEach((entry, s) => {
    const values = entry.values;
    const heavy = entry.weight === "heavy";
    let previousLevel: number | undefined;
    for (let index = 0; index < samples; index += 1) {
      const value = values[index] ?? 0;
      const level = levelOf(value);
      const row = rows - 1 - level;
      const start = starts[index] ?? 0;
      const cellWidth = widths[index] ?? 1;
      const stepAt = start + Math.min(s, cellWidth - 1);
      if (previousLevel !== undefined && previousLevel !== level) {
        const fromRow = rows - 1 - previousLevel;
        const up = level > previousLevel;
        const previous = values[index - 1] ?? 0;
        const weight = Math.max(previous, value);
        // The old level continues to the step column, the new level from it.
        for (let c = start; c < stepAt; c += 1) put(fromRow, c, "─", s, previous, false, heavy);
        put(fromRow, stepAt, up ? "╯" : "╮", s, weight, true, heavy);
        put(row, stepAt, up ? "╭" : "╰", s, weight, true, heavy);
        const [lo, hi] = fromRow < row ? [fromRow, row] : [row, fromRow];
        for (let r = lo + 1; r < hi; r += 1) put(r, stepAt, "│", s, weight, true, heavy);
        for (let c = stepAt + 1; c < start + cellWidth; c += 1)
          put(row, c, "─", s, value, false, heavy);
      } else {
        for (let c = start; c < start + cellWidth; c += 1) put(row, c, "─", s, value, false, heavy);
      }
      previousLevel = level;
    }
  });

  const labelled = new Set(axisLevels(rows));
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const level = rows - 1 - row;
    const hasLabel = labelled.has(level);
    const label = !hasLabel
      ? ""
      : peak > 0
        ? formatTokens(Math.round((peak * level) / Math.max(1, rows - 1)))
        : level === 0
          ? "0"
          : "";
    const axis = dim(label.padStart(gutter - 2) + " " + (hasLabel ? "┤" : "│"));
    let body = "";
    let run = "";
    let runSeries = -1;
    const flush = (): void => {
      if (run.length === 0) return;
      const paint = runSeries >= 0 ? series[runSeries]?.paint : undefined;
      body += paint ? paint(run) : run;
      run = "";
    };
    const cells = grid[row] ?? [];
    for (let c = 0; c < plotWidth; c += 1) {
      const cell = cells[c];
      const owned = cell?.series ?? -1;
      if (owned !== runSeries) {
        flush();
        runSeries = owned;
      }
      const glyph = cell?.glyph ?? " ";
      run += cell?.heavy ? (HEAVY.get(glyph) ?? glyph) : glyph;
    }
    flush();
    lines.push(axis + body);
  }

  // Tick row: the last label is right-aligned to the plot edge and reserved
  // first; the others are placed left to right and skipped unless two spaces
  // separate them from the previous label and from the last one.
  let ticks = "";
  const lastLabel = options.ticks[samples - 1] ?? "";
  const reserved = lastLabel.length > 0 ? plotWidth - visibleWidth(lastLabel) - 2 : plotWidth;
  options.ticks.forEach((label, index) => {
    if (label.length === 0 || index === samples - 1) return;
    const place = starts[index] ?? 0;
    if (place + visibleWidth(label) > reserved) return;
    if (ticks.length > 0 && place < visibleWidth(ticks) + 2) return;
    ticks = ticks.padEnd(place) + label;
  });
  if (lastLabel.length > 0) ticks = ticks.padEnd(plotWidth - visibleWidth(lastLabel)) + lastLabel;
  lines.push(dim(" ".repeat(gutter - 1) + "└" + ticks));

  return lines;
}
