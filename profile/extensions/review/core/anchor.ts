import { createHash } from "node:crypto";
import type { CommentAnchor, DiffHunk, DiffLine, DiffSide } from "./types.ts";

export {
  locateComment,
  type CommentLocation,
  type LocateCommentOptions,
} from "../../lib/changes/review-records.ts";

export function hashSnippet(snippet: string): string {
  return createHash("sha256").update(snippet).digest("hex");
}

function lineNumber(hunk: DiffHunk, side: DiffSide, index: number): number | undefined {
  const line = hunk.lines[index];
  return side === "LEFT" ? line?.oldLine : line?.newLine;
}

export function buildCommentAnchor(
  hunk: DiffHunk,
  side: DiffSide,
  line: number,
  startLine = line,
  contextLines = 2,
): CommentAnchor {
  if (!Number.isInteger(startLine) || !Number.isInteger(line) || startLine > line) {
    throw new Error("Comment anchor line range is invalid.");
  }
  if (!Number.isInteger(contextLines) || contextLines < 0) {
    throw new Error("Comment anchor contextLines must be a non-negative integer.");
  }

  const sideIndexes = hunk.lines.flatMap((_, index) =>
    lineNumber(hunk, side, index) === undefined ? [] : [index],
  );
  const firstPosition = sideIndexes.findIndex(
    (index) => lineNumber(hunk, side, index) === startLine,
  );
  let lastPosition = -1;
  for (let index = sideIndexes.length - 1; index >= 0; index -= 1) {
    if (lineNumber(hunk, side, sideIndexes[index]!) === line) {
      lastPosition = index;
      break;
    }
  }
  if (firstPosition < 0 || lastPosition < firstPosition) {
    throw new Error(
      `Comment lines ${startLine}-${line} are not present on the ${side} side of the hunk.`,
    );
  }

  const from = Math.max(0, firstPosition - contextLines);
  const to = Math.min(sideIndexes.length - 1, lastPosition + contextLines);
  const snippet = sideIndexes
    .slice(from, to + 1)
    .map((index) => hunk.lines[index]!.text)
    .join("\n");
  return {
    hunkHash: hunk.id,
    snippet,
    snippetHash: hashSnippet(snippet),
    position: firstPosition,
  };
}

export function revealedContextFits(
  hunk: DiffHunk,
  context: { above: readonly DiffLine[]; below: readonly DiffLine[] },
): boolean {
  const above = context.above.at(-1);
  const below = context.below[0];
  return (
    (above === undefined ||
      (above.oldLine === hunk.oldStart - 1 && above.newLine === hunk.newStart - 1)) &&
    (below === undefined ||
      (below.oldLine === hunk.oldStart + hunk.oldLines &&
        below.newLine === hunk.newStart + hunk.newLines))
  );
}
