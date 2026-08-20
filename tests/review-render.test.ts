import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  effectiveDiffMode,
  MIN_SPLIT_WIDTH,
  renderDiffFile,
} from "../.pi/extensions/review/core/render/diff-render.ts";
import type {
  DiffStyleBackground,
  DiffStyler,
} from "../.pi/extensions/review/core/render/diff-render.ts";
import { createHighlight } from "../.pi/extensions/review/core/render/highlight.ts";
import type {
  DiffFile,
  DiffRenderOptions,
  HighlightFn,
  ResolvedReviewConfig,
} from "../.pi/extensions/review/core/types.ts";

initTheme("dark", false);

const highlightConfig: ResolvedReviewConfig["highlight"] = {
  enabled: true,
  maxFileBytes: 100_000,
  maxDiffLines: 1_000,
};

const file: DiffFile = {
  path: "src/sample.ts",
  kind: "modified",
  additions: 1,
  deletions: 1,
  hunks: [
    {
      id: "sample-hunk",
      header: "@@ -1,3 +1,3 @@ function sample()",
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [
        { kind: "context", oldLine: 1, newLine: 1, text: "function sample() {" },
        { kind: "del", oldLine: 2, text: "  return colour;" },
        { kind: "add", newLine: 2, text: "  return color;" },
        { kind: "context", oldLine: 3, newLine: 3, text: "}" },
      ],
    },
  ],
};

const plainHighlight: HighlightFn = (code) => code.split("\n");

const TEST_BACKGROUNDS: Record<DiffStyleBackground, string> = {
  toolSuccessBg: "\u001b[48;2;20;48;20m",
  toolErrorBg: "\u001b[48;2;56;20;20m",
};

const testStyler: DiffStyler = {
  fg: (color, text) => {
    const code = color === "toolDiffAdded" ? 32 : color === "toolDiffRemoved" ? 31 : 36;
    return `\u001b[${code}m${text}\u001b[39m`;
  },
  bg: (color, text) => `${TEST_BACKGROUNDS[color]}${text}\u001b[49m`,
  inverse: (text) => `\u001b[7m${text}\u001b[27m`,
  getFgAnsi: (color) =>
    color === "toolDiffAdded"
      ? "\u001b[38;2;100;220;100m"
      : color === "toolDiffRemoved"
        ? "\u001b[38;2;230;100;100m"
        : "\u001b[38;2;180;180;180m",
  getBgAnsi: (color) => TEST_BACKGROUNDS[color],
  getColorMode: () => "truecolor",
};

function options(overrides: Partial<DiffRenderOptions> = {}): DiffRenderOptions {
  return {
    mode: "unified",
    width: 120,
    highlight: plainHighlight,
    fold: () => false,
    ...overrides,
  };
}

const COMPLETE_ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const ANSI_AT_START = /^\u001b(?:\[([0-?]*[ -/]*)([@-~])|\][^\u0007]*(?:\u0007|\u001b\\))/;

type BackgroundScan = { columns: string[]; final: string };

function scanBackgrounds(line: string): BackgroundScan {
  const columns: string[] = [];
  let active = "default";
  let index = 0;
  while (index < line.length) {
    if (line[index] === "\u001b") {
      const match = line.slice(index).match(ANSI_AT_START);
      assert.ok(match, `partial escape in ${JSON.stringify(line)}`);
      if (match[2] === "m") {
        const values = match[1] === "" ? [0] : match[1]!.split(";").map(Number);
        for (let parameter = 0; parameter < values.length; parameter += 1) {
          const value = values[parameter];
          if (value === 0 || value === 49) active = "default";
          else if ((value === 38 || value === 48) && values[parameter + 1] === 2) {
            if (value === 48) {
              active = `rgb:${values[parameter + 2]},${values[parameter + 3]},${values[parameter + 4]}`;
            }
            parameter += 4;
          } else if ((value === 38 || value === 48) && values[parameter + 1] === 5) {
            if (value === 48) active = `ansi256:${values[parameter + 2]}`;
            parameter += 2;
          }
        }
      }
      index += match[0].length;
      continue;
    }
    const codePoint = line.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    for (let column = 0; column < visibleWidth(character); column += 1) columns.push(active);
    index += character.length;
  }
  return { columns, final: active };
}

function assertNoPartialEscape(line: string): void {
  assert.equal(line.replace(COMPLETE_ANSI, "").includes("\u001b"), false, JSON.stringify(line));
}

test("Pi highlighting preserves one output entry per input line and emits ANSI for TypeScript", () => {
  const highlight = createHighlight({
    config: highlightConfig,
    filePath: "sample.ts",
    fileBytes: 80,
    diffLines: 2,
  });
  const source = "const answer: number = 42;\nconsole.log(answer);";
  const rendered = highlight(source);
  assert.equal(rendered.length, source.split("\n").length);
  assert.ok(rendered.some((line) => line.includes("\u001b[")));
});

