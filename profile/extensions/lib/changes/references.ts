import { isAbsolute, join, relative, sep } from "node:path";
import type { DiffSource } from "./git/model.ts";
import { agentStringLiteral, escapeForAgent, needsSanitizing } from "./terminal-text.ts";
import type { DiffHunk, DiffLine } from "./types.ts";

export const MAX_INLINE_HUNK_LINES = 60;

const NEEDS_QUOTES = /[\s"'=]/u;

export function editorPath(repoRoot: string, cwd: string, repoPath: string): string {
  const absolute = isAbsolute(repoPath) ? repoPath : join(repoRoot, repoPath);
  const relativePath = relative(cwd, absolute);
  const result = relativePath === "" ? repoPath : relativePath;
  return sep === "/" ? result : result.split(sep).join("/");
}

export function fileMention(path: string): string {
  if (needsSanitizing(path)) return `@${agentStringLiteral(path)}`;
  return NEEDS_QUOTES.test(path) ? `@"${path}"` : `@${path}`;
}

export function hunkRangeText(hunk: Pick<DiffHunk, "newStart" | "newLines">): string {
  if (hunk.newLines <= 0) return `deletion after line ${hunk.newStart}`;
  const end = hunk.newStart + hunk.newLines - 1;
  return end === hunk.newStart ? `line ${hunk.newStart}` : `lines ${hunk.newStart}-${end}`;
}

function markerOf(kind: DiffHunk["lines"][number]["kind"]): string {
  if (kind === "add") return "+";
  if (kind === "del") return "-";
  return " ";
}

export function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.matchAll(/`+/gu)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

export type HunkReference = {
  text: string;
  includesContent: boolean;
};

export function hunkReference(
  mention: string,
  hunk: DiffHunk,
  sensitive: boolean,
  context?: string,
): HunkReference {
  if (sensitive) return { text: mention, includesContent: false };
  const head = `${mention} ${hunkRangeText(hunk)}${contextText(context)}`;
  if (hunk.lines.length > MAX_INLINE_HUNK_LINES) {
    return {
      text: `${head} (the hunk has ${hunk.lines.length} lines, more than ${MAX_INLINE_HUNK_LINES}, so its text is not included; read the file)`,
      includesContent: false,
    };
  }
  const body = [
    escapeForAgent(hunk.header),
    ...hunk.lines.map((line) => `${markerOf(line.kind)}${escapeForAgent(line.text, true)}`),
  ].join("\n");
  const fence = fenceFor(body);
  return { text: `${head}\n${fence}diff\n${body}\n${fence}`, includesContent: true };
}

function contextText(context: string | undefined): string {
  return context === undefined ? "" : ` (${escapeForAgent(context)})`;
}

function numberRange(numbers: readonly number[], one: string, many: string): string {
  const first = Math.min(...numbers);
  const last = Math.max(...numbers);
  return first === last ? `${one} ${first}` : `${many} ${first}-${last}`;
}

export function lineRangeText(lines: readonly DiffLine[]): string {
  const current = lines.flatMap((line) => (line.newLine === undefined ? [] : [line.newLine]));
  if (current.length > 0) return numberRange(current, "line", "lines");
  const removed = lines.flatMap((line) => (line.oldLine === undefined ? [] : [line.oldLine]));
  if (removed.length === 0) return "selected lines";
  return `${numberRange(removed, "removed line", "removed lines")} (numbered as before the change)`;
}

export function linesReference(
  mention: string,
  hunk: DiffHunk,
  selection: { first: number; last: number },
  sensitive: boolean,
  context?: string,
): HunkReference {
  if (sensitive) return { text: mention, includesContent: false };
  const lines = hunk.lines.slice(Math.max(0, selection.first), selection.last + 1);
  if (lines.length === 0) return hunkReference(mention, hunk, sensitive, context);
  const head = `${mention} ${lineRangeText(lines)}${contextText(context)}`;
  if (lines.length > MAX_INLINE_HUNK_LINES) {
    return {
      text: `${head} (the selection has ${lines.length} lines, more than ${MAX_INLINE_HUNK_LINES}, so its text is not included; read the file)`,
      includesContent: false,
    };
  }
  const body = lines
    .map((line) => `${markerOf(line.kind)}${escapeForAgent(line.text, true)}`)
    .join("\n");
  const fence = fenceFor(body);
  return { text: `${head}\n${fence}diff\n${body}\n${fence}`, includesContent: true };
}

export function clipboardText(hunk: DiffHunk, selection?: { first: number; last: number }): string {
  if (selection) {
    const lines = hunk.lines.slice(Math.max(0, selection.first), selection.last + 1);
    if (lines.length > 0) return lines.map((line) => line.text).join("\n");
  }
  return [hunk.header, ...hunk.lines.map((line) => `${markerOf(line.kind)}${line.text}`)].join(
    "\n",
  );
}

export function appendToEditor(existing: string, insert: string): string {
  const multiline = insert.includes("\n");
  const tail = multiline ? "\n" : " ";
  if (existing.trim() === "") return `${insert}${tail}`;
  const separator = /\s$/u.test(existing) ? "" : multiline || existing.includes("\n") ? "\n" : " ";
  return `${existing}${separator}${insert}${tail}`;
}

export type NoteForMessage = {
  mention: string;
  range: string;
  outdated: boolean;
  text: string;
};

export function notesMessage(notes: readonly NoteForMessage[]): string {
  const lines = ["Notes on the current diff:"];
  for (const note of notes) {
    const range = escapeForAgent(note.range);
    const where = note.outdated
      ? `${note.mention} ${range} (outdated: that hunk has changed since the note)`
      : `${note.mention} ${range}`;
    lines.push(`- ${where}: ${escapeForAgent(note.text)}`);
  }
  return lines.join("\n");
}

export function reviewInstruction(source: DiffSource): string {
  switch (source.kind) {
    case "session":
      return "/review the changes made in this Pi session (no file checkpoint recorded yet)";
    case "uncommitted":
      return "/review current staged and unstaged changes against HEAD, including untracked files";
    case "branch-base":
      return `/review the working tree, including uncommitted and untracked changes, against merge-base(HEAD, ${escapeForAgent(source.base)})`;
    case "since-checkpoint":
      return `/review the working tree against session checkpoint tree ${escapeForAgent(source.checkpointId)} (state before ${escapeForAgent(source.label)})`;
    case "range":
      return `/review the changes from ${escapeForAgent(source.base)} to ${escapeForAgent(source.head)}`;
  }
}
