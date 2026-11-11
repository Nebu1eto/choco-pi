/**
 * Text the pane and the review put into the prompt editor or hand to a model.
 * Nothing here sends anything; callers insert the text and return focus so
 * the user writes the rest.
 */
import { isAbsolute, join, relative, sep } from "node:path";
import type { DiffSource } from "./git/model.ts";
import { agentStringLiteral, escapeForAgent, needsSanitizing } from "./terminal-text.ts";
import type { DiffHunk } from "./types.ts";

/** Hunks up to this many lines are inserted as a fenced diff block. */
export const MAX_INLINE_HUNK_LINES = 60;

/** Characters that make Pi's `@` file completion quote a path. */
const NEEDS_QUOTES = /[\s"'=]/u;

/** A path relative to the session's working directory, with forward slashes. */
export function editorPath(repoRoot: string, cwd: string, repoPath: string): string {
  const absolute = isAbsolute(repoPath) ? repoPath : join(repoRoot, repoPath);
  const relativePath = relative(cwd, absolute);
  const result = relativePath === "" ? repoPath : relativePath;
  return sep === "/" ? result : result.split(sep).join("/");
}

/**
 * The form Pi's editor inserts for an `@` file mention. A path holding a
 * control or bidirectional character is written as a JSON string literal with
 * those characters escaped: the editor never receives them raw, and decoding
 * the literal gives the exact path back.
 */
export function fileMention(path: string): string {
  if (needsSanitizing(path)) return `@${agentStringLiteral(path)}`;
  return NEEDS_QUOTES.test(path) ? `@"${path}"` : `@${path}`;
}

/** The new-file line range a hunk covers, as prose. */
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

/** A backtick fence longer than any backtick run inside `body`. */
export function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.matchAll(/`+/gu)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

export type HunkReference = {
  text: string;
  /** False when the hunk was too long (or sensitive) and only the range was inserted. */
  includesContent: boolean;
};

/**
 * `@path lines a-b` followed by the hunk as a fenced diff block, or the range
 * alone with a note when the hunk is longer than {@link MAX_INLINE_HUNK_LINES}.
 * A sensitive file gets the path only.
 */
export function hunkReference(mention: string, hunk: DiffHunk, sensitive: boolean): HunkReference {
  if (sensitive) return { text: mention, includesContent: false };
  const head = `${mention} ${hunkRangeText(hunk)}`;
  if (hunk.lines.length > MAX_INLINE_HUNK_LINES) {
    return {
      text: `${head} (the hunk has ${hunk.lines.length} lines, more than ${MAX_INLINE_HUNK_LINES}, so its text is not included; read the file)`,
      includesContent: false,
    };
  }
  // File contents keep their tabs; every other control is written as \uXXXX.
  const body = [
    escapeForAgent(hunk.header),
    ...hunk.lines.map((line) => `${markerOf(line.kind)}${escapeForAgent(line.text, true)}`),
  ].join("\n");
  const fence = fenceFor(body);
  return { text: `${head}\n${fence}diff\n${body}\n${fence}`, includesContent: true };
}

/**
 * Append `insert` to the editor's current text without losing it. A one-line
 * reference ends with a space and a block ends with a newline, so the user can
 * type the question straight away.
 */
export function appendToEditor(existing: string, insert: string): string {
  const multiline = insert.includes("\n");
  const tail = multiline ? "\n" : " ";
  if (existing.trim() === "") return `${insert}${tail}`;
  const separator = /\s$/u.test(existing) ? "" : multiline || existing.includes("\n") ? "\n" : " ";
  return `${existing}${separator}${insert}${tail}`;
}

export type NoteForMessage = {
  mention: string;
  /** Current range, or the range at creation for an outdated note. */
  range: string;
  outdated: boolean;
  text: string;
};

/** All notes as one message to the agent. */
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

/** The harness's agent review command (`/review`, the adversarial reviewer flow) for a source. */
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
