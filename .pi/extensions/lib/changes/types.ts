/**
 * Contracts shared by every surface that shows code changes: the interactive
 * review (`/review-assist`) and the changes pane (`/diff`).
 *
 * Nothing under `lib/changes/` imports either extension; each extension
 * imports from here. Review-specific contracts (targets, comments, records)
 * stay in `review/core/types.ts`, which re-exports these for its importers.
 */

/* ------------------------------------------------------------------ diff */

/**
 * Which side of the diff a position belongs to, using GitHub review
 * semantics: `LEFT` is the base revision (addressed by `DiffLine.oldLine`),
 * `RIGHT` is the head revision (addressed by `DiffLine.newLine`).
 */
export type DiffSide = "LEFT" | "RIGHT";

/**
 * One physical line of a hunk.
 *
 * `context` lines carry both `oldLine` and `newLine`, `del` lines carry only
 * `oldLine`, and `add` lines carry only `newLine`. `text` excludes the leading
 * ` `, `+`, or `-` marker and excludes the trailing newline.
 */
export type DiffLine = {
  kind: "context" | "add" | "del";
  oldLine?: number;
  newLine?: number;
  text: string;
};

export type DiffHunk = {
  /**
   * Stable content hash identifying this hunk across recomputation.
   *
   * The hash covers the file path, the hunk header with its `@@ -a,b +c,d @@`
   * range portion stripped (only the trailing section context contributes),
   * and the hunk body normalized to per-line `kind` markers plus `text` with
   * all line numbers excluded. Excluding the ranges and line numbers is
   * deliberate: an unrelated edit earlier in the file shifts every later hunk,
   * and reviewed-state and comment anchors must survive that shift.
   */
  id: string;
  /** Raw `@@ -a,b +c,d @@ section` header line as produced by git. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type DiffFile = {
  /** Path in the head revision; for a deletion, the path that was removed. */
  path: string;
  /** Path in the base revision, present only for renames and copies. */
  oldPath?: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "copied" | "binary";
  /** Empty for `binary` files, which carry no reviewable text. */
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
};

export type DiffModel = {
  baseSha: string;
  headSha: string;
  files: DiffFile[];
  /**
   * Files listed without hunks because a read limit or error kept their body
   * out, each with the reason shown to the user. Absent when none.
   */
  notices?: DiffNotice[];
  /** Changed files beyond the file limit, absent from `files`. Absent when none. */
  omittedFiles?: number;
  /**
   * Sensitive files listed by name whose contents were not read: their
   * `hunks` are empty until the user asks to see them. Absent when none.
   */
  hidden?: string[];
  /** Listed files that are untracked in the working tree. Absent when none. */
  untracked?: string[];
};

export type DiffNotice = { path: string; message: string };

/* ----------------------------------------------------------------- seams */

/**
 * Child process seam. Implementations resolve rather than reject on a non-zero
 * exit so callers can inspect `code` and `stderr`; only a spawn failure
 * rejects.
 *
 * `input` is written to the child's stdin, which is then closed. Every
 * implementation must deliver it: `gh api --input -` waits for end-of-file on
 * stdin before it sends anything, so a runner that accepts `input` and drops it
 * leaves the child blocked forever instead of failing.
 */
export type ExecRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/**
 * Syntax highlighting seam. Returns one ANSI-decorated output line per input
 * line, so callers can index the result by line number.
 *
 * `render/highlight.ts` implements this over Pi's `highlightCode`. The seam
 * exists so a richer highlighter can replace that implementation without
 * touching callers, and so rendering stays testable without a highlighter.
 */
export type HighlightFn = (code: string, lang?: string) => string[];

/** When syntax highlighting applies; beyond either limit the text stays plain. */
export type HighlightLimits = {
  enabled: boolean;
  maxFileBytes: number;
  maxDiffLines: number;
};

export type DiffRenderOptions = {
  mode: "unified" | "split";
  /** Total render width in terminal columns. */
  width: number;
  highlight: HighlightFn;
  /** Returns true when the hunk with this `DiffHunk.id` renders folded. */
  fold: (hunkId: string) => boolean;
};

/* ----------------------------------------------------------- turn trees */

/**
 * Per-turn Git trees of a Pi session, the only session data the shared diff
 * layer reads.
 *
 * `tree` is a Git tree object id captured per turn by `file-checkpoints.ts`,
 * which is what makes a turn diffable without re-running the agent.
 */
export type TurnTreeProvider = {
  listTurns(): Promise<Array<{ turnIndex: number; tree: string; label: string }>>;
  /**
   * The tree a "session" source compares with: the first checkpoint the
   * session recorded, or the reason none exists yet. A provider without it
   * uses the first turn `listTurns` returns.
   */
  sessionBaseline?(): Promise<SessionBaselineChoice>;
};

export type SessionBaselineChoice =
  | { kind: "checkpoint"; tree: string; label: string }
  | { kind: "none"; reason: string };
