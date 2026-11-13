import { join } from "node:path";
import { computeHunkId, parseGitDiff } from "../patch.ts";
import type { DiffFile, DiffHunk, ExecRunner } from "../types.ts";
import { PINNED_DIFF_OPTIONS, runGit, shortErrorMessage } from "./exec.ts";
import type { DiffLimits } from "./limits.ts";
import type { FileBody, FileSummary } from "./model.ts";
import type { ListedFile } from "./snapshot.ts";
import { readWorktreeFile, worktreeSize } from "./worktree-files.ts";

export type BodyRead = {
  body: FileBody;
  /** False for failures that may succeed on retry, such as a git timeout. */
  cacheable: boolean;
};

export type BodyContext = {
  runner: ExecRunner;
  repoRoot: string;
  base: string;
  limits: DiffLimits;
  /** Head tree-ish of a "range" source; absent when the head is the working tree. */
  head?: string;
};

/** Placeholder used while parsing so quoted or newline-bearing names never reach the parser. */
const PARSE_PATH = "diff-pane-file";

export function diffKind(summary: FileSummary): DiffFile["kind"] {
  switch (summary.status) {
    case "added":
    case "untracked":
      return "added";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    case "copied":
      return "copied";
    default:
      return "modified";
  }
}

/**
 * Parse hunk lines with `parseGitDiff` under a placeholder path, then recompute
 * each hunk id for the real path. The ids equal what `parseGitDiff` assigns
 * when it parses the same hunks under the real path, so they stay stable with
 * `/review-assist`.
 */
function hunksFor(path: string, hunkLines: readonly string[]): DiffHunk[] | undefined {
  if (hunkLines.length === 0) return [];
  const synthetic = [
    `diff --git a/${PARSE_PATH} b/${PARSE_PATH}`,
    `--- a/${PARSE_PATH}`,
    `+++ b/${PARSE_PATH}`,
    ...hunkLines,
  ].join("\n");
  const model = parseGitDiff(synthetic, "", "");
  // The parser lists a section it cannot read with no hunks and a notice: that is not "no changes".
  if ((model.notices ?? []).length > 0) return undefined;
  const parsed = model.files[0];
  return (parsed?.hunks ?? []).map((hunk) => ({
    ...hunk,
    id: computeHunkId(path, hunk.header, hunk.lines),
  }));
}

/** Shown for a file whose patch text did not parse. */
export const UNPARSABLE_PATCH = "the patch git produced for this file could not be parsed";

/** A text body from hunk sections, or an unreadable body when any section does not parse. */
function sectionsBody(summary: FileSummary, sections: ReadonlyArray<readonly string[]>): BodyRead {
  const hunks: DiffHunk[] = [];
  for (const lines of sections) {
    const parsed = hunksFor(summary.path, lines);
    if (parsed === undefined) {
      return { body: { kind: "unreadable", reason: UNPARSABLE_PATCH }, cacheable: true };
    }
    hunks.push(...parsed);
  }
  return { body: { kind: "text", file: textFile(summary, hunks) }, cacheable: true };
}

function textFile(summary: FileSummary, hunks: DiffHunk[]): DiffFile {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") additions += 1;
      else if (line.kind === "del") deletions += 1;
    }
  }
  const file: DiffFile = {
    path: summary.path,
    kind: diffKind(summary),
    hunks,
    additions,
    deletions,
  };
  if (summary.oldPath !== undefined) file.oldPath = summary.oldPath;
  return file;
}

type PatchSection = {
  header: string[];
  hunkLines: string[];
};

function splitSections(patch: string): PatchSection[] {
  const sections: PatchSection[] = [];
  let current: PatchSection | undefined;
  let inHunks = false;
  for (const rawLine of patch.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("diff --git ")) {
      current = { header: [line], hunkLines: [] };
      sections.push(current);
      inHunks = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@ ")) inHunks = true;
    // Keep raw lines inside hunks: parseGitDiff strips the carriage return itself.
    if (inHunks) current.hunkLines.push(rawLine);
    else current.header.push(line);
  }
  return sections;
}

function isBinarySection(section: PatchSection): boolean {
  return section.header.some(
    (line) => line.startsWith("Binary files ") || line === "GIT binary patch",
  );
}

function isPairedSection(section: PatchSection): boolean {
  return section.header.some(
    (line) => line.startsWith("rename to ") || line.startsWith("copy to "),
  );
}

