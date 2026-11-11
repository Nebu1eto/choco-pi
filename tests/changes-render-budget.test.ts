// One work budget covers a whole body render of the changes view: split view does
// not render a file twice, every expanded file in a frame shares the budget, and a warm cache
// spends nothing.
import assert from "node:assert/strict";
import test from "node:test";
import type { FileBody, FileSummary } from "../.pi/extensions/lib/changes/git/model.ts";
import {
  createIntralineBudget,
  HIGHLIGHT_FRAME_CHARS,
  INTRALINE_RENDER_CELLS,
  renderDiffFile,
  withRenderBudget,
} from "../.pi/extensions/lib/changes/render/diff-render.ts";
import { renderHunkRows } from "../.pi/extensions/lib/changes/view/body-block.ts";
import {
  ChangesView,
  renderUnifiedBody,
  type FileBodyRenderer,
} from "../.pi/extensions/lib/changes/view/changes-view.ts";
import { plainPaneStyler } from "../.pi/extensions/lib/changes/view/rows.ts";
import type { DiffHunk } from "../.pi/extensions/lib/changes/types.ts";
import { file, flush, hunk, snapshot, textBody } from "./diff-actions-fakes.ts";

/** Hunks where each pair costs 65 x 65 cells with no common prefix or suffix. */
function heavyHunks(path: string, count: number): DiffHunk[] {
  return Array.from({ length: count }, (_, index) =>
    hunk(`${path}-${index}`, 1 + index * 10, [`-${"a,".repeat(32)}`, `+${"b;".repeat(32)}`]),
  );
}

function mount(
  files: FileSummary[],
  bodies: Map<string, FileBody>,
  options: { split?: boolean; renderer?: FileBodyRenderer } = {},
) {
  let calls = 0;
  const counting: FileBodyRenderer = (diffFile, width, styler, layout) => {
    calls += 1;
    return (options.renderer ?? renderUnifiedBody)(diffFile, width, styler, layout);
  };
  const view = new ChangesView({
    store: {
      loadFile: async (path: string) => ({
        revision: 1,
        body: bodies.get(path) ?? { kind: "gone" },
      }),
    },
    styler: plainPaneStyler,
    renderFileBody: counting,
    keyHint: "",
    helpLines: [],
    actions: {
      unfocus: () => {},
      close: () => {},
      resizeBy: () => {},
      refresh: () => {},
      requestRender: () => {},
      isToggleKey: () => false,
      isFocusKey: () => false,
    },
    cursor: options.split === true ? "line" : "hunk",
    mode: () => (options.split === true ? "split" : "unified"),
  });
  view.setState({ kind: "ready", snapshot: snapshot(1, files), refreshing: false });
  return { view, calls: () => calls };
}

function spent(view: ChangesView): number {
  return view.lastRenderBudget?.spent ?? -1;
}

test("300 split-view hunks are rendered once, within one frame's budget", async () => {
  const a = file("a.txt");
  const { view, calls } = mount(
    [a],
    new Map([["a.txt", textBody("a.txt", heavyHunks("a", 300))]]),
    {
      split: true,
    },
  );
  view.expand("a.txt");
  await flush();
  const before = calls();
  const rows = view.renderBody(160, true);
  assert.ok(rows.length > 300);
  assert.equal(calls() - before, 1, "the file body is rendered once");
  assert.ok(spent(view) > 0 && spent(view) <= INTRALINE_RENDER_CELLS, `spent ${spent(view)}`);
  assert.ok((view.lastRenderBudget?.fallbacks ?? 0) > 0, "pairs past the budget fall back");
});

test("many expanded files in one frame share one budget", async () => {
  const files = Array.from({ length: 10 }, (_, index) => file(`f${index}.txt`));
  const bodies = new Map(
    files.map((entry) => [entry.path, textBody(entry.path, heavyHunks(entry.path, 60))] as const),
  );
  const { view } = mount(files, bodies);
  for (const entry of files) view.expand(entry.path);
  await flush();
  view.renderBody(120, true);
  assert.ok(spent(view) <= INTRALINE_RENDER_CELLS, `spent ${spent(view)}`);
  assert.equal(view.lastRenderBudget?.pairs, 600);
});

test("repeated frames with a warm cache spend nothing; a new width spends one frame's budget", async () => {
  const a = file("a.txt");
  const { view } = mount([a], new Map([["a.txt", textBody("a.txt", heavyHunks("a", 300))]]));
  view.expand("a.txt");
  await flush();
  view.renderBody(120, true);
  assert.ok(spent(view) > 0);
  for (let frame = 0; frame < 5; frame += 1) {
    view.renderBody(120, true);
    assert.equal(spent(view), 0, "cache hit");
  }
  for (let width = 100; width < 105; width += 1) {
    view.renderBody(width, true);
    assert.ok(spent(view) <= INTRALINE_RENDER_CELLS, "each resize frame is bounded");
  }
});

test("renderHunkRows divides one render by the given row counts", () => {
  const hunks = heavyHunks("x", 3);
  let calls = 0;
  const budget = createIntralineBudget();
  const rows = withRenderBudget(budget, () =>
    renderHunkRows(
      { path: "x", kind: "modified" as const, hunks, additions: 3, deletions: 3 },
      (part) => {
        calls += 1;
        return renderUnifiedBody(part, 120, plainPaneStyler, {
          mode: "split",
          fold: () => false,
          foldReason: () => undefined,
        });
      },
      () => 2,
    ),
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    rows.map((part) => part.lines.length),
    [2, 2, 2],
  );
  assert.ok(budget.spent > 0, "the enclosing frame's budget was used");
});

test("syntax highlighting in one frame is bounded across files", async () => {
  // 10 files of 2,000 lines of 100 characters: 2 MB of text, twice the frame's highlighting.
  const files = Array.from({ length: 10 }, (_, index) => file(`h${index}.ts`));
  const bodies = new Map(
    files.map(
      (entry) =>
        [
          entry.path,
          textBody(entry.path, [
            hunk(
              `${entry.path}-h`,
              1,
              Array.from({ length: 2_000 }, () => `+${"c".repeat(100)}`),
            ),
          ]),
        ] as const,
    ),
  );
  let highlighted = 0;
  const renderer: FileBodyRenderer = (diffFile, width) =>
    renderDiffFile(diffFile, {
      mode: "unified",
      width,
      highlight: (code) => {
        highlighted += code.length;
        return code.split("\n");
      },
      fold: () => false,
    }).slice(1);
  const { view } = mount(files, bodies, { renderer });
  for (const entry of files) view.expand(entry.path);
  await flush();
  view.renderBody(120, true);
  assert.ok(highlighted <= HIGHLIGHT_FRAME_CHARS, `highlighted ${highlighted}`);
  assert.ok((view.lastRenderBudget?.highlightSkipped ?? 0) > 0);
});
