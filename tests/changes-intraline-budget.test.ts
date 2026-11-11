// Intraline matching and syntax highlighting are bounded by what a terminal can show.
// These tests count work through the render's budget object and an injected highlighter; none
// allocates more than a few megabytes, including on the code path the bound replaced.
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createIntralineBudget,
  INTRALINE_MAX_TOKENS,
  INTRALINE_RENDER_CELLS,
  HIGHLIGHT_MAX_LINE_CHARS,
  renderDiffFile,
  type DiffStyler,
} from "../.pi/extensions/lib/changes/render/diff-render.ts";
import type { DiffFile, DiffLine } from "../.pi/extensions/lib/changes/types.ts";

/** Changed spans are marked with « », which ANSI resets never contain, so a test can see what was emphasised. */
const marking: DiffStyler = { fg: (_color, text) => text, inverse: (text) => `«${text}»` };

function fileOf(lines: DiffLine[]): DiffFile {
  return {
    path: "f.txt",
    kind: "modified",
    hunks: [
      {
        id: "h",
        header: "@@ -1 +1 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines,
      },
    ],
    additions: lines.filter((line) => line.kind === "add").length,
    deletions: lines.filter((line) => line.kind === "del").length,
  };
}

function pairs(texts: Array<[string, string]>): DiffLine[] {
  return [
    ...texts.map(([old], index): DiffLine => ({ kind: "del", oldLine: index + 1, text: old })),
    ...texts.map(([, next], index): DiffLine => ({ kind: "add", newLine: index + 1, text: next })),
  ];
}

const plainHighlight = (code: string) => code.split("\n");

function render(
  file: DiffFile,
  width: number,
  options: { highlight?: (code: string) => string[] } = {},
) {
  const budget = createIntralineBudget();
  const lines = renderDiffFile(
    file,
    {
      mode: "unified",
      width,
      highlight: options.highlight ?? plainHighlight,
      fold: () => false,
      intraline: budget,
    },
    marking,
  );
  return { lines, budget };
}

test("a long line is matched only over the columns the pane can show", () => {
  // 3,000 tokens a side: the unbounded matcher would compute 9 million cells for this pair.
  const old = "x,".repeat(1_500);
  const { lines, budget } = render(fileOf(pairs([[old, `${old}y`]])), 60);
  assert.equal(budget.pairs, 1);
  assert.ok(budget.spent <= 61 * 61, `spent ${budget.spent}`);
  // The change is beyond the visible columns, so nothing visible is emphasised.
  assert.equal(
    lines.some((line) => line.includes("«")),
    false,
  );
  for (const line of lines) assert.ok(visibleWidth(line) <= 60, `width ${visibleWidth(line)}`);
});

test("differences throughout a long line are matched on the visible part only", () => {
  // No common prefix or suffix: unclipped, 3,000 tokens a side would exceed every bound.
  const old = Array.from({ length: 1_500 }, (_, index) => `o${index}`).join(" y ");
  const next = Array.from({ length: 1_500 }, (_, index) => `n${index}`).join(" y ");
  const { lines, budget } = render(fileOf(pairs([[old, next]])), 60);
  assert.equal(budget.pairs, 1);
  assert.equal(budget.fallbacks, 0);
  assert.ok(budget.spent > 0 && budget.spent <= 62 * 62, `spent ${budget.spent}`);
  assert.equal(lines.filter((line) => line.includes("«")).length, 2);
});

test("a visible change in a long line is still emphasised", () => {
  const tail = "z".repeat(5_000);
  const { lines, budget } = render(
    fileOf(pairs([[`let a = 1; ${tail}`, `let a = 2; ${tail}`]])),
    80,
  );
  assert.equal(budget.pairs, 1);
  assert.equal(budget.fallbacks, 0);
  assert.equal(lines.filter((line) => line.includes("«1»") || line.includes("«2»")).length, 2);
});

test("a pair whose differing middle is too long falls back to whole-line highlighting", () => {
  const old = Array.from({ length: INTRALINE_MAX_TOKENS + 10 }, (_, index) => `a${index}`).join(
    " ",
  );
  const next = Array.from({ length: INTRALINE_MAX_TOKENS + 10 }, (_, index) => `b${index}`).join(
    " ",
  );
  const { lines, budget } = render(fileOf(pairs([[old, next]])), 4_000);
  assert.equal(budget.pairs, 1);
  assert.equal(budget.fallbacks, 1);
  assert.equal(budget.spent, 0, "no matrix was built");
  assert.equal(
    lines.some((line) => line.includes("«")),
    false,
  );
});

test("many medium pairs in one render share one budget", () => {
  // 60 words and their spaces: 119 tokens a side, under the per-pair cap; 300 pairs exceed the budget.
  const texts: Array<[string, string]> = [];
  for (let row = 0; row < 300; row += 1) {
    const old = Array.from({ length: 60 }, (_, index) => `o${row}x${index}`).join(" ");
    const next = Array.from({ length: 60 }, (_, index) => `n${row}x${index}`).join(" ");
    texts.push([old, next]);
  }
  const { budget } = render(fileOf(pairs(texts)), 4_000);
  assert.equal(budget.pairs, 300);
  assert.ok(budget.spent <= INTRALINE_RENDER_CELLS, `spent ${budget.spent}`);
  assert.ok(budget.fallbacks > 0, "pairs beyond the budget fall back");
});

test("a hunk with a line longer than the highlighting limit is not syntax-highlighted", () => {
  let calls = 0;
  const counting = (code: string) => {
    calls += 1;
    return code.split("\n");
  };
  render(fileOf(pairs([["short", "short2"]])), 80, { highlight: counting });
  assert.equal(calls, 1);
  const long = "q".repeat(HIGHLIGHT_MAX_LINE_CHARS + 1);
  const { lines } = render(fileOf(pairs([["short", long]])), 80, { highlight: counting });
  assert.equal(calls, 1, "the highlighter is not called");
  for (const line of lines) assert.ok(visibleWidth(line) <= 80);
});
