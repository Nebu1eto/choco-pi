// The changes view's line cursor (lib/changes/view/line-cursor.ts): pure
// movement, Shift selection, comment side rules and changed-line search.
// Moved with the functions from the review's view-state reducers.
import assert from "node:assert/strict";
import test from "node:test";
import {
  changedLineMatches,
  currentCommentPosition,
  cursorRows,
  extendSelection,
  moveLine,
  selectedLineIndexes,
  type CursorFile,
  type LineCursor,
} from "../.pi/extensions/lib/changes/view/line-cursor.ts";
import type { DiffFile, DiffHunk } from "../.pi/extensions/lib/changes/types.ts";

function hunk(
  id: string,
  oldStart: number,
  newStart: number,
  changedText: string,
  kind: "add" | "del" = "add",
): DiffHunk {
  return {
    id,
    header: `@@ -${oldStart},2 +${newStart},2 @@ ${id}`,
    oldStart,
    oldLines: kind === "del" ? 2 : 1,
    newStart,
    newLines: kind === "add" ? 2 : 1,
    lines: [
      { kind: "context", oldLine: oldStart, newLine: newStart, text: `context ${id}` },
      kind === "add"
        ? { kind, newLine: newStart + 1, text: changedText }
        : { kind, oldLine: oldStart + 1, text: changedText },
    ],
  };
}

const LOW_1 = hunk("low-1", 1, 1, "needle first");
const LOW_2 = hunk("low-2", 20, 20, "ordinary change");
const HIGH = hunk("high-1", 5, 5, "NEEDLE second", "del");
const MIXED: DiffHunk = {
  id: "mixed-hunk",
  header: "@@ -10,5 +10,6 @@ function mixed",
  oldStart: 10,
  oldLines: 5,
  newStart: 10,
  newLines: 6,
  lines: [
    { kind: "context", oldLine: 10, newLine: 10, text: "const before = 1;" },
    { kind: "context", oldLine: 11, newLine: 11, text: "const guard = 0;" },
    { kind: "del", oldLine: 12, text: "const removed = 2;" },
    { kind: "add", newLine: 12, text: "const added = 2;" },
    { kind: "add", newLine: 13, text: "const extra = 3;" },
    { kind: "context", oldLine: 13, newLine: 14, text: "const after = 4;" },
    { kind: "context", oldLine: 14, newLine: 15, text: "const tail = 5;" },
  ],
};

function file(
  path: string,
  hunks: readonly DiffHunk[],
  options: { open?: boolean; folded?: readonly string[] } = {},
): CursorFile {
  const folded = new Set(options.folded ?? []);
  return { path, open: options.open ?? true, hunks, folded: (id) => folded.has(id) };
}

/** Display order: the high-risk file first, as the review orders it. */
function files(options: { authOpen?: boolean; folded?: readonly string[] } = {}): CursorFile[] {
  const folded = options.folded ?? [LOW_2.id];
  return [
    file("src/auth.ts", [HIGH], { open: options.authOpen ?? true, folded }),
    file("src/ordinary.ts", [LOW_1, LOW_2], { folded }),
  ];
}

const at = (cursor: LineCursor | undefined) => [cursor?.path, cursor?.hunkId, cursor?.lineIndex];

test("line movement crosses lines, hunks, file rows and fold placeholders in display order", () => {
  assert.deepEqual(
    cursorRows(files()).map((row) => [row.path, row.hunkId, row.lineIndex]),
    [
      ["src/auth.ts", undefined, undefined],
      ["src/auth.ts", HIGH.id, 0],
      ["src/auth.ts", HIGH.id, 1],
      ["src/ordinary.ts", undefined, undefined],
      ["src/ordinary.ts", LOW_1.id, 0],
      ["src/ordinary.ts", LOW_1.id, 1],
      ["src/ordinary.ts", LOW_2.id, undefined],
    ],
  );
  let cursor = moveLine(files(), { path: "src/auth.ts", hunkId: HIGH.id, lineIndex: 0 }, 1);
  assert.deepEqual(at(cursor), ["src/auth.ts", HIGH.id, 1]);
  cursor = moveLine(files(), cursor, 1);
  assert.deepEqual(at(cursor), ["src/ordinary.ts", undefined, undefined], "the next file's row");
  cursor = moveLine(files(), cursor, 1);
  assert.deepEqual(at(cursor), ["src/ordinary.ts", LOW_1.id, 0]);
  cursor = moveLine(files(), cursor, 2);
  assert.deepEqual(
    at(cursor),
    ["src/ordinary.ts", LOW_2.id, undefined],
    "a folded hunk is one stop",
  );
  cursor = moveLine(files(), cursor, -1);
  assert.deepEqual(at(cursor), ["src/ordinary.ts", LOW_1.id, 1]);
  assert.deepEqual(at(moveLine(files(), cursor, 99)), ["src/ordinary.ts", LOW_2.id, undefined]);
  assert.deepEqual(at(moveLine(files(), cursor, -99)), ["src/auth.ts", undefined, undefined]);
});

