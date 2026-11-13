import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { reviewLabels, type FindingsSummary } from "../.pi/extensions/lib/changes/findings.ts";
import {
  HEADER_BOX_MIN_WIDTH,
  loadZentuiHeaderBox,
  themedHeaderBox,
  type HeaderBox,
} from "../.pi/extensions/lib/changes/view/header-box.ts";
import { plainPaneStyler, type PaneStyler } from "../.pi/extensions/lib/changes/view/rows.ts";
import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import { file, harness } from "./diff-actions-fakes.ts";
import { loadZentuiModule, SKIP_WITHOUT_ZENTUI } from "./zentui-build.ts";

/** Wraps colored text as <color>text</color>, so a test can read which color drew what. */
const TAGGING: PaneStyler = {
  ...plainPaneStyler,
  fg: (color, text) => `<${color}>${text}</${color}>`,
};

/** Accent paints with color 201, every other color with 33: real escapes, so widths stay right. */
const ACCENT = "\u001b[38;5;201m";
const TAG_THEME = reinterpretHostValue<Theme>({
  fg: (color: string, text: string) =>
    `${color === "accent" ? ACCENT : "\u001b[38;5;33m"}${text}\u001b[39m`,
  bold: (text: string) => text,
});

const BOX: HeaderBox = {
  width: 40,
  lines: ["2 files +3 -1", "Baseline: HEAD"],
  topLeft: "Diff Uncommitted changes",
  topRight: "main",
  bottomLeft: "j/k file · ? help",
  focused: true,
};

const plain = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line));

async function opened() {
  const h = harness();
  await h.fire("session_start", { reason: "startup" });
  await h.run("focus");
  h.store().ready(1, [file("src/a.ts"), file("src/b.ts")]);
  return h;
}

test("the pane's header is a box: title and source with the branch on the top border, stats inside, key hint below only while focused", async () => {
  const h = await opened();
  const focused = h.view().renderHeader(80, true);
  const unfocused = h.view().renderHeader(80, false);
  assert.equal(focused.length, unfocused.length, "focus never changes the header's height");
  for (const line of [...focused, ...unfocused]) assert.equal(visibleWidth(line), 80, line);
  assert.match(focused[0] ?? "", /^╭─ Diff Uncommitted changes ─+ main ─╮$/u);
  assert.match(focused[1] ?? "", /^│ 2 files \+2 -0 +│$/u);
  assert.match(focused.at(-1) ?? "", /^╰─ j\/k file · .* ─+╯$/u);
  assert.match(unfocused.at(-1) ?? "", /^╰─+╯$/u, "no key hint while unfocused");
  for (const line of focused.slice(1, -1)) assert.match(line, /^│ .* │$/u);
});

test("below the minimum width the header falls back to plain lines", async () => {
  const h = await opened();
  const narrow = h.view().renderHeader(HEADER_BOX_MIN_WIDTH - 1, true);
  assert.ok(
    narrow.every((line) => !/[╭╮╰╯│]/u.test(line)),
    narrow.join("\n"),
  );
  assert.match(narrow[0] ?? "", /^Diff/u);
  const boxed = h.view().renderHeader(HEADER_BOX_MIN_WIDTH, true);
  assert.match(boxed[0] ?? "", /^╭/u);
  for (const line of boxed) assert.ok(visibleWidth(line) <= HEADER_BOX_MIN_WIDTH, line);
});

test("without zentui the box takes the theme's colors: borderMuted, accent while focused", () => {
  const focused = themedHeaderBox(BOX, TAGGING);
  const unfocused = themedHeaderBox({ ...BOX, focused: false }, TAGGING);
  assert.equal(focused.length, BOX.lines.length + 2);
  assert.match(focused[0] ?? "", /^<accent>╭<\/accent>/u);
  assert.match(unfocused[0] ?? "", /^<borderMuted>╭<\/borderMuted>/u);
  assert.ok(!unfocused.join("").includes("<accent>"), "no accent while unfocused");
  const text = plain(themedHeaderBox(BOX, plainPaneStyler));
  assert.deepEqual(text, [
    "╭─ Diff Uncommitted changes ──── main ─╮",
    "│ 2 files +3 -1                        │",
    "│ Baseline: HEAD                       │",
    "╰─ j/k file · ? help ──────────────────╯",
  ]);
});

