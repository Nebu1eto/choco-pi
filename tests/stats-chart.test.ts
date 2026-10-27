import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { axisLevels, columnWidths, lineChart } from "../.pi/extensions/lib/stats/chart.ts";

const id = (text: string): string => text;
const upper = (text: string): string => text.replace(/─/g, "═");

test("axis levels put a label on the baseline, the top, and every other level for odd heights", () => {
  assert.deepEqual(axisLevels(9), [8, 6, 4, 2, 0]);
  assert.deepEqual(axisLevels(7), [6, 4, 2, 0]);
  assert.deepEqual(axisLevels(5), [4, 2, 0]);
  assert.deepEqual(axisLevels(4), [3, 2, 1, 0]);
  assert.deepEqual(axisLevels(1), [0]);
});

test("column widths fill the plot width exactly, remainder on the last samples", () => {
  assert.deepEqual(columnWidths(4, 10), [2, 2, 3, 3]);
  assert.deepEqual(columnWidths(30, 73), [...Array(17).fill(2), ...Array(13).fill(3)]);
  assert.equal(
    columnWidths(30, 73).reduce((a, b) => a + b, 0),
    73,
  );
  assert.deepEqual(columnWidths(5, 3), [1, 1, 1, 1, 1], "never below one cell per sample");
});

test("the chart returns rows + 1 lines within width, labels 0 and the peak, and plots zero days on the baseline", () => {
  const values = [0, 0, 0, 10, 0, 40, 0];
  const lines = lineChart([{ values, paint: id }], {
    rows: 5,
    width: 40,
    gutter: 7,
    ticks: ["d1", "", "", "", "", "", "today"],
    dim: id,
  });
  assert.equal(lines.length, 6);
  for (const line of lines)
    assert.ok(visibleWidth(line) <= 40, `${visibleWidth(line)} > 40: ${line}`);
  assert.match(lines[0] ?? "", /^\s+40 ┤/, "the top row is labelled with the peak");
  assert.match(lines[2] ?? "", /^\s+20 ┤/, "the middle level is labelled");
  assert.match(lines[4] ?? "", /^\s+0 ┤─/, "the baseline starts with a flat run for the zero days");
  assert.match(
    lines[5] ?? "",
    /^\s+└d1.*today$/,
    "ticks: first label at the left, today at the right edge",
  );
  assert.equal(visibleWidth(lines[5] ?? ""), 40, "the tick row ends exactly at the plot edge");
  const flat = lineChart([{ values: [0, 0, 0], paint: id }], {
    rows: 3,
    width: 20,
    gutter: 7,
    ticks: ["", "", ""],
    dim: id,
  });
  assert.match(flat[2] ?? "", /^\s+0 ┤─+$/, "all-zero data is a flat baseline");
  assert.ok(!/[╭╮╰╯│]/.test(flat.join("")), "no vertical moves on flat data");
});

test("steps draw corners between levels and the higher series wins overlapping cells", () => {
  const a = [0, 100, 100, 0];
  const b = [0, 50, 50, 0];
  const lines = lineChart(
    [
      { values: a, paint: id },
      { values: b, paint: upper },
    ],
    { rows: 3, width: 15, gutter: 7, ticks: ["", "", "", ""], dim: id },
  );
  // Series a: rises at column 1 to the top row, falls at column 3; it owns the cells it crosses.
  assert.match(lines[0] ?? "", /╭─+╮/, "rising and falling corners on the top row");
  assert.match(lines[2] ?? "", /^\s+0 ┤─+╯/, "the baseline run ends at the rise");
  // Series b lives at the middle level and is drawn in its own style where it is the highest there.
  assert.match(lines[1] ?? "", /═/, "the second series keeps its own paint on its own cells");
  assert.ok(!/═/.test(lines[0] ?? ""), "the lower series never paints over the higher one");
  const samePaint: string[] = [];
  lineChart(
    [
      {
        values: [0, 10],
        paint: (t) => {
          samePaint.push(t);
          return t;
        },
      },
    ],
    { rows: 2, width: 12, gutter: 7, ticks: ["", ""], dim: id },
  );
  assert.ok(samePaint.length > 0, "painter is called for owned runs");
});

test("a chart wider than the samples stretches columns and never exceeds its width", () => {
  for (const width of [40, 54, 80, 140]) {
    const lines = lineChart(
      [
        {
          values: Array(30)
            .fill(0)
            .map((_, i) => (i % 7 === 0 ? i : 0)),
          paint: id,
        },
      ],
      { rows: 9, width, gutter: 7, ticks: Array(30).fill(""), dim: id },
    );
    assert.equal(lines.length, 10);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    assert.equal(visibleWidth(lines[0] ?? ""), width, "plot rows span the full width");
  }
});

