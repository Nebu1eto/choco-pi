import { createHash } from "node:crypto";
import type { DiffFile, DiffHunk, DiffLine, DiffModel, DiffNotice } from "./types.ts";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

type FileHeaderPaths = { oldPath: string; newPath: string };

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

const C_ESCAPES = new Map([
  ["a", 0x07],
  ["b", 0x08],
  ["t", 0x09],
  ["n", 0x0a],
  ["v", 0x0b],
  ["f", 0x0c],
  ["r", 0x0d],
  ['"', 0x22],
  ["\\", 0x5c],
]);
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Read the C-style quoted path git writes for names containing `"`, `\`, or
 * control characters (and non-ASCII bytes when core.quotePath is on), starting
 * at the opening quote. Octal escapes are raw bytes, so the decoded bytes are
 * read back as UTF-8. Returns the decoded text and the index after the closing
 * quote, or undefined when `value` holds no complete quoted string there.
 */
function readQuoted(value: string, start: number): { text: string; end: number } | undefined {
  if (value[start] !== '"') return undefined;
  const bytes: number[] = [];
  let index = start + 1;
  while (index < value.length) {
    const character = value[index]!;
    if (character === '"')
      return { text: utf8Decoder.decode(new Uint8Array(bytes)), end: index + 1 };
    if (character !== "\\") {
      const codePoint = value.codePointAt(index)!;
      const encoded = String.fromCodePoint(codePoint);
      bytes.push(...utf8Encoder.encode(encoded));
      index += encoded.length;
      continue;
    }
    const octal = /^[0-3][0-7]{2}/.exec(value.slice(index + 1, index + 4));
    const escaped = C_ESCAPES.get(value[index + 1] ?? "");
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 4;
    } else if (escaped !== undefined) {
      bytes.push(escaped);
      index += 2;
    } else return undefined;
  }
  return undefined;
}

/** A quoted string that spans all of `value`, decoded. */
function wholeQuoted(value: string): string | undefined {
  const quoted = readQuoted(value, 0);
  return quoted?.end === value.length ? quoted.text : undefined;
}

function patchPath(value: string): string {
  // A quoted path ends at its closing quote.
  const quoted = readQuoted(value, 0);
  if (quoted) return quoted.text;
  // Git appends a tab terminator (and, for --no-index, sometimes a timestamp)
  // when an unquoted path contains whitespace.
  return value.split("\t", 1)[0] ?? value;
}

function stripPatchPrefix(value: string): string | undefined {
  const path = patchPath(value);
  if (path === "/dev/null") return undefined;
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

function withoutPrefix(path: string | undefined, prefix: "a/" | "b/"): string | undefined {
  return path?.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

/** Header paths when at least one side is quoted; undefined when neither is. */
function parseQuotedDiffGitPaths(value: string): FileHeaderPaths | undefined {
  let oldRaw: string | undefined;
  let newRaw: string | undefined;
  if (value.startsWith('"')) {
    const quoted = readQuoted(value, 0);
    if (!quoted || value[quoted.end] !== " ") return undefined;
    oldRaw = quoted.text;
    const rest = value.slice(quoted.end + 1);
    newRaw = rest.startsWith('"') ? wholeQuoted(rest) : rest;
  } else if (value.endsWith('"')) {
    // Only the new side is quoted: its opening quote follows a space.
    for (let index = value.indexOf(' "'); index >= 0; index = value.indexOf(' "', index + 1)) {
      const quoted = wholeQuoted(value.slice(index + 1));
      if (quoted === undefined) continue;
      oldRaw = value.slice(0, index);
      newRaw = quoted;
      break;
    }
  } else return undefined;
  const oldPath = withoutPrefix(oldRaw, "a/");
  const newPath = withoutPrefix(newRaw, "b/");
  return oldPath === undefined || newPath === undefined ? undefined : { oldPath, newPath };
}

function parseDiffGitPaths(header: string): FileHeaderPaths {
  const value = header.slice("diff --git ".length);
  if (value.startsWith('"') || value.endsWith('"')) {
    const quoted = parseQuotedDiffGitPaths(value);
    if (quoted) return quoted;
  }
  const delimiters: number[] = [];
  let offset = 0;
  while ((offset = value.indexOf(" b/", offset)) >= 0) {
    delimiters.push(offset);
    offset += 3;
  }
  for (const delimiter of delimiters) {
    const oldPath = value.slice(2, delimiter);
    const newPath = value.slice(delimiter + 3);
    if (value.startsWith("a/") && oldPath === newPath) return { oldPath, newPath };
  }
  const delimiter = delimiters[0];
  if (delimiter === undefined || !value.startsWith("a/")) {
    throw new Error(`Invalid git diff header: ${header}`);
  }
  return {
    oldPath: value.slice(2, delimiter),
    newPath: value.slice(delimiter + 3),
  };
}

function hunkId(path: string, header: string, lines: readonly DiffLine[]): string {
  const match = HUNK_HEADER.exec(header);
  const section = match?.[5] ?? header;
  const hash = createHash("sha256");
  hash.update(path);
  hash.update("\0");
  hash.update(section);
  for (const line of lines) {
    hash.update("\n");
    hash.update(line.kind === "context" ? " " : line.kind === "add" ? "+" : "-");
    hash.update(line.text);
  }
  return hash.digest("hex");
}

export function computeHunkId(path: string, header: string, lines: readonly DiffLine[]): string {
  return hunkId(path, header, lines);
}

/** A file section whose hunks do not match their headers; the message names the input line. */
class PatchSectionError extends Error {}

/** A git marker line such as "\\ No newline at end of file"; it belongs to the line before. */
function isMarkerLine(line: string | undefined): boolean {
  return line?.startsWith("\\") === true;
}

/**
 * Read a section's hunks, each exactly as long as its `@@` header says
 * (an omitted count is 1). After a complete hunk only another hunk header, or
 * blank lines to the end of the section, may follow; anything else, a short or
 * long hunk, or a header that is not a two-way hunk header throws, so the
 * section's lines are never read as another file's. `firstLine` is the
 * 1-based input line of `section[0]`, for the message.
 */
function parseHunks(section: readonly string[], path: string, firstLine: number): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const at = (index: number) => `line ${firstLine + index}`;
  let index = section.findIndex((line) => line.startsWith("@@"));
  if (index < 0) return hunks;
  while (index < section.length) {
    if (section.slice(index).every((line) => line === "")) break;
    const header = section[index] ?? "";
    const match = HUNK_HEADER.exec(header);
    if (!match) throw new PatchSectionError(`${at(index)} is not a hunk header`);
    const oldStart = Number(match[1]);
    const oldLines = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newLines = match[4] === undefined ? 1 : Number(match[4]);
    if (oldLines === 0 && newLines === 0) {
      throw new PatchSectionError(`the hunk at ${at(index)} has no lines`);
    }
    const headerAt = index;
    let oldLeft = oldLines;
    let newLeft = newLines;
    let oldLine = oldStart;
    let newLine = newStart;
    const lines: DiffLine[] = [];
    for (index += 1; oldLeft > 0 || newLeft > 0; index += 1) {
      const rawLine = section[index];
      if (rawLine === undefined) {
        throw new PatchSectionError(
          `the hunk at ${at(headerAt)} ends before the ${oldLines} old and ${newLines} new lines its header counts`,
        );
      }
      if (isMarkerLine(rawLine)) continue;
      // git apply reads an empty line inside a hunk as an empty context line.
      const marker = rawLine === "" ? " " : rawLine[0];
      const text = rawLine.slice(1);
      if (marker === " " && oldLeft > 0 && newLeft > 0) {
        lines.push({ kind: "context", oldLine, newLine, text });
        oldLine += 1;
        newLine += 1;
        oldLeft -= 1;
        newLeft -= 1;
      } else if (marker === "+" && newLeft > 0) {
        lines.push({ kind: "add", newLine, text });
        newLine += 1;
        newLeft -= 1;
      } else if (marker === "-" && oldLeft > 0) {
        lines.push({ kind: "del", oldLine, text });
        oldLine += 1;
        oldLeft -= 1;
      } else {
        throw new PatchSectionError(
          `${at(index)} does not fit the hunk at ${at(headerAt)} (${oldLeft} old and ${newLeft} new lines left)`,
        );
      }
    }
    while (isMarkerLine(section[index])) index += 1;

    hunks.push({
      id: hunkId(path, header, lines),
      header,
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines,
    });
  }
  return hunks;
}

/** One parsed file section, with the notice that says why it has no hunks when it did not parse. */
type ParsedSection = { file: DiffFile; notice?: DiffNotice };

/** A file listed with no hunks, and the notice saying why. */
function unreadableFile(path: string, reason: string): ParsedSection {
  return {
    file: { path, kind: "modified", hunks: [], additions: 0, deletions: 0 },
    notice: {
      path,
      message: `The patch text for this file could not be read (${reason}); its changes are not shown.`,
    },
  };
}

/**
 * One `diff --git` section. A section that does not parse is returned with no
 * hunks and a notice naming it; its lines never reach another file.
 */
function parseFile(section: readonly string[], firstLine: number): ParsedSection {
  const header = section[0];
  if (!header) throw new Error("A diff file section must have a header.");
  let headerPaths: FileHeaderPaths;
  try {
    headerPaths = parseDiffGitPaths(header);
  } catch {
    return unreadableFile(
      header.slice("diff --git ".length),
      `line ${firstLine} is not a diff --git header git writes`,
    );
  }
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let renamedFrom: string | undefined;
  let renamedTo: string | undefined;
  let copiedFrom: string | undefined;
  let copiedTo: string | undefined;
  let added = false;
  let deleted = false;
  let binary = false;

  for (const line of section.slice(1)) {
    if (line.startsWith("@@")) break;
    if (line.startsWith("--- ")) oldPath = stripPatchPrefix(line.slice(4));
    else if (line.startsWith("+++ ")) newPath = stripPatchPrefix(line.slice(4));
    else if (line.startsWith("rename from "))
      renamedFrom = patchPath(line.slice("rename from ".length));
    else if (line.startsWith("rename to ")) renamedTo = patchPath(line.slice("rename to ".length));
    else if (line.startsWith("copy from ")) copiedFrom = patchPath(line.slice("copy from ".length));
    else if (line.startsWith("copy to ")) copiedTo = patchPath(line.slice("copy to ".length));
    else if (line.startsWith("new file mode ")) added = true;
    else if (line.startsWith("deleted file mode ")) deleted = true;
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") binary = true;
  }

  const basePath = renamedFrom ?? copiedFrom ?? oldPath ?? headerPaths.oldPath;
  const headPath = renamedTo ?? copiedTo ?? newPath ?? headerPaths.newPath;
  const path = deleted ? basePath : headPath;
  let hunks: DiffHunk[] = [];
  if (!binary) {
    try {
      hunks = parseHunks(section, path, firstLine);
    } catch (error) {
      if (!(error instanceof PatchSectionError)) throw error;
      return unreadableFile(path, error.message);
    }
  }
  const additions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === "add").length,
    0,
  );
  const deletions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === "del").length,
    0,
  );

  if (binary) return { file: { path, kind: "binary", hunks, additions, deletions } };
  if (renamedFrom !== undefined || renamedTo !== undefined) {
    return { file: { path, oldPath: basePath, kind: "renamed", hunks, additions, deletions } };
  }
  if (copiedFrom !== undefined || copiedTo !== undefined) {
    return { file: { path, oldPath: basePath, kind: "copied", hunks, additions, deletions } };
  }
  if (added) return { file: { path, kind: "added", hunks, additions, deletions } };
  if (deleted) return { file: { path, kind: "deleted", hunks, additions, deletions } };
  return { file: { path, kind: "modified", hunks, additions, deletions } };
}

/**
 * Parse `git diff --patch -M -C --no-color` output without exposing it outside
 * the process. A file section that does not parse is listed with no hunks and
 * reported in `notices`.
 */
export function parseGitDiff(rawDiff: string, baseSha: string, headSha: string): DiffModel {
  const lines = rawDiff.split("\n").map(stripCarriageReturn);
  const sections: Array<{ lines: string[]; firstLine: number }> = [];
  let current: string[] | undefined;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("diff --git ")) {
      current = [line];
      sections.push({ lines: current, firstLine: index + 1 });
    } else if (current) {
      current.push(line);
    }
  }
  const files: DiffFile[] = [];
  const notices: DiffNotice[] = [];
  for (const section of sections) {
    const parsed = parseFile(section.lines, section.firstLine);
    files.push(parsed.file);
    if (parsed.notice) notices.push(parsed.notice);
  }
  return notices.length > 0 ? { baseSha, headSha, files, notices } : { baseSha, headSha, files };
}

export const parseDiff = parseGitDiff;
