import { createHash } from "node:crypto";
import type { DiffFile, DiffHunk, DiffLine, DiffModel } from "./types.ts";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

type FileHeaderPaths = { oldPath: string; newPath: string };

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function patchPath(value: string): string {
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

function parseDiffGitPaths(header: string): FileHeaderPaths {
  const value = header.slice("diff --git ".length);
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

function parseHunks(section: readonly string[], path: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (let index = 0; index < section.length; index += 1) {
    const header = section[index];
    if (!header?.startsWith("@@ ")) continue;
    const match = HUNK_HEADER.exec(header);
    if (!match) throw new Error(`Invalid hunk header: ${header}`);

    const oldStart = Number(match[1]);
    const oldLines = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newLines = match[4] === undefined ? 1 : Number(match[4]);
    let oldLine = oldStart;
    let newLine = newStart;
    const lines: DiffLine[] = [];

    for (index += 1; index < section.length; index += 1) {
      const rawLine = section[index];
      if (rawLine === undefined) break;
      if (rawLine.startsWith("@@ ")) {
        index -= 1;
        break;
      }
      if (rawLine === "\\ No newline at end of file") continue;
      const marker = rawLine[0];
      const text = rawLine.slice(1);
      if (marker === " ") {
        lines.push({ kind: "context", oldLine, newLine, text });
        oldLine += 1;
        newLine += 1;
      } else if (marker === "+") {
        lines.push({ kind: "add", newLine, text });
        newLine += 1;
      } else if (marker === "-") {
        lines.push({ kind: "del", oldLine, text });
        oldLine += 1;
      } else {
        index -= 1;
        break;
      }
    }

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

function parseFile(section: readonly string[]): DiffFile {
  const header = section[0];
  if (!header) throw new Error("A diff file section must have a header.");
  const headerPaths = parseDiffGitPaths(header);
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
    if (line.startsWith("@@ ")) break;
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
  const hunks = binary ? [] : parseHunks(section, path);
  const additions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === "add").length,
    0,
  );
  const deletions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === "del").length,
    0,
  );

  if (binary) return { path, kind: "binary", hunks, additions, deletions };
  if (renamedFrom !== undefined || renamedTo !== undefined) {
    return { path, oldPath: basePath, kind: "renamed", hunks, additions, deletions };
  }
  if (copiedFrom !== undefined || copiedTo !== undefined) {
    return { path, oldPath: basePath, kind: "copied", hunks, additions, deletions };
  }
  if (added) return { path, kind: "added", hunks, additions, deletions };
  if (deleted) return { path, kind: "deleted", hunks, additions, deletions };
  return { path, kind: "modified", hunks, additions, deletions };
}

/** Parse `git diff --patch -M -C --no-color` output without exposing it outside the process. */
export function parseGitDiff(rawDiff: string, baseSha: string, headSha: string): DiffModel {
  const lines = rawDiff.split("\n").map(stripCarriageReturn);
  const sections: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      current = [line];
      sections.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  return { baseSha, headSha, files: sections.map(parseFile) };
}

export const parseDiff = parseGitDiff;
