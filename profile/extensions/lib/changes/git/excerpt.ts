/**
 * A few lines of a listed file as it is now, for the context the pane shows
 * around a finding outside every hunk. Size-capped like a body read: a file
 * over the body limit is not read at all.
 */
import { join } from "node:path";
import { isString } from "../../runtime-values.ts";
import type { ExecRunner } from "../types.ts";
import { runGit, shortErrorMessage } from "./exec.ts";
import type { DiffLimits } from "./limits.ts";
import { MAX_EXCERPT_LINES, type FileExcerpt } from "./model.ts";
import { readWorktreeFile } from "./worktree-files.ts";

/** Characters kept of one excerpt line; a minified file has lines of megabytes. */
export const MAX_EXCERPT_LINE_CHARS = 2_000;

export type ExcerptContext = {
  runner: ExecRunner;
  repoRoot: string;
  limits: DiffLimits;
  /** Head tree-ish of a "range" source; absent when the head is the working tree. */
  head?: string;
};

/** A 1-based inclusive line range of one file. */
export type ExcerptRange = { first: number; last: number };

/** The 1-based inclusive range actually read: whole numbers, at most {@link MAX_EXCERPT_LINES}. */
export function excerptRange(from: number, to: number): ExcerptRange {
  const first = Number.isFinite(from) ? Math.max(1, Math.floor(from)) : 1;
  const end = Number.isFinite(to) ? Math.floor(to) : first;
  const last = Math.max(first, Math.min(end, first + MAX_EXCERPT_LINES - 1));
  return { first, last };
}

function unavailable(reason: string): FileExcerpt {
  return { kind: "unavailable", reason };
}

async function headText(
  context: ExcerptContext,
  head: string,
  path: string,
): Promise<string | FileExcerpt> {
  const object = `${head}:${path}`;
  const size = Number(
    (await runGit(context.runner, context.repoRoot, ["cat-file", "-s", object])).trim(),
  );
  if (!Number.isFinite(size)) return unavailable("Cannot read the file's size.");
  if (size > context.limits.maxFileBytes) return unavailable("The file is too large to quote.");
  const text = await runGit(context.runner, context.repoRoot, ["cat-file", "blob", object]);
  return text.includes("\u0000") ? unavailable("Binary file.") : text;
}

async function worktreeText(context: ExcerptContext, path: string): Promise<string | FileExcerpt> {
  const read = await readWorktreeFile(join(context.repoRoot, path), context.limits.maxFileBytes);
  switch (read.kind) {
    case "missing":
      return unavailable("The file is gone.");
    case "too-large":
      return unavailable("The file is too large to quote.");
    case "binary":
      return unavailable("Binary file.");
    case "unreadable":
      return unavailable(read.reason);
    case "text":
      return read.symlink ? unavailable("Symbolic link.") : read.content.toString("utf8");
  }
}

/** Lines `from`..`to` of `path`; failures become "unavailable" and are never thrown. */
export async function readExcerpt(
  context: ExcerptContext,
  path: string,
  from: number,
  to: number,
): Promise<FileExcerpt> {
  const { first, last } = excerptRange(from, to);
  try {
    const text =
      context.head === undefined
        ? await worktreeText(context, path)
        : await headText(context, context.head, path);
    if (!isString(text)) return text;
    const all = text.split("\n");
    if (text.endsWith("\n")) all.pop();
    const lines = all.slice(first - 1, last).map((line) => {
      const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
      return bare.length > MAX_EXCERPT_LINE_CHARS ? bare.slice(0, MAX_EXCERPT_LINE_CHARS) : bare;
    });
    return { kind: "lines", from: first, lines };
  } catch (error) {
    return unavailable(shortErrorMessage(error instanceof Error ? error : String(error)));
  }
}
