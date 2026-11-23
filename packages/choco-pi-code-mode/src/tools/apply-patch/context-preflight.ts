import { existsSync, readFileSync } from "node:fs";

import { resolvePatchPath } from "../../patch/paths.ts";
import type { ExecutePatchError, ParsedPatchAction } from "../../patch/types.ts";

interface CandidateRange {
  start: number;
  end: number;
}

interface ReadWindow {
  offset: number;
  limit: number;
}

interface HunkContext {
  anchor?: string | undefined;
  oldLines: string[];
}

interface FileContextDiagnostic {
  path: string;
  lineCount: number;
  exactMatchCount: number;
  candidates: CandidateRange[];
}

export function enrichApplyPatchContextFailure(
  error: ExecutePatchError,
  cwd: string,
): string | undefined {
  const diagnostics = error.failures
    .map(({ action }) => diagnoseAction(cwd, action))
    .filter((diagnostic): diagnostic is FileContextDiagnostic => diagnostic !== undefined);
  if (diagnostics.length === 0) return undefined;
  return diagnostics
    .map((diagnostic) =>
      formatContextError(
        diagnostic.exactMatchCount > 1 ? "ambiguous_context" : "stale_context",
        diagnostic.path,
        diagnostic.lineCount,
        diagnostic.candidates,
      ),
    )
    .join("\n\n");
}

function diagnoseAction(cwd: string, action: ParsedPatchAction): FileContextDiagnostic | undefined {
  if (action.type !== "update" || !action.lines) return undefined;
  const absolutePath = resolvePatchPath({ cwd, patchPath: action.path });
  if (!existsSync(absolutePath)) return undefined;
  const lines = fileLines(readFileSync(absolutePath, "utf8"));
  const hunks = parseHunks(action.lines);
  const exact = uniqueRanges(hunks.flatMap((hunk) => exactHunkRanges(lines, hunk)));
  const candidates = (
    exact.length > 0 ? exact : uniqueRanges(hunks.flatMap((hunk) => nearestHunkRanges(lines, hunk)))
  ).slice(0, 5);
  return {
    path: action.path,
    lineCount: lines.length,
    exactMatchCount: exact.length,
    candidates,
  };
}

function formatContextError(
  kind: "ambiguous_context" | "stale_context",
  path: string,
  lineCount: number,
  candidates: readonly CandidateRange[],
): string {
  const fallback = { start: 1, end: Math.min(Math.max(1, lineCount), 120) };
  const reads = candidates.length > 0 ? candidates : [fallback];
  return [
    `apply_patch context [${kind}]`,
    `Path: ${path}`,
    `Current line count: ${lineCount}`,
    `Candidate ranges: ${candidates.length > 0 ? candidates.map(formatRange).join(", ") : "none"}`,
    "Focused re-read:",
    ...reads.map((range) => formatReadInstruction(path, range, lineCount)),
    kind === "ambiguous_context"
      ? "Recovery: re-read the candidate ranges and retry with enough unchanged context to select exactly one location."
      : "Recovery: re-read current contents and rebuild only the failed hunk; do not reuse stale patch context.",
  ].join("\n");
}

function parseHunks(lines: readonly string[]): HunkContext[] {
  const hunks: HunkContext[] = [];
  let anchor: string | undefined;
  let oldLines: string[] = [];
  const flush = () => {
    if (oldLines.length > 0) hunks.push({ anchor, oldLines });
    oldLines = [];
  };
  for (const line of lines) {
    if (line.startsWith("@@")) {
      flush();
      anchor = line.slice(2).trim() || undefined;
      continue;
    }
    if (line.startsWith(" ") || line.startsWith("-")) oldLines.push(line.slice(1));
  }
  flush();
  return hunks;
}

function exactHunkRanges(lines: readonly string[], hunk: HunkContext): CandidateRange[] {
  return restrictToAnchor(
    findSequences(lines, hunk.oldLines).map((start) => ({
      start,
      end: start + Math.max(1, hunk.oldLines.length) - 1,
    })),
    lines,
    hunk.anchor,
  );
}

function nearestHunkRanges(lines: readonly string[], hunk: HunkContext): CandidateRange[] {
  const anchors = hunk.oldLines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line.length > 0)
    .sort((left, right) => right.line.length - left.line.length);
  const contentAnchor = anchors[0];
  if (!contentAnchor) return [];
  const ranges = lines.flatMap((line, index) =>
    line.trim() === contentAnchor.line
      ? [
          {
            start: Math.max(1, index + 1 - contentAnchor.index),
            end: Math.min(lines.length, index + 1 - contentAnchor.index + hunk.oldLines.length - 1),
          },
        ]
      : [],
  );
  return restrictToAnchor(ranges, lines, hunk.anchor);
}

function restrictToAnchor(
  ranges: readonly CandidateRange[],
  lines: readonly string[],
  anchor: string | undefined,
): CandidateRange[] {
  if (!anchor) return [...ranges];
  const anchorLines = lines.flatMap((line, index) => (line.includes(anchor) ? [index + 1] : []));
  if (anchorLines.length === 0) return [];
  return ranges.filter((range) => anchorLines.some((anchorLine) => range.start > anchorLine));
}

function findSequences(lines: readonly string[], expected: readonly string[]): number[] {
  if (expected.length === 0 || expected.length > lines.length) return [];
  const matches: number[] = [];
  for (let index = 0; index <= lines.length - expected.length; index += 1) {
    if (expected.every((line, offset) => lines[index + offset] === line)) matches.push(index + 1);
  }
  return matches;
}

function fileLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function uniqueRanges(ranges: readonly CandidateRange[]): CandidateRange[] {
  const keys = new Set<string>();
  return ranges.filter((range) => {
    const key = `${range.start}:${range.end}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function formatRange(range: CandidateRange): string {
  return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
}

function formatReadInstruction(path: string, range: CandidateRange, lineCount: number): string {
  const window = readWindow(range, lineCount);
  return `- path: ${JSON.stringify(path)}; offset: ${window.offset}; limit: ${window.limit}`;
}

function readWindow(range: CandidateRange, lineCount: number): ReadWindow {
  const offset = Math.max(1, range.start - 3);
  return {
    offset,
    limit: Math.max(1, Math.min(lineCount - offset + 1, range.end - range.start + 7)),
  };
}
