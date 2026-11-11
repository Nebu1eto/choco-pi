import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { plainPaneStyler } from "../.pi/extensions/diff/ui/format.ts";
import { renderUnifiedBody } from "../.pi/extensions/diff/ui/pane-view.ts";
import { DEFAULT_HIGHLIGHT } from "../.pi/extensions/lib/changes/render/highlight.ts";
import type { DiffFile } from "../.pi/extensions/lib/changes/types.ts";

initTheme("dark", false);

function addedFile(lineCount: number): DiffFile {
  return {
    path: "src/large.ts",
    kind: "added",
    additions: lineCount,
    deletions: 0,
    hunks: [
      {
        id: `large-${lineCount}`,
        header: `@@ -0,0 +1,${lineCount} @@`,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lineCount,
        lines: Array.from({ length: lineCount }, (_, index) => ({
          kind: "add" as const,
          newLine: index + 1,
          // Short lines keep the whole file under maxFileBytes, so only the line limit applies.
          text: `let a = ${index % 10};`,
        })),
      },
    ],
  };
}

/** Escapes can only come from the highlighter: the plain styler adds none. */
function hasEscapes(lines: readonly string[]): boolean {
  return lines.some((line) => line.includes("\u001b"));
}

test("the pane highlights a small diff and leaves one over maxDiffLines plain, as review does", () => {
  assert.equal(hasEscapes(renderUnifiedBody(addedFile(3), 120, plainPaneStyler)), true);

  const over = renderUnifiedBody(
    addedFile(DEFAULT_HIGHLIGHT.maxDiffLines + 1),
    120,
    plainPaneStyler,
  );
  assert.equal(over.length > DEFAULT_HIGHLIGHT.maxDiffLines, true);
  assert.equal(hasEscapes(over), false);
});
