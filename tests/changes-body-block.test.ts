import assert from "node:assert/strict";
import test from "node:test";
import { renderDiffFile } from "../.pi/extensions/lib/changes/render/diff-render.ts";
import { buildCommentAnchor } from "../.pi/extensions/review/core/anchor.ts";
import { baseRecord, mount, NOW } from "./review-safety-fakes.ts";
import type { DiffFile, DiffHunk } from "../.pi/extensions/lib/changes/types.ts";
import {
  bodyBlock,
  hunkRowOfLine,
  renderHunkRows,
  splitRowForLine,
  type BodyAnnotation,
} from "../.pi/extensions/lib/changes/view/body-block.ts";

const plain = { fg: (_color: string, text: string) => text, inverse: (text: string) => `«${text}` };

/** context, two deletions, three additions, context: the pairs are unequal. */
const HUNK: DiffHunk = {
  id: "h1",
  header: "@@ -1,4 +1,5 @@",
  oldStart: 1,
  oldLines: 4,
  newStart: 1,
  newLines: 5,
  lines: [
    { kind: "context", oldLine: 1, newLine: 1, text: "keep" },
    { kind: "del", oldLine: 2, text: "old a" },
    { kind: "del", oldLine: 3, text: "old b" },
    { kind: "add", newLine: 2, text: "new a" },
    { kind: "add", newLine: 3, text: "new b" },
    { kind: "add", newLine: 4, text: "new c" },
    { kind: "context", oldLine: 4, newLine: 5, text: "tail" },
  ],
};
const FILE: DiffFile = {
  path: "f.ts",
  kind: "modified",
  additions: 3,
  deletions: 2,
  hunks: [HUNK],
};

function layout(mode: "unified" | "split", annotations: BodyAnnotation[], folded = false) {
  const options = {
    mode,
    width: 118,
    highlight: (code: string) => code.split("\n"),
    fold: () => folded,
  };
  const rows = renderHunkRows(FILE, (file) => renderDiffFile(file, options, plain).slice(1));
  return bodyBlock({ hunks: FILE.hunks, rows, width: 120, styler: plain, mode, annotations });
}

const note = (place: BodyAnnotation["place"], text: string): BodyAnnotation => ({
  hunkId: "h1",
  place,
  lines: [text],
});

test("split rows pair deletions with additions; unequal runs take the longer run's rows", () => {
  assert.deepEqual(
    HUNK.lines.map((_line, index) => splitRowForLine(HUNK, index)),
    [0, 1, 2, 1, 2, 3, 4],
  );
  // Unified: one row per line after the header; split: the paired rows.
  assert.equal(hunkRowOfLine(HUNK, 8, 5, "unified"), 6);
  assert.equal(hunkRowOfLine(HUNK, 6, 5, "split"), 4);
  assert.equal(hunkRowOfLine(HUNK, 2, 5, "unified"), undefined, "rows that do not map");
});

test("unified: an annotation sits after its line, rowOfLine counts the rows before it", () => {
  const block = layout("unified", [note({ afterLine: 3 }, "NOTE")]);
  const at = block.lines.indexOf("NOTE");
  assert.match(block.lines[at - 1] ?? "", /new a/);
  assert.equal(block.annotationRows[0], at);
  assert.equal(block.rowOfLine("h1", 3), at - 1);
  assert.match(block.lines[block.rowOfLine("h1", 4) ?? -1] ?? "", /new b/, "rows below shift down");
  assert.ok(
    block.lines.every((line) => line === "NOTE" || line.startsWith("  ")),
    "gutter",
  );
});

test("split: an annotation after a deleted line sits after its paired row", () => {
  const block = layout("split", [note({ afterLine: 2 }, "NOTE")]);
  const at = block.lines.indexOf("NOTE");
  const paired = block.lines[at - 1] ?? "";
  assert.match(paired, /old b/);
  assert.match(paired, /new b/, "the row pairs old b with new b");
  assert.equal(block.rowOfLine("h1", 4), at - 1, "new b maps to the same row");
  assert.match(block.lines[block.rowOfLine("h1", 5) ?? -1] ?? "", /new c/);
});