test("a collapsed file is one row; a cursor on a line no longer shown resumes from its hunk or file", () => {
  const collapsed = files({ authOpen: false });
  assert.deepEqual(at(moveLine(collapsed, { path: "src/auth.ts" }, 1)), [
    "src/ordinary.ts",
    undefined,
    undefined,
  ]);
  assert.deepEqual(at(moveLine(collapsed, undefined, 1)), ["src/auth.ts", undefined, undefined]);
  // The cursor's hunk was folded under it: movement starts from the placeholder.
  const folded = files({ folded: [HIGH.id, LOW_2.id] });
  const stale = { path: "src/auth.ts", hunkId: HIGH.id, lineIndex: 1 };
  assert.deepEqual(at(moveLine(folded, stale, 1)), ["src/ordinary.ts", undefined, undefined]);
  // Its file collapsed: movement starts from the file row.
  assert.deepEqual(at(moveLine(collapsed, stale, 1)), ["src/ordinary.ts", undefined, undefined]);
});

test("the comment side: removed lines on the LEFT, added and unchanged lines on the RIGHT at their new number", () => {
  assert.deepEqual(
    currentCommentPosition("src/auth.ts", HIGH, {
      path: "src/auth.ts",
      hunkId: HIGH.id,
      lineIndex: 0,
    }),
    { path: "src/auth.ts", hunkId: HIGH.id, side: "RIGHT", line: 5 },
  );
  // An unchanged line below an uneven replacement: old 13, new 14. The number
  // a person looks up in the file as it is now, on the side that numbers it so.
  assert.deepEqual(
    currentCommentPosition("src/mixed.ts", MIXED, {
      path: "src/mixed.ts",
      hunkId: MIXED.id,
      lineIndex: 5,
    }),
    { path: "src/mixed.ts", hunkId: MIXED.id, side: "RIGHT", line: 14 },
  );
  assert.deepEqual(
    currentCommentPosition("src/auth.ts", HIGH, {
      path: "src/auth.ts",
      hunkId: HIGH.id,
      lineIndex: 1,
    }),
    { path: "src/auth.ts", hunkId: HIGH.id, side: "LEFT", line: 6 },
  );
  assert.deepEqual(
    currentCommentPosition("src/ordinary.ts", LOW_1, {
      path: "src/ordinary.ts",
      hunkId: LOW_1.id,
      lineIndex: 1,
    }),
    { path: "src/ordinary.ts", hunkId: LOW_1.id, side: "RIGHT", line: 2 },
  );
  // A fold placeholder or a file row has no line to comment on.
  assert.equal(
    currentCommentPosition("src/auth.ts", HIGH, { path: "src/auth.ts", hunkId: HIGH.id }),
    undefined,
  );
  assert.equal(currentCommentPosition("src/auth.ts", HIGH, { path: "src/auth.ts" }), undefined);
});

