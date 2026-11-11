// Lines are cut for display on grapheme-cluster boundaries by display width:
// text that fits is kept whole, nothing is split inside a cluster, and no row is too wide.
import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import fc from "fast-check";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  DISPLAY_SCAN_UNITS,
  renderDiffFile,
  type DiffStyler,
} from "../.pi/extensions/lib/changes/render/diff-render.ts";
import type { DiffFile, DiffLine } from "../.pi/extensions/lib/changes/types.ts";

const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
const CLUSTERS = [
  "a",
  "Z",
  " ",
  "\t",
  "漢",
  "\u{1F600}",
  FAMILY,
  "\u{1F1EF}\u{1F1F5}",
  "e\u0301",
  "\u2764\uFE0F",
  "a\u0300\u0301\u0302\u0303\u0304",
];

/** Changed spans drawn inverted with real ANSI codes, as the theme does. */
const styler: DiffStyler = {
  fg: (_color, text) => text,
  inverse: (text) => `\u001b[7m${text}\u001b[27m`,
};

function render(oldText: string, newText: string, width: number): string[] {
  const lines: DiffLine[] = [
    { kind: "del", oldLine: 1, text: oldText },
    { kind: "add", newLine: 1, text: newText },
  ];
  const file: DiffFile = {
    path: "f",
    kind: "modified",
    hunks: [
      { id: "h", header: "@@ -1 +1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines },
    ],
    additions: 1,
    deletions: 1,
  };
  return renderDiffFile(
    file,
    { mode: "unified", width, highlight: (code) => code.split("\n"), fold: () => false },
    styler,
  )
    .slice(2)
    .map((row) => stripVTControlCharacters(row));
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const PREFIX = "1   │ - ";

test("50 family emoji that fit are all shown, with no ellipsis", () => {
  const rows = render(`A${FAMILY.repeat(50)}`, `B${FAMILY.repeat(50)}`, 120);
  assert.equal(rows[0], `1   │ - A${FAMILY.repeat(50)}`);
  assert.equal(rows[1], `  1 │ + B${FAMILY.repeat(50)}`);
});

test("generated lines: width respected, clusters whole, and text that fits kept", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...CLUSTERS), { minLength: 1, maxLength: 40 }),
      fc.array(fc.constantFrom(...CLUSTERS), { minLength: 1, maxLength: 40 }),
      fc.integer({ min: 1, max: 40 }),
      (left, right, width) => {
        const oldText = `x${left.join("")}`;
        const newText = `y${right.join("")}`;
        const rows = render(oldText, newText, width);
        for (const row of rows) {
          assert.ok(
            visibleWidth(row) <= width,
            `${visibleWidth(row)} > ${width}: ${JSON.stringify(row)}`,
          );
          assert.equal(LONE_SURROGATE.test(row), false, JSON.stringify(row));
          const code = row.slice(Math.min(row.length, PREFIX.length));
          assert.equal(/^\p{M}/u.test(code), false, JSON.stringify(row));
          assert.equal(
            code.startsWith("\u200D") || code.startsWith("\uFE0F"),
            false,
            JSON.stringify(row),
          );
        }
        const shown = oldText.replaceAll("\t", "   ");
        if (visibleWidth(PREFIX) + visibleWidth(shown) <= width) {
          assert.equal(rows[0], `${PREFIX}${shown}`);
        }
      },
    ),
    { numRuns: 400, seed: 26 },
  );
});

test("a line whose clusters outlast the scan cap ends in an ellipsis", () => {
  // Zalgo text: one base letter with thousands of combining marks is one narrow cluster.
  const zalgo = `a${"\u0301".repeat(DISPLAY_SCAN_UNITS + 10)}`;
  const rows = render("x", zalgo, 40);
  const added = rows[1] ?? "";
  assert.ok(added.endsWith("…"), "the cap is shown");
  assert.ok(visibleWidth(added) <= 40);
  assert.equal(LONE_SURROGATE.test(added), false);
});

test("a change inside a cluster emphasises the whole cluster", () => {
  const marked = (oldText: string, newText: string) => {
    const lines: DiffLine[] = [
      { kind: "del", oldLine: 1, text: oldText },
      { kind: "add", newLine: 1, text: newText },
    ];
    const file: DiffFile = {
      path: "f",
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
      additions: 1,
      deletions: 1,
    };
    const brackets: DiffStyler = { fg: (_color, text) => text, inverse: (text) => `«${text}»` };
    return renderDiffFile(
      file,
      { mode: "unified", width: 60, highlight: (code) => code.split("\n"), fold: () => false },
      brackets,
    ).slice(2);
  };
  // An accent added to a letter: the letter with its accent is the change.
  assert.equal(marked("cafe ok", "cafe\u0301 ok")[1], "  1 │ + «cafe\u0301» ok");
  // One flag for another: whole flags, never one regional indicator.
  const flags = marked("go \u{1F1EF}\u{1F1F5} now", "go \u{1F1EF}\u{1F1F2} now");
  assert.equal(flags[0], "1   │ - go «\u{1F1EF}\u{1F1F5}» now");
  assert.equal(flags[1], "  1 │ + go «\u{1F1EF}\u{1F1F2}» now");
});
