import { access, readFile } from "node:fs/promises";
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

export async function enhanceCodeModeNestedToolError(
  toolName: string,
  input: BoundaryValue,
  error: Error,
  cwd: string,
): Promise<Error> {
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
        `Recovery: use an available filesystem reader (a direct read outside code mode if needed) for ${JSON.stringify(input.path)} and inspect its current tail near offset ${offset} with limit ${limit}. tools.read_text is UI-only.`,
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
        "Recovery: if observe_ui is available in this session, call it to establish fresh UI observation state, then retry the original UI tool call. For filesystem content, use an available filesystem reader; tools.read_text is UI-only.",
      ].join("\n"),
    );
  }

  return error;
}

async function staleEditError(
  input: { path: string; edits: Array<{ oldText: string; newText: string }> },
  error: Error,
  cwd: string,
): Promise<Error> {
  const absolutePath = isAbsolute(input.path) ? input.path : resolve(cwd, input.path);
  try {
    await access(absolutePath);
  } catch (failure) {
    if (!(failure instanceof Error && "code" in failure && failure.code === "ENOENT")) return error;
    return new Error(
      [
        "Code mode tool error [stale_edit]",
        `Path: ${input.path}`,
        `Cause: ${error.message}`,
        "Current file state: path no longer exists.",
        "Recovery: use an available filesystem reader (a direct read outside code mode if needed) to confirm the current path before retrying. tools.read_text is UI-only.",
      ].join("\n"),
    );
  }

  let content: string;
  try {
    content = await readFile(absolutePath, "utf8");
  } catch {
    return error;
  }
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
          `- use an available filesystem reader for ${JSON.stringify(readCall(input.path, range, lines.length))}`,
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
