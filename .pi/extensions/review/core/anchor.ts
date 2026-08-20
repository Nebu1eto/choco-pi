import { propertiesWhen } from "../../lib/runtime-values.ts";
import { isString } from "../../lib/runtime-values.ts";
import { createHash } from "node:crypto";
import type { CommentAnchor, DiffHunk, DiffModel, DiffSide } from "./types.ts";

export type AnchorRelocation =
  | {
      status: "mapped";
      method: "exact" | "unique-substring";
      /** First and last line of the matched snippet on the selected side. */
      startLine: number;
      line: number;
      matchedSnippet: string;
      path?: string;
      side?: DiffSide;
      hunkHash?: string;
    }
  | {
      status: "unmappable";
      reason: "invalid-anchor" | "not-found" | "ambiguous";
      message: string;
    };

export type RelocateAnchorOptions = {
  /** Required to avoid cross-file matches when searching a multi-file model. */
  path?: string;
  /** The ReviewComment side. Supplying it avoids duplicate context matches. */
  side?: DiffSide;
};

type SourceLine = { number: number; text: string };
type SourceChunk = {
  lines: SourceLine[];
  path?: string;
  side?: DiffSide;
  hunkHash?: string;
};
type Match = { chunk: SourceChunk; index: number; length: number; snippet: string };

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
  };
}

export const createCommentAnchor = buildCommentAnchor;

function modelChunks(model: DiffModel, options: RelocateAnchorOptions): SourceChunk[] {
  const chunks: SourceChunk[] = [];
  for (const file of model.files) {
    if (options.path !== undefined && file.path !== options.path) continue;
    for (const hunk of file.hunks) {
      const sides: DiffSide[] = options.side ? [options.side] : ["LEFT", "RIGHT"];
      for (const side of sides) {
        const lines = hunk.lines.flatMap((diffLine) => {
          const number = side === "LEFT" ? diffLine.oldLine : diffLine.newLine;
          return number === undefined ? [] : [{ number, text: diffLine.text }];
        });
        if (lines.length > 0) {
          chunks.push({ lines, path: file.path, side, hunkHash: hunk.id });
        }
      }
    }
  }
  return chunks;
}

function fileChunk(content: string): SourceChunk {
  const normalized = content.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return {
    lines: lines.map((text, index) => ({ number: index + 1, text })),
  };
}

function findMatches(chunks: readonly SourceChunk[], needle: readonly string[]): Match[] {
  if (needle.length === 0) return [];
  const matches: Match[] = [];
  for (const chunk of chunks) {
    for (let index = 0; index <= chunk.lines.length - needle.length; index += 1) {
      let matchesNeedle = true;
      for (let part = 0; part < needle.length; part += 1) {
        if (chunk.lines[index + part]?.text !== needle[part]) {
          matchesNeedle = false;
          break;
        }
      }
      if (matchesNeedle) {
        matches.push({
          chunk,
          index,
          length: needle.length,
          snippet: needle.join("\n"),
        });
      }
    }
  }
  return matches;
}

function mapped(match: Match, method: "exact" | "unique-substring"): AnchorRelocation {
  const first = match.chunk.lines[match.index]!;
  const last = match.chunk.lines[match.index + match.length - 1]!;
  return {
    status: "mapped",
    method,
    startLine: first.number,
    line: last.number,
    matchedSnippet: match.snippet,
    ...propertiesWhen(!(match.chunk.path === undefined), () => ({ path: match.chunk.path })),
    ...propertiesWhen(!(match.chunk.side === undefined), () => ({ side: match.chunk.side })),
    ...propertiesWhen(!(match.chunk.hunkHash === undefined), () => ({
      hunkHash: match.chunk.hunkHash,
    })),
  };
}

/**
 * Relocate an anchor without guessing: a match must be unique at the longest
 * matching substring length, otherwise the result is explicitly unmappable.
 */
export function relocateAnchor(
  anchor: CommentAnchor,
  source: DiffModel | string,
  options: RelocateAnchorOptions = {},
): AnchorRelocation {
  if (hashSnippet(anchor.snippet) !== anchor.snippetHash) {
    return {
      status: "unmappable",
      reason: "invalid-anchor",
      message: "The anchor snippet does not match its stored hash.",
    };
  }
  const allChunks = isString(source) ? [fileChunk(source)] : modelChunks(source, options);
  const matchingHunkChunks = allChunks.filter((chunk) => chunk.hunkHash === anchor.hunkHash);
  const chunks = matchingHunkChunks.length > 0 ? matchingHunkChunks : allChunks;
  const anchorLines = anchor.snippet.replaceAll("\r\n", "\n").split("\n");

  const exact = findMatches(chunks, anchorLines).filter(
    (match) => hashSnippet(match.snippet) === anchor.snippetHash,
  );
  if (exact.length === 1) return mapped(exact[0]!, "exact");
  if (exact.length > 1) {
    return {
      status: "unmappable",
      reason: "ambiguous",
      message: "The exact anchor snippet occurs more than once.",
    };
  }

  for (let length = anchorLines.length - 1; length >= 1; length -= 1) {
    const matches: Match[] = [];
    for (let offset = 0; offset <= anchorLines.length - length; offset += 1) {
      const needle = anchorLines.slice(offset, offset + length);
      if (needle.every((line) => line.length === 0)) continue;
      matches.push(...findMatches(chunks, needle));
    }
    if (matches.length === 1) return mapped(matches[0]!, "unique-substring");
    if (matches.length > 1) {
      return {
        status: "unmappable",
        reason: "ambiguous",
        message: "The anchor has multiple possible substring matches.",
      };
    }
  }
  return {
    status: "unmappable",
    reason: "not-found",
    message: "The anchor snippet is no longer present in the review content.",
  };
}