test("the review summary is short labels toned by verdict", () => {
  const summary: FindingsSummary = {
    tasks: [
      {
        workTask: "wt-ok",
        claims: new Map(),
        review: {
          kind: "parsed",
          verdict: "NO_FINDINGS",
          findings: 0,
          candidates: 0,
          agentId: "rev-1",
          completedAt: 0,
        },
      },
      {
        workTask: "wt-bad",
        claims: new Map(),
        review: {
          kind: "parsed",
          verdict: "FINDINGS",
          findings: 2,
          candidates: 1,
          agentId: "rev-1",
          completedAt: 0,
        },
      },
      {
        workTask: "wt-part",
        claims: new Map(),
        review: {
          kind: "parsed",
          verdict: "INCOMPLETE",
          findings: 0,
          candidates: 0,
          agentId: "rev-1",
          completedAt: 0,
        },
      },
      {
        workTask: "wt-gone",
        claims: new Map(),
        review: { kind: "unrecorded", agentId: "rev-2", completedAt: 0, reason: "no record" },
      },
    ],
    findings: [],
    malformed: 1,
    errors: ["boom"],
  };
  assert.deepEqual(reviewLabels(summary), [
    { text: "wt-ok ✓", tone: "success" },
    { text: "wt-bad ⚑2 ?1", tone: "error" },
    { text: "wt-part incomplete", tone: "warning" },
    { text: "wt-gone unrecorded", tone: "warning" },
    { text: "1 malformed record", tone: "warning" },
    { text: "1 read error", tone: "warning" },
  ]);
});

test("a zentui renderer that throws, draws the wrong shape or is missing leaves the theme's box", async () => {
  const h = await opened();
  const expected = h.view().renderHeader(80, true);
  h.view().headerBox = () => {
    throw new Error("zentui broke");
  };
  assert.deepEqual(h.view().renderHeader(80, true), expected);
  assert.equal(
    await loadZentuiHeaderBox(
      () => TAG_THEME,
      async () => ({ renderLabeledBox: undefined, loadConfig: () => ({}) }),
    ),
    undefined,
    "an older zentui without renderLabeledBox",
  );
  const shortBox = await loadZentuiHeaderBox(
    () => TAG_THEME,
    async () => ({ renderLabeledBox: () => ["one line"], loadConfig: () => ({}) }),
  );
  assert.ok(shortBox);
  assert.equal(shortBox(BOX), undefined, "a box of the wrong height is refused");
  assert.equal(
    await loadZentuiHeaderBox(
      () => TAG_THEME,
      async () => {
        throw new Error("not installed");
      },
    ),
    undefined,
  );
});

test(
  "with zentui the header is drawn by its renderLabeledBox in the editor's border color, accent while focused",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const box = await loadZentuiHeaderBox(
      () => TAG_THEME,
      async () => {
        const [editor, config] = await Promise.all([
          loadZentuiModule("minimalist-editor.js"),
          loadZentuiModule("config.js"),
        ]);
        return { renderLabeledBox: editor["renderLabeledBox"], loadConfig: config["loadConfig"] };
      },
    );
    assert.ok(box, "zentui's box loads");
    const focused = box(BOX);
    const unfocused = box({ ...BOX, focused: false });
    assert.ok(focused && unfocused);
    assert.equal(focused.length, BOX.lines.length + 2);
    const text = plain(focused);
    assert.match(text[0] ?? "", /^╭─ Diff Uncommitted changes ─+ main ─╮$/u);
    assert.match(text[1] ?? "", /^│ 2 files \+3 -1 +│$/u);
    assert.match(text.at(-1) ?? "", /^╰─ j\/k file · \? help ─+╯$/u);
    for (const line of text) assert.equal(visibleWidth(line), BOX.width, line);
    assert.ok((focused[0] ?? "").includes(`${ACCENT}╭`), "focused: accent border");
    assert.ok(!(unfocused[0] ?? "").includes(ACCENT), "unfocused: the editor's border color");

    const h = await opened();
    h.view().headerBox = box;
    const header = plain(h.view().renderHeader(80, true));
    assert.match(header[0] ?? "", /^╭─ Diff Uncommitted changes ─+ main ─╮$/u);
  },
);
