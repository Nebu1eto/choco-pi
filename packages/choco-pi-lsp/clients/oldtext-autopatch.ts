import { normalizeForGuardMatch } from "./host-edit-normalize.ts";

export interface TrailingWhitespacePatch {
  oldText: string;
  newText?: string;
  removedLineTrailingWhitespace: boolean;
  removedTrailingEmptyLineCount: number;
}

export interface TrailingWhitespaceStripResult {
  text: string;
  removedLineTrailingWhitespace: boolean;
  removedTrailingEmptyLineCount: number;
}

export function normalizeOldTextForMatch(text: string): string {
  return normalizeForGuardMatch(text);
}

export function findUniqueMatchLineRange(
  matchNormalizedContent: string,
  oldText: string,
): { startLine: number; endLine: number } | undefined {
  const needle = normalizeOldTextForMatch(oldText);
  if (!needle) return undefined;
  const firstIdx = matchNormalizedContent.indexOf(needle);
  if (firstIdx === -1) return undefined;
  const secondIdx = matchNormalizedContent.indexOf(needle, firstIdx + needle.length);
  if (secondIdx !== -1) return undefined;
  let startLine = 1;
  for (let i = 0; i < firstIdx; i++) {
    if (matchNormalizedContent.charCodeAt(i) === 10) startLine++;
  }
  let lineCount = 1;
  for (let i = 0; i < needle.length; i++) {
    if (needle.charCodeAt(i) === 10) lineCount++;
  }
  return { startLine, endLine: startLine + lineCount - 1 };
}

function normalizeLf(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (pos < haystack.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count += 1;
    pos = idx + needle.length;
  }
  return count;
}

export function stripTrailingWhitespaceDetailed(value: string): TrailingWhitespaceStripResult {
  const lines = normalizeLf(value).split("\n");
  let removedLineTrailingWhitespace = false;
  const strippedLines = lines.map((line) => {
    const stripped = line.trimEnd();
    if (stripped !== line) removedLineTrailingWhitespace = true;
    return stripped;
  });

  let removedTrailingEmptyLineCount = 0;
  while (strippedLines.length > 1 && strippedLines[strippedLines.length - 1] === "") {
    strippedLines.pop();
    removedTrailingEmptyLineCount += 1;
  }

  return {
    text: strippedLines.join("\n"),
    removedLineTrailingWhitespace,
    removedTrailingEmptyLineCount,
  };
}

function stripEquivalentTrailingEmptyLines(value: string, maxCount: number): string {
  if (maxCount <= 0) return value;
  const lines = normalizeLf(value).split("\n");
  let removed = 0;
  while (removed < maxCount && lines.length > 1) {
    const last = lines[lines.length - 1];
    if (last.trim() !== "") break;
    lines.pop();
    removed += 1;
  }
  return lines.join("\n");
}

export function computeTrailingWhitespaceOldTextPatch(args: {
  oldText: string;
  newText?: string;
  fileContent: string;
}): TrailingWhitespacePatch | undefined {
  const fileContentLf = normalizeLf(args.fileContent);
  const original = normalizeLf(args.oldText);
  const stripped = stripTrailingWhitespaceDetailed(args.oldText);
  if (stripped.text === original) return undefined;

  if (countOccurrences(fileContentLf, original) !== 0) return undefined;

  if (countOccurrences(fileContentLf, stripped.text) !== 1) return undefined;

  const patchedNewText =
    args.newText !== undefined && stripped.removedTrailingEmptyLineCount > 0
      ? stripEquivalentTrailingEmptyLines(args.newText, stripped.removedTrailingEmptyLineCount)
      : args.newText;

  return {
    oldText: stripped.text,
    newText: patchedNewText,
    removedLineTrailingWhitespace: stripped.removedLineTrailingWhitespace,
    removedTrailingEmptyLineCount: stripped.removedTrailingEmptyLineCount,
  };
}