test("a folded hunk and a header annotation: notes go after the only row", () => {
  const folded = layout("unified", [note({ afterLine: 3 }, "LINE"), note("header", "HEAD")], true);
  assert.equal(folded.lines.length, 3);
  assert.match(folded.lines[0] ?? "", /@@ -1,4 \+1,5 @@/);
  assert.equal(folded.rowOfLine("h1", 3), 0, "a folded hunk's lines resolve to its header row");

  const open = layout("unified", [note("header", "HEAD"), note("end", "END")]);
  assert.equal(open.lines[1], "HEAD");
  assert.equal(open.lines.at(-1), "END");
});

test("the marked hunk carries the gutter marker; inverted rows invert whole", () => {
  const rows = renderHunkRows(FILE, (file) =>
    renderDiffFile(
      file,
      { mode: "unified", width: 118, highlight: (code) => code.split("\n"), fold: () => false },
      plain,
    ).slice(1),
  );
  const block = bodyBlock({
    hunks: FILE.hunks,
    rows,
    width: 120,
    styler: plain,
    markedHunkId: "h1",
    inverted: new Map([["h1", new Set([2])]]),
    headerSuffix: () => "✓",
  });
  assert.match(block.lines[0] ?? "", /^▌ @@ -1,4 \+1,5 @@ ✓$/);
  assert.match(block.lines[2] ?? "", /^«▌ .*old a/);
  assert.equal(block.lines.filter((line) => line.startsWith("«")).length, 1);
});

test("review: a comment on an added line sits under its paired row in split mode", async () => {
  const comment = {
    id: "c1",
    path: "f.ts",
    side: "RIGHT" as const,
    line: 3,
    body: "on new b",
    anchor: buildCommentAnchor(HUNK, "RIGHT", 3),
    createdAt: NOW,
    updatedAt: NOW,
  };
  const model = { baseSha: "b", headSha: "h", files: [FILE] };
  const view = await mount({ model, record: baseRecord(model, { comments: [comment] }) });
  for (const mode of ["unified", "split"]) {
    const lines = view.render(160);
    const at = lines.findIndex((line) => line.includes("on new b"));
    assert.ok(at > 0, mode);
    assert.match(lines[at - 1] ?? "", /new b/, `${mode}: under the row that shows new b`);
    assert.doesNotMatch(lines[at - 1] ?? "", /new c/, mode);
    await view.press("v");
  }
});

/* ------------------------------------------ uneven replacements at a hunk's end */

function unevenHunk(deleted: number, added: number): DiffHunk {
  const lines: DiffHunk["lines"] = [{ kind: "context", oldLine: 1, newLine: 1, text: "keep" }];
  for (let index = 0; index < deleted; index += 1) {
    lines.push({ kind: "del", oldLine: 2 + index, text: `gone ${index}` });
  }
  for (let index = 0; index < added; index += 1) {
    lines.push({ kind: "add", newLine: 2 + index, text: `made ${index}` });
  }
  return {
    id: `u${deleted}-${added}`,
    header: `@@ -1,${1 + deleted} +1,${1 + added} @@`,
    oldStart: 1,
    oldLines: 1 + deleted,
    newStart: 1,
    newLines: 1 + added,
    lines,
  };
}

test("every line of a hunk ending in an uneven replacement maps to its own row and takes its annotation", () => {
  for (const [deleted, added] of [
    [3, 1],
    [1, 3],
  ] as const) {
    const hunk = unevenHunk(deleted, added);
    const file: DiffFile = {
      path: "u.ts",
      kind: "modified",
      additions: added,
      deletions: deleted,
      hunks: [hunk],
    };
    for (const mode of ["split", "unified"] as const) {
      const options = {
        mode,
        width: 118,
        highlight: (code: string) => code.split("\n"),
        fold: () => false,
      };
      const rows = renderHunkRows(file, (shown) => renderDiffFile(shown, options, plain).slice(1));
      hunk.lines.forEach((line, lineIndex) => {
        const annotations = [{ hunkId: hunk.id, place: { afterLine: lineIndex }, lines: ["NOTE"] }];
        const block = bodyBlock({
          hunks: [hunk],
          rows,
          width: 120,
          styler: plain,
          mode,
          annotations,
        });
        const label = `${deleted}/${added} ${mode} line ${lineIndex}`;
        const row = block.rowOfLine(hunk.id, lineIndex);
        assert.ok(
          row !== undefined && row > (block.hunkStart.get(hunk.id) ?? 0),
          `${label}: not the header`,
        );
        assert.ok((block.lines[row] ?? "").includes(line.text), `${label}: its row shows it`);
        assert.equal(block.lines[row + 1], "NOTE", `${label}: the annotation follows its row`);
      });
    }
  }
});