test("Shift extends one anchor in both directions and plain movement collapses it", () => {
  const mixed = [file("src/mixed.ts", [MIXED])];
  // Anchor on the second added line, which comments on RIGHT line 13.
  let cursor: LineCursor = { path: "src/mixed.ts", hunkId: MIXED.id, lineIndex: 4 };
  assert.deepEqual(selectedLineIndexes(MIXED, cursor), [4]);
  assert.equal(currentCommentPosition("src/mixed.ts", MIXED, cursor)?.startLine, undefined);

  cursor = extendSelection(MIXED, cursor, -1);
  assert.deepEqual(selectedLineIndexes(MIXED, cursor), [3, 4]);
  assert.deepEqual(currentCommentPosition("src/mixed.ts", MIXED, cursor), {
    path: "src/mixed.ts",
    hunkId: MIXED.id,
    side: "RIGHT",
    line: 13,
    startLine: 12,
  });
  // Reversing returns to the same anchor, so a one-line selection reports no range.
  cursor = extendSelection(MIXED, cursor, 1);
  assert.deepEqual(selectedLineIndexes(MIXED, cursor), [4]);
  assert.equal(currentCommentPosition("src/mixed.ts", MIXED, cursor)?.startLine, undefined);

  cursor = extendSelection(MIXED, extendSelection(MIXED, cursor, 1), 1);
  assert.deepEqual(selectedLineIndexes(MIXED, cursor), [4, 5, 6]);
  assert.deepEqual(currentCommentPosition("src/mixed.ts", MIXED, cursor), {
    path: "src/mixed.ts",
    hunkId: MIXED.id,
    side: "RIGHT",
    line: 15,
    startLine: 13,
  });

  const moved = moveLine(mixed, cursor, -1);
  assert.equal(moved?.anchorIndex, undefined);
  assert.deepEqual(moved && selectedLineIndexes(MIXED, moved), [5]);
});

test("a selection stops at a side boundary and at its hunk's edge, and never starts on a placeholder", () => {
  let cursor: LineCursor = { path: "src/mixed.ts", hunkId: MIXED.id, lineIndex: 1 };
  cursor = extendSelection(MIXED, cursor, 1);
  assert.deepEqual(selectedLineIndexes(MIXED, cursor), [1, 2]);
  assert.deepEqual(currentCommentPosition("src/mixed.ts", MIXED, cursor), {
    path: "src/mixed.ts",
    hunkId: MIXED.id,
    side: "LEFT",
    line: 12,
    startLine: 11,
  });
  // The next row is an added line, with no LEFT number.
  assert.equal(extendSelection(MIXED, cursor, 1), cursor);
  assert.equal(moveLine([file("src/mixed.ts", [MIXED])], cursor, 1)?.lineIndex, 3);

  // The hunk's last line: extension stops though movement continues into the next file.
  const last: LineCursor = { path: "src/auth.ts", hunkId: HIGH.id, lineIndex: 1 };
  assert.equal(extendSelection(HIGH, last, 1), last);
  assert.equal(moveLine(files(), last, 1)?.path, "src/ordinary.ts");

  const placeholder: LineCursor = { path: "src/ordinary.ts", hunkId: LOW_2.id };
  assert.deepEqual(selectedLineIndexes(LOW_2, placeholder), []);
  assert.equal(extendSelection(LOW_2, placeholder, 1), placeholder);
});

test("search matches only changed lines, case-insensitively, in file order", () => {
  const model: DiffFile[] = [
    {
      path: "src/ordinary.ts",
      kind: "modified",
      hunks: [LOW_1, LOW_2],
      additions: 2,
      deletions: 0,
    },
    { path: "src/auth.ts", kind: "modified", hunks: [HIGH], additions: 0, deletions: 1 },
  ];
  assert.deepEqual(
    changedLineMatches(model, "needle").map((match) => [
      match.path,
      match.side,
      match.line,
      match.lineIndex,
    ]),
    [
      ["src/ordinary.ts", "RIGHT", 2, 1],
      ["src/auth.ts", "LEFT", 6, 1],
    ],
  );
  assert.deepEqual(changedLineMatches(model, "context"), [], "context lines never match");
});

test("a range from an unchanged line onto added lines is a RIGHT range at the new numbers", () => {
  let cursor: LineCursor = { path: "src/mixed.ts", hunkId: MIXED.id, lineIndex: 5 };
  cursor = extendSelection(MIXED, cursor, -2);
  assert.deepEqual(selectedLineIndexes(MIXED, cursor), [3, 4, 5]);
  assert.deepEqual(currentCommentPosition("src/mixed.ts", MIXED, cursor), {
    path: "src/mixed.ts",
    hunkId: MIXED.id,
    side: "RIGHT",
    line: 14,
    startLine: 12,
  });
  // One step further is the removed line: no single side numbers that range.
  assert.equal(extendSelection(MIXED, cursor, -1), cursor);
});