test("every series stays connected: staggered verticals never share a column and no segment floats", () => {
  const a = [0, 0, 100, 100, 0, 0];
  const b = [0, 50, 50, 0, 80, 0];
  const c = [30, 30, 0, 0, 40, 40];
  const tag = (mark: string) => (text: string) =>
    text.replace(/[─│╭╮╰╯┼━┃┏┓┗┛╂┿╋]/g, (g) => `${mark}${g}`);
  // The heavy Total leads: never below a part, it owns every overlap, so a part
  // coincident with it is drawn as the total. Total cells are passable for all.
  const total = a.map((_, i) => (a[i] ?? 0) + (b[i] ?? 0) + (c[i] ?? 0));
  const lines = lineChart(
    [
      { values: total, paint: tag("T"), weight: "heavy" },
      { values: a, paint: tag("A") },
      { values: b, paint: tag("B") },
      { values: c, paint: tag("C") },
    ],
    { rows: 7, width: 7 + 6 * 4, gutter: 7, ticks: Array(6).fill(""), dim: (t) => t },
  );
  // Parse back into a per-series grid of occupied cells.
  const rows = lines.slice(0, -1).map((line) => line.slice(7));
  const cells = new Map<string, Array<[number, number]>>();
  // Cells of other series that a line reads through: connectors crossing it and coincident horizontals.
  const crossings: Array<[number, number]> = [];
  rows.forEach((line, r) => {
    let col = 0;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i] ?? "";
      if (/[TABC]/.test(ch)) {
        (cells.get(ch) ?? cells.set(ch, []).get(ch))?.push([r, col]);
        // Any cell of another series on this row is passable: a connector crossing the
        // line, or a coincident horizontal where two series sit at the same level.
        crossings.push([r, col]);
        i += 1;
      }
      col += 1;
    }
  });
  const passThrough = new Map<string, Array<[number, number]>>();
  const totalCells = cells.get("T") ?? [];
  for (const [series, owned] of cells) {
    const extra: Array<[number, number]> = series === "T" ? [] : [...totalCells];
    // Walk each row: from an owned cell, foreign cells are passable until the series reappears on that row
    // or its run ends inside the other line.
    const rowsOwned = new Set(owned.map(([r]) => r));
    for (const r of rowsOwned) {
      const ownedCols = new Set(owned.filter(([r1]) => r1 === r).map(([, c]) => c));
      const foreign = new Set(crossings.filter(([r1]) => r1 === r).map(([, c]) => c));
      const cols = [...ownedCols].sort((x, y) => x - y);
      for (let i = 0; i + 1 < cols.length; i += 1) {
        const from = cols[i] ?? 0;
        const to = cols[i + 1] ?? 0;
        let passable = true;
        for (let c = from + 1; c < to; c += 1) if (!foreign.has(c)) passable = false;
        if (passable) for (let c = from + 1; c < to; c += 1) extra.push([r, c]);
      }
      // A line that merges into another line's run (coincident values) continues through it.
      const last = cols[cols.length - 1] ?? 0;
      for (let c = last + 1; foreign.has(c); c += 1) extra.push([r, c]);
    }
    passThrough.set(series, extra);
  }
  for (const [series, owned] of cells) {
    // Every column from the first owned column to the last must have at least one cell of the series,
    // and consecutive occupied columns must be adjacent in row or joined by a vertical run.
    const byCol = new Map<number, number[]>();
    for (const [r, c] of owned) byCol.set(c, [...(byCol.get(c) ?? []), r]);
    // Crossing cells of other series count for continuity along a row, not for vertical runs.
    const withCrossings = new Map(byCol);
    for (const [r, c] of passThrough.get(series) ?? [])
      withCrossings.set(c, [...(withCrossings.get(c) ?? []), r]);
    const columns = [...withCrossings.keys()].sort((x, y) => x - y);
    const first = columns[0] ?? 0;
    const last = columns[columns.length - 1] ?? 0;
    for (let c = first; c <= last; c += 1)
      assert.ok(withCrossings.has(c), `series ${series} has a gap at column ${c}`);
    for (let c = first; c < last; c += 1) {
      const here = withCrossings.get(c) ?? [];
      const next = withCrossings.get(c + 1) ?? [];
      const touching = here.some((r1) => next.some((r2) => Math.abs(r1 - r2) <= 1));
      assert.ok(touching, `series ${series} breaks between columns ${c} and ${c + 1}`);
    }
    for (const [, rs] of byCol) {
      const sorted = [...rs].sort((x, y) => x - y);
      for (let i = 1; i < sorted.length; i += 1)
        assert.equal(
          sorted[i],
          (sorted[i - 1] ?? 0) + 1,
          `series ${series} has a broken vertical run at column ${[...byCol.keys()].find((c) => byCol.get(c) === rs)} rows ${sorted.join(",")}`,
        );
    }
  }
  // No two series place a vertical glyph in the same column.
  const verticalColumns = new Map<number, Set<string>>();
  rows.forEach((line) => {
    let col = 0;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i] ?? "";
      if (/[TABC]/.test(ch)) {
        if (/[│╭╮╰╯]/.test(line[i + 1] ?? ""))
          (verticalColumns.get(col) ?? verticalColumns.set(col, new Set()).get(col))?.add(ch);
        i += 1;
      }
      col += 1;
    }
  });
  for (const [col, owners] of verticalColumns)
    assert.equal(owners.size, 1, `column ${col} carries verticals of ${[...owners].join(",")}`);
});

test("tick labels keep two spaces apart and today always stays", () => {
  const ticks = Array.from({ length: 30 }, (_, i) =>
    i === 29 ? "today" : i % 7 === 0 ? `D${i}` : "",
  );
  for (const width of [40, 54, 80, 140]) {
    const lines = lineChart([{ values: Array(30).fill(1), paint: (t) => t }], {
      rows: 3,
      width,
      gutter: 7,
      ticks,
      dim: (t) => t,
    });
    const row = (lines[3] ?? "").slice(7);
    assert.ok(row.endsWith("today"), `today at the right edge at ${width}`);
    const labels = [...row.matchAll(/\S+/g)].map((m) => [m.index ?? 0, m[0]] as const);
    for (let i = 1; i < labels.length; i += 1) {
      const [prevAt, prev] = labels[i - 1] ?? [0, ""];
      const [at] = labels[i] ?? [0, ""];
      assert.ok(at - (prevAt + prev.length) >= 2, `labels touch at ${width}: ${row}`);
    }
    assert.equal(labels[0]?.[1], "D0", "the first tick is kept");
  }
});
