import { createHash } from "node:crypto";
import type {
  CommentAnchor,
  DiffHunk,
  DiffLine,
  DiffModel,
  DiffSide,
  ReviewComment,
} from "./types.ts";

export function hashSnippet(snippet: string): string {
  return createHash("sha256").update(snippet).digest("hex");
}

function lineNumber(hunk: DiffHunk, side: DiffSide, index: number): number | undefined {
  const line = hunk.lines[index];
  return side === "LEFT" ? line?.oldLine : line?.newLine;
}

/** Build an anchor from a side-specific line or line range in one hunk. */
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

/** Context lines `buildCommentAnchor` puts around a comment's lines by default. */
const ANCHOR_CONTEXT_LINES = 2;

/** The snippet `buildCommentAnchor` would take for side positions `first`..`last`. */
function snippetAt(texts: readonly string[], first: number, last: number): string {
  const from = Math.max(0, first - ANCHOR_CONTEXT_LINES);
  const to = Math.min(texts.length - 1, last + ANCHOR_CONTEXT_LINES);
  return texts.slice(from, to + 1).join("\n");
}

/** Where a comment is now, or why it is not anywhere. */
export type CommentLocation =
  | {
      status: "placed";
      /** The hunk its text is in now (the one it was written on, or another of its file). */
      hunkId: string;
      side: DiffSide;
      startLine: number;
      line: number;
      /** Index of its first line among that hunk's lines on its side, as shown. */
      position: number;
    }
  /** Its file is listed but its contents are withheld: nothing can be checked. */
  | { status: "hidden" }
  | { status: "outdated"; reason: "file-gone" | "not-found" | "ambiguous"; message: string };

export type LocateCommentOptions = {
  /**
   * The hunk as the reader sees it (with revealed context, same id). Searched
   * before the hunk as read, so comments written on revealed context are found.
   */
  shown?: (hunk: DiffHunk) => DiffHunk;
};

type Fit = { hunkId: string; startLine: number; line: number; position: number };

/** The fit at the stored position (own hunk only), and every fit. */
type Fits = { stored: Fit | undefined; all: Fit[] };

/** Every position in `hunk` where the comment's lines and stored snippet fit, as `buildCommentAnchor` would take them. */
function fitsIn(
  hunk: DiffHunk,
  comment: Pick<ReviewComment, "side" | "line" | "startLine" | "anchor">,
): Fits {
  const numbered = hunk.lines.flatMap((line) => {
    const number = comment.side === "LEFT" ? line.oldLine : line.newLine;
    return number === undefined ? [] : [{ number, text: line.text }];
  });
  const texts = numbered.map((entry) => entry.text);
  const span = comment.line - (comment.startLine ?? comment.line);
  if (!Number.isSafeInteger(span) || span < 0) return { stored: undefined, all: [] };
  const fits = (first: number) =>
    first >= 0 &&
    first + span < numbered.length &&
    snippetAt(texts, first, first + span) === comment.anchor.snippet;
  const at = (first: number): Fit => ({
    hunkId: hunk.id,
    startLine: numbered[first]!.number,
    line: numbered[first + span]!.number,
    position: first,
  });
  const position = comment.anchor.position;
  const stored =
    hunk.id === comment.anchor.hunkHash &&
    position !== undefined &&
    Number.isSafeInteger(position) &&
    fits(position)
      ? at(position)
      : undefined;
  const all: Fit[] = [];
  for (let first = 0; first + span < numbered.length; first += 1) {
    if (fits(first)) all.push(at(first));
  }
  return { stored, all };
}

/** Fits naming the same lines (the hunk as shown and as read both hold them) count once. */
function distinct(fits: readonly Fit[]): Fit[] {
  const seen = new Map<string, Fit>();
  for (const fit of fits) {
    const key = `${fit.hunkId}:${fit.startLine}:${fit.line}`;
    if (!seen.has(key)) seen.set(key, fit);
  }
  return [...seen.values()];
}

/**
 * The one answer to "where is this comment now, or is it outdated" for
 * `diff`. Every consumer asks this: the view's drawing and outdated count,
 * the record update after a refresh or a reveal, Finish's Markdown (through
 * the record that update writes), and the pull-request plan, with the head
 * unchanged or moved. Nothing trusts a stored line number.
 *
 * A comment is placed where its stored snippet, taken around its lines the
 * way `buildCommentAnchor` takes it, is found on its side:
 * 1. its own hunk (same content-hash id) at its stored position;
 * 2. else its own hunk at the one position that fits;
 * 3. else, when its own hunk has no fitting position or is gone, the one
 *    position that fits in any hunk of its file (another line of its hunk
 *    changed, so the hunk has a new id).
 * Each hunk is searched as shown (`options.shown`) and as read. Two or more
 * fitting positions are ambiguous: outdated, never guessed (an older record
 * without a stored position in a hunk too short to tell positions apart, or
 * repeated text). The range keeps its length: side lines are numbered
 * consecutively within a hunk.
 */
export function locateComment(
  comment: Pick<ReviewComment, "path" | "side" | "line" | "startLine" | "anchor">,
  diff: DiffModel,
  options: LocateCommentOptions = {},
): CommentLocation {
  const file = diff.files.find((entry) => entry.path === comment.path);
  if (!file) {
    return {
      status: "outdated",
      reason: "file-gone",
      message: "Its file is not in this comparison.",
    };
  }
  if (file.hunks.length === 0 && diff.hidden?.includes(file.path)) return { status: "hidden" };
  const versions = (hunk: DiffHunk) => {
    const shown = options.shown?.(hunk);
    return shown && shown !== hunk ? [shown, hunk] : [hunk];
  };
  const placed = (fit: Fit): CommentLocation => ({ status: "placed", side: comment.side, ...fit });
  const ambiguous: CommentLocation = {
    status: "outdated",
    reason: "ambiguous",
    message: "Its text occurs more than once, so where it is cannot be told.",
  };

  const own = file.hunks.find((hunk) => hunk.id === comment.anchor.hunkHash);
  if (own) {
    const found = versions(own).map((hunk) => fitsIn(hunk, comment));
    const stored = found.find((entry) => entry.stored)?.stored;
    if (stored) return placed(stored);
    const fits = distinct(found.flatMap((entry) => entry.all));
    if (fits.length === 1) return placed(fits[0]!);
    if (fits.length > 1) return ambiguous;
  }
  const fits = distinct(
    file.hunks.flatMap((hunk) => versions(hunk).flatMap((version) => fitsIn(version, comment).all)),
  );
  if (fits.length === 1) return placed(fits[0]!);
  if (fits.length > 1) return ambiguous;
  return {
    status: "outdated",
    reason: "not-found",
    message: "Its text is no longer present in this comparison.",
  };
}

/**
 * Whether context revealed around a hunk (read from the base revision) still
 * sits against it: the last line above ends just before the hunk and the
 * first line below starts just after it, on both sides. A hunk id names
 * content, not place, so context read for where a hunk was must not be shown
 * (or searched) where it is now.
 */
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
