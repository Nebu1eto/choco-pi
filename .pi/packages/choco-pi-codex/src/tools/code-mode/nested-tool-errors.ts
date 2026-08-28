import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { Type } from "typebox";
import { Value } from "typebox/value";

import type { BoundaryValue } from "../boundary.ts";

const ReadInputSchema = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});
const EditInputSchema = Type.Object({
  path: Type.String(),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String(),
      newText: Type.String(),
    }),
  ),
});

interface CandidateRange {
  start: number;
  end: number;
}

export function enhanceCodeModeNestedToolError(
  toolName: string,
  input: BoundaryValue,
  error: Error,
  cwd: string,
): Error {
  const readOffset = /Offset (\d+) is beyond end of file \((\d+) lines total\)/i.exec(
    error.message,
  );
  if (toolName === "read" && readOffset && Value.Check(ReadInputSchema, input)) {
    const requestedOffset = Number(readOffset[1]);
    const lineCount = Number(readOffset[2]);
    const limit = Math.max(1, Math.min(input.limit ?? 80, Math.max(1, lineCount)));
    const offset = Math.max(1, lineCount - limit + 1);
    return new Error(
      [
        "Code mode tool error [read_offset_beyond_eof]",
        `Path: ${input.path}`,
        `Requested offset: ${requestedOffset}`,
        `Current line count: ${lineCount}`,
        `Recovery: call await tools.read(${JSON.stringify({ path: input.path, offset, limit })}) to re-read the current file tail, then choose any next offset from that result.`,
      ].join("\n"),
    );
  }

  if (
    toolName === "edit" &&
    /modified since read|oldText.*(?:not found|unique)|ambiguous|multiple matches/i.test(
      error.message,
    ) &&
    Value.Check(EditInputSchema, input)
  ) {
    return staleEditError(input, error, cwd);
  }

  if (/No observation state is available/i.test(error.message)) {
    return new Error(
      [
        "Code mode tool precondition [observation_required]",
        `Tool: ${toolName}`,
        `Cause: ${error.message}`,
        "Recovery: call await tools.observe_ui({}) in this session to establish fresh observation state, then retry the original tool call.",
      ].join("\n"),
    );
  }

  return error;
}

function staleEditError(
  input: { path: string; edits: Array<{ oldText: string; newText: string }> },
  error: Error,
  cwd: string,
): Error {
  const absolutePath = isAbsolute(input.path) ? input.path : resolve(cwd, input.path);
  if (!existsSync(absolutePath)) {
    return new Error(
      [
        "Code mode tool error [stale_edit]",
        `Path: ${input.path}`,
        `Cause: ${error.message}`,
        "Current file state: path no longer exists.",
        `Recovery: call await tools.read(${JSON.stringify({ path: input.path, offset: 1, limit: 80 })}) to confirm the current path before retrying.`,
      ].join("\n"),
    );
  }

  const content = readFileSync(absolutePath, "utf8");
  const lines = fileLines(content);
  const exact = uniqueRanges(input.edits.flatMap((edit) => exactTextRanges(content, edit.oldText)));
  const candidates = (
    exact.length > 0
      ? exact
      : uniqueRanges(input.edits.flatMap((edit) => candidateRanges(content, lines, edit.oldText)))
  ).slice(0, 5);
  const ambiguous = exact.length > 1;
  const reads =
    candidates.length > 0 ? candidates : [{ start: 1, end: Math.min(80, lines.length) }];
  return new Error(
    [
      `Code mode tool error [${ambiguous ? "ambiguous_edit" : "stale_edit"}]`,
      `Path: ${input.path}`,
      `Cause: ${error.message}`,
      `Current line count: ${lines.length}`,
      `Candidate ranges: ${candidates.length > 0 ? candidates.map(formatRange).join(", ") : "none"}`,
      "Focused re-read:",
      ...reads.map(
        (range) =>
          `- await tools.read(${JSON.stringify(readCall(input.path, range, lines.length))})`,
      ),
      ambiguous
        ? "Retry with enough current unchanged text to select exactly one oldText range."
        : "Re-read current contents and rebuild oldText; do not reuse stale text.",
    ].join("\n"),
  );
}

function candidateRanges(
  content: string,
  lines: readonly string[],
  oldText: string,
): CandidateRange[] {
  const exact = exactTextRanges(content, oldText);
  if (exact.length > 0) return exact;
  const anchor = oldText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!anchor) return [];
  const height = Math.max(1, oldText.split(/\r?\n/).length);
  return lines.flatMap((line, index) =>
    line.trim() === anchor
      ? [{ start: index + 1, end: Math.min(lines.length, index + height) }]
      : [],
  );
}

function exactTextRanges(content: string, oldText: string): CandidateRange[] {
  if (!oldText) return [];
  const ranges: CandidateRange[] = [];
  let offset = 0;
  while (offset <= content.length - oldText.length) {
    const match = content.indexOf(oldText, offset);
    if (match === -1) break;
    const start = content.slice(0, match).split(/\r?\n/).length;
    const end = start + oldText.split(/\r?\n/).length - 1;
    ranges.push({ start, end });
    offset = match + Math.max(1, oldText.length);
  }
  return ranges;
}

function fileLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function uniqueRanges(ranges: readonly CandidateRange[]): CandidateRange[] {
  const seen = new Set<string>();
  return ranges.filter((range) => {
    const key = `${range.start}:${range.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatRange(range: CandidateRange): string {
  return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
}

function readCall(path: string, range: CandidateRange, lineCount: number) {
  const offset = Math.max(1, range.start - 3);
  const limit = Math.max(1, Math.min(lineCount - offset + 1, range.end - range.start + 7));
  return { path, offset, limit };
}
