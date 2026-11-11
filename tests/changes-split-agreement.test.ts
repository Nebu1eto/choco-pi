// The renderer and the body layout share one split pairing: the rows drawn and the rows mapped never disagree.
import assert from "node:assert/strict";
import test from "node:test";
import { parseGitDiff } from "../.pi/extensions/lib/changes/patch.ts";
import { renderDiffFile } from "../.pi/extensions/lib/changes/render/diff-render.ts";
import type { DiffFile } from "../.pi/extensions/lib/changes/types.ts";
import {
  bodyBlock,
  renderHunkRows,
  splitRowCount,
} from "../.pi/extensions/lib/changes/view/body-block.ts";

const plain = { fg: (_color: string, text: string) => text, inverse: (text: string) => text };

/** One hunk body as patch lines: " " context, "-" deletion, "+" addition, "\\" a no-newline marker. */
type HunkCase = { name: string; body: string };

const HUNK_CASES: readonly HunkCase[] = [
  { name: "three deletions, one addition", body: " -  -  -  + " },
  { name: "one deletion, three additions", body: " -  +  +  + " },
  { name: "runs of context", body: "   -  +       " },
  { name: "consecutive replacement groups", body: " - + - - + + + - " },
  { name: "replacements back to back", body: "--+++-+--+" },
  { name: "all deletions", body: "----" },
  { name: "all additions", body: "++++" },
  { name: "lone additions between context", body: " + + + " },
  { name: "no newline at the end, both sides", body: " -\\+\\" },
  { name: "no newline after an uneven replacement", body: " ---+\\" },
];

/** A parsed file from `hunkCase`; every line's text is unique, so a row can be matched to its line. */
function fileOf(hunkCase: HunkCase): DiffFile {
  const lines: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let serial = 0;
  for (const mark of hunkCase.body) {
    if (mark === "\\") {
      lines.push("\\ No newline at end of file");
      continue;
    }
    serial += 1;
    lines.push(`${mark}<line ${serial}>`);
    if (mark !== "+") oldCount += 1;
    if (mark !== "-") newCount += 1;
  }
  const patch = [
    "diff --git a/g.ts b/g.ts",
    "--- a/g.ts",
    "+++ b/g.ts",
    `@@ -${oldCount === 0 ? 0 : 1},${oldCount} +${newCount === 0 ? 0 : 1},${newCount} @@`,
    ...lines,
    "",
  ].join("\n");
  const file = parseGitDiff(patch, "b", "h").files[0];
  assert.ok(file, hunkCase.name);
  return file;
}

test("for generated hunks the rows drawn equal the rows mapped, and each line's row shows that line", () => {
  for (const hunkCase of HUNK_CASES) {
    const file = fileOf(hunkCase);
    const hunk = file.hunks[0];
    assert.ok(hunk, hunkCase.name);
    for (const mode of ["split", "unified"] as const) {
      const label = `${hunkCase.name} (${mode})`;
      const options = {
        mode,
        width: 160,
        highlight: (code: string) => code.split("\n"),
        fold: () => false,
      };
      const rows = renderHunkRows(file, (shown) => renderDiffFile(shown, options, plain).slice(1));
      const drawn = (rows[0]?.lines.length ?? 0) - 1;
      const expected = mode === "split" ? splitRowCount(hunk) : hunk.lines.length;
      assert.equal(drawn, expected, `${label}: rows drawn`);
      const block = bodyBlock({ hunks: [hunk], rows, width: 162, styler: plain, mode });
      const header = block.hunkStart.get(hunk.id) ?? -1;
      hunk.lines.forEach((line, index) => {
        const row = block.rowOfLine(hunk.id, index);
        assert.ok(
          row !== undefined && row > header,
          `${label}: line ${index} maps below the header`,
        );
        assert.ok(
          (block.lines[row] ?? "").includes(line.text),
          `${label}: line ${index}'s row shows it`,
        );
      });
    }
  }
});