test("disabled and over-limit highlighting fall back to escape-free plain text", () => {
  const source = "const answer = 42;\nanswer++;";
  for (const highlight of [
    createHighlight({ config: { ...highlightConfig, enabled: false }, filePath: "sample.ts" }),
    createHighlight({ config: highlightConfig, filePath: "sample.ts", fileBytes: 100_001 }),
    createHighlight({ config: highlightConfig, filePath: "sample.ts", diffLines: 1_001 }),
  ]) {
    assert.deepEqual(highlight(source), source.split("\n"));
    assert.doesNotMatch(highlight(source).join(""), /\u001b/);
  }
});

test("unified gutters number the old and new sides independently", () => {
  const rendered = renderDiffFile(file, options()).map(stripTerminalSequences);
  assert.match(rendered[2], /^1 1 │   function sample/);
  assert.match(rendered[3], /^2   │ -   return colour/);
  assert.match(rendered[4], /^  2 │ \+   return color/);
  assert.match(rendered[5], /^3 3 │   }/);
});

test("a minimal styler renders the complete diff without optional color capabilities", () => {
  const minimalStyler: DiffStyler = {
    fg: (_color, text) => text,
    inverse: (text) => text,
  };
  const rendered = renderDiffFile(file, options(), minimalStyler);
  assert.equal(rendered.length, 6);
  assert.match(rendered[3]!, /^2   │ -   return colour/);
  assert.match(rendered[4]!, /^  2 │ \+   return color/);
  for (const line of rendered) {
    assertNoPartialEscape(line);
    assert.doesNotMatch(line, /\u001b/);
  }
});

test("a folded hunk is replaced by its caller-supplied reason", () => {
  const rendered = renderDiffFile(file, {
    ...options(),
    fold: () => true,
    foldReason: () => "generated file",
  }).map(stripTerminalSequences);
  assert.equal(rendered.length, 2);
  assert.match(rendered[1], /generated file/);
  assert.match(rendered[1], /@@ -1,3 \+1,3 @@/);
});

test(`split view falls back to unified below ${MIN_SPLIT_WIDTH} columns`, () => {
  assert.equal(
    effectiveDiffMode(options({ mode: "split", width: MIN_SPLIT_WIDTH - 1 })),
    "unified",
  );
  assert.equal(effectiveDiffMode(options({ mode: "split", width: MIN_SPLIT_WIDTH })), "split");

  const narrow = renderDiffFile(file, options({ mode: "split", width: MIN_SPLIT_WIDTH - 1 }));
  const wide = renderDiffFile(file, options({ mode: "split", width: MIN_SPLIT_WIDTH }));
  assert.equal(narrow.length, 6);
  assert.equal(wide.length, 5);
});

test("unified additions and removals fill the render width and emphasize changed spans", () => {
  const width = 48;
  const rendered = renderDiffFile(file, options({ width }), testStyler);
  for (const lineIndex of [3, 4]) {
    const scan = scanBackgrounds(rendered[lineIndex]!);
    assert.equal(scan.columns.length, width);
    assert.equal(scan.columns.includes("default"), false);
    assert.ok(new Set(scan.columns).size >= 2, "changed span should use a stronger background");
    assert.equal(scan.final, "default");
  }
});

test("split additions and removals fill their own columns, not the divider", () => {
  const width = MIN_SPLIT_WIDTH;
  const leftWidth = Math.floor((width - 3) / 2);
  const rightWidth = width - 3 - leftWidth;
  const rendered = renderDiffFile(file, options({ mode: "split", width }), testStyler);
  const scan = scanBackgrounds(rendered[3]!);
  assert.equal(scan.columns.length, width);
  assert.equal(scan.columns.slice(0, leftWidth).includes("default"), false);
  assert.deepEqual(scan.columns.slice(leftWidth, leftWidth + 3), ["default", "default", "default"]);
  assert.equal(scan.columns.slice(-rightWidth).includes("default"), false);
  assert.equal(scan.final, "default");
});

test("line backgrounds resume after syntax highlighting resets", () => {
  const highlight: HighlightFn = (code) =>
    code
      .split("\n")
      .map((line) =>
        [
          "\u001b[38;2;120;160;220m",
          line.slice(0, 5),
          "\u001b[0m",
          line.slice(5, 10),
          "\u001b[49m",
          line.slice(10),
        ].join(""),
      );
  const rendered = renderDiffFile(file, options({ highlight, width: 52 }), testStyler);
  for (const lineIndex of [3, 4]) {
    const scan = scanBackgrounds(rendered[lineIndex]!);
    assert.equal(scan.columns.length, 52);
    assert.equal(scan.columns.includes("default"), false);
    assert.equal(scan.final, "default");
  }
});

test("ANSI-aware truncation leaves complete escapes and terminated backgrounds at tested widths", () => {
  const highlight = createHighlight({ config: highlightConfig, filePath: file.path });
  for (const width of [1, 2, 5, 12, MIN_SPLIT_WIDTH - 1, MIN_SPLIT_WIDTH, 120]) {
    for (const mode of ["unified", "split"] as const) {
      for (const line of renderDiffFile(file, options({ highlight, mode, width }), testStyler)) {
        assert.ok(visibleWidth(line) <= width, `${mode} width ${width}: ${JSON.stringify(line)}`);
        assertNoPartialEscape(line);
        assert.equal(scanBackgrounds(line).final, "default", JSON.stringify(line));
      }
    }
  }
});