async function trackedBody(context: BodyContext, listed: ListedFile): Promise<BodyRead> {
  const { summary } = listed;
  if (listed.submodule) {
    return {
      body: { kind: "unreadable", reason: "Submodule changes have no file body." },
      cacheable: true,
    };
  }
  if (summary.binary) return { body: { kind: "binary" }, cacheable: true };
  const limit = context.limits.maxFileBytes;

  let bytes: number | undefined;
  if (context.head !== undefined || summary.status === "deleted") {
    // A range reads both sides from trees; a deletion has only the base side.
    const revision = summary.status === "deleted" ? context.base : context.head;
    const result = await context.runner("git", ["cat-file", "-s", `${revision}:${summary.path}`], {
      cwd: context.repoRoot,
    });
    if (result.code === 0) bytes = Number(result.stdout.trim());
  } else {
    bytes = await worktreeSize(join(context.repoRoot, summary.path));
  }
  if (bytes !== undefined && Number.isFinite(bytes) && bytes > limit) {
    return { body: { kind: "too-large", bytes, limit }, cacheable: true };
  }

  const paths =
    summary.oldPath !== undefined && summary.oldPath !== summary.path
      ? [summary.oldPath, summary.path]
      : [summary.path];
  // Plumbing: porcelain `git diff` would rewrite the index.
  const patch = await runGit(context.runner, context.repoRoot, [
    ...(context.head === undefined ? ["diff-index"] : ["diff-tree", "-r"]),
    "--patch",
    "-M",
    "-C",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    ...PINNED_DIFF_OPTIONS,
    context.base,
    ...(context.head === undefined ? [] : [context.head]),
    "--",
    ...paths,
  ]);
  const patchBytes = Buffer.byteLength(patch, "utf8");
  if (patchBytes > limit * 2 + 64 * 1024) {
    return { body: { kind: "too-large", bytes: patchBytes, limit }, cacheable: true };
  }
  const sections = splitSections(patch);
  if (sections.length === 0) return { body: { kind: "gone" }, cacheable: true };
  const paired = sections.filter(isPairedSection);
  const chosen = summary.oldPath !== undefined && paired.length > 0 ? paired : sections;
  if (chosen.some(isBinarySection)) return { body: { kind: "binary" }, cacheable: true };
  // A type change arrives as a deletion section followed by an addition section.
  return sectionsBody(
    summary,
    chosen.map((section) => section.hunkLines),
  );
}

async function untrackedBody(context: BodyContext, listed: ListedFile): Promise<BodyRead> {
  const { summary } = listed;
  if (listed.untrackedDirectory) {
    return {
      body: {
        kind: "unreadable",
        reason: "Untracked directory, such as a nested repository; it has no single file body.",
      },
      cacheable: true,
    };
  }
  const limit = context.limits.maxFileBytes;
  const read = await readWorktreeFile(join(context.repoRoot, summary.path), limit);
  switch (read.kind) {
    case "missing":
      return { body: { kind: "gone" }, cacheable: true };
    case "too-large":
      return { body: { kind: "too-large", bytes: read.bytes, limit }, cacheable: true };
    case "binary":
      return { body: { kind: "binary" }, cacheable: true };
    case "unreadable":
      return { body: { kind: "unreadable", reason: read.reason }, cacheable: false };
    case "text":
      break;
  }
  const text = read.content.toString("utf8");
  if (text.length === 0) {
    return { body: { kind: "text", file: textFile(summary, []) }, cacheable: true };
  }
  const endsWithNewline = text.endsWith("\n");
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  // Match `git diff --no-index /dev/null <file>`, which /review-assist uses for untracked files.
  const header = lines.length === 1 ? "@@ -0,0 +1 @@" : `@@ -0,0 +1,${lines.length} @@`;
  const hunkLines = [header, ...lines.map((line) => `+${line}`)];
  if (!endsWithNewline) hunkLines.push("\\ No newline at end of file");
  return sectionsBody(summary, [hunkLines]);
}

/**
 * A file that is in the base tree and untracked now: compare the base blob
 * with the working file. `diff-index` sees only the index and would call it
 * deleted.
 */
async function untrackedAgainstBaseBody(
  context: BodyContext,
  listed: ListedFile,
  blob: string,
): Promise<BodyRead> {
  const { summary } = listed;
  if (summary.binary) return { body: { kind: "binary" }, cacheable: true };
  const limit = context.limits.maxFileBytes;
  const sizes = await Promise.all([
    worktreeSize(join(context.repoRoot, summary.path)),
    runGit(context.runner, context.repoRoot, ["cat-file", "-s", blob]).then((out) =>
      Number(out.trim()),
    ),
  ]);
  const bytes = Math.max(
    ...sizes.map((size) => (size !== undefined && Number.isFinite(size) ? size : 0)),
  );
  if (bytes > limit) return { body: { kind: "too-large", bytes, limit }, cacheable: true };
  const original = await runGit(context.runner, context.repoRoot, ["cat-file", "blob", blob]);
  if (original.includes("\uFFFD")) {
    return {
      body: { kind: "unreadable", reason: "The checkpoint version is not UTF-8 text." },
      cacheable: true,
    };
  }
  // `-` reads the base version from stdin; exit status 1 means "differs".
  const patch = await runGit(
    context.runner,
    context.repoRoot,
    [
      "diff",
      "--no-index",
      "--patch",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      ...PINNED_DIFF_OPTIONS,
      "--",
      "-",
      summary.path,
    ],
    [0, 1],
    original,
  );
  const sections = splitSections(patch);
  if (sections.length === 0) {
    return { body: { kind: "text", file: textFile(summary, []) }, cacheable: true };
  }
  if (sections.some(isBinarySection)) return { body: { kind: "binary" }, cacheable: true };
  return sectionsBody(
    summary,
    sections.map((section) => section.hunkLines),
  );
}

/** Load one listed file's body; failures become "unreadable" and are never thrown. */
export async function readFileBody(context: BodyContext, listed: ListedFile): Promise<BodyRead> {
  try {
    if (listed.untrackedBase !== undefined) {
      return await untrackedAgainstBaseBody(context, listed, listed.untrackedBase);
    }
    return listed.summary.status === "untracked"
      ? await untrackedBody(context, listed)
      : await trackedBody(context, listed);
  } catch (error) {
    return {
      body: {
        kind: "unreadable",
        reason: shortErrorMessage(error instanceof Error ? error : String(error)),
      },
      cacheable: false,
    };
  }
}
