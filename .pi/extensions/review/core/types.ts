/**
 * Shared contracts for the interactive review view (`/review`).
 *
 * Two rules shape this file:
 *
 * 1. The diff never enters model context. Diff computation, rendering,
 *    folding, risk ordering, comment collection, and later GitHub submission
 *    all run inside the extension process, so every type here describes
 *    local, in-process data.
 * 2. `core/` stays free of choco-pi specifics so this directory can ship as a
 *    standalone Pi extension later. Session-aware behaviour arrives through
 *    `SessionCheckpointProvider`; process and rendering dependencies arrive
 *    through the injectable function types at the bottom of this file.
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
};

/* ---------------------------------------------------------------- target */

/**
 * What a review covers, mirroring the `/review` command grammar.
 *
 * - `session`: every turn of a Pi session, resolved through an injected
 *   `SessionCheckpointProvider`.
 * - `session-turn`: a single turn of a session, identified by the provider's
 *   `turnIndex`.
 * - `branch`: a Git range. One argument (`base` only) means
 *   `merge-base(HEAD, base)..HEAD`. Two arguments (`base` and `target`) mean
 *   `merge-base(target, base)..target`.
 * - `pr`: reserved for Phase 2 and not implemented yet. The variant exists now
 *   so the persisted `ReviewRecord` format does not change when pull request
 *   review lands.
 */
export type ReviewTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "session-turn"; sessionId: string; turnIndex: number }
  | { kind: "branch"; base: string; target?: string }
  | { kind: "pr"; number: number };

/* -------------------------------------------------------------- comments */

/**
 * Position information that outlives line numbers.
 *
 * A comment records the hunk it was written against plus the exact source
 * snippet and a hash of that snippet. When Phase 2 re-fetches a force-pushed
 * pull request, the line numbers move but the snippet usually does not, so a
 * comment can be relocated by searching for `snippetHash` and falling back to
 * a fuzzy match on `snippet`.
 */
export type CommentAnchor = {
  /** `DiffHunk.id` of the hunk the comment was written against. */
  hunkHash: string;
  /** Hash of `snippet`, used for exact relocation. */
  snippetHash: string;
  /** Verbatim source text the comment refers to. */
  snippet: string;
};

export type ReviewComment = {
  id: string;
  path: string;
  side: DiffSide;
  /** Last line of the comment range, in the numbering of `side`. */
  line: number;
  /** First line of a multi-line comment; absent for a single-line comment. */
  startLine?: number;
  body: string;
  anchor: CommentAnchor;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
};

/* ----------------------------------------------------------- assessments */

/**
 * Risk ordering and folding decision for one file.
 *
 * `reasons` is required rather than optional because the reviewer is a human:
 * a score without a human-readable justification is not actionable.
 */
export type FileAssessment = {
  path: string;
  riskScore: number;
  reasons: string[];
  collapsed: boolean;
  collapseReason?: string;
};

export type HunkAssessment = {
  hunkId: string;
  collapsed: boolean;
  reason?: string;
};

/* ---------------------------------------------------------- persistence */

export type ReviewCursorState = {
  /** `DiffHunk.id` values the human has marked reviewed. */
  reviewedHunkIds: string[];
  /** Head revision the reviewed set was recorded against. */
  lastHeadSha: string;
};

export type ReviewRecord = {
  version: 1;
  /**
   * Stable identifier for the repository, chosen by the caller so records
   * from different checkouts never collide.
   */
  repoKey: string;
  target: ReviewTarget;
  baseSha: string;
  headSha: string;
  cursor: ReviewCursorState;
  comments: ReviewComment[];
  verdict?: "comment" | "approve" | "request-changes";
  /** Overall review body, submitted alongside the verdict in Phase 2. */
  body?: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
};

export type ReviewStore = {
  /**
   * `targetKey` is a caller-derived string that is stable for a given
   * `ReviewTarget`, unique across targets, and safe to use in a file name.
   */
  load(repoKey: string, targetKey: string): Promise<ReviewRecord | undefined>;
  save(record: ReviewRecord): Promise<void>;
  list(repoKey: string): Promise<ReviewRecord[]>;
};

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
 * A sibling unit implements this over Pi's `highlightCode`. The seam exists so
 * a richer highlighter can replace that implementation without touching
 * callers, and so `core/` stays testable without a highlighter.
 */
export type HighlightFn = (code: string, lang?: string) => string[];

export type DiffRenderOptions = {
  mode: "unified" | "split";
  /** Total render width in terminal columns. */
  width: number;
  highlight: HighlightFn;
  /** Returns true when the hunk with this `DiffHunk.id` renders folded. */
  fold: (hunkId: string) => boolean;
};

/* ---------------------------------------------------------- configuration */

/**
 * How to open a file in the user's editor.
 *
 * `command` is a token template list. Supported tokens are `{path}`, `{line}`,
 * `{column}`, and `{dir}`; each is substituted inside its token, so
 * `"{path}:{line}"` is one argument.
 *
 * `mode` decides who owns the terminal:
 *
 * - `"gui"` spawns the editor detached and Pi keeps running, for example
 *   `["zed", "--wait", "{path}:{line}"]`.
 * - `"terminal"` requires the TUI to be released to the child process and
 *   reclaimed after it exits, for example `["nvim", "+{line}", "{path}"]`.
 *
 * The launcher unit depends on this distinction: getting it wrong either
 * freezes the TUI behind an invisible editor or corrupts the screen.
 */
export type EditorConfig = {
  command: string[];
  mode: "gui" | "terminal";
};

/** User-supplied configuration, as read from `review.json`. */
export type ReviewConfig = {
  editor?: EditorConfig;
  highlight?: {
    enabled?: boolean;
    maxFileBytes?: number;
    maxDiffLines?: number;
  };
  heuristics?: {
    /** Extra path patterns that raise a file's risk score. */
    riskPatterns?: string[];
    /** Extra path patterns that collapse a file by default. */
    collapsePatterns?: string[];
  };
};

/**
 * `ReviewConfig` with every default applied, which is what consumers use.
 *
 * `heuristics` holds only the user's patterns; the heuristics unit owns its
 * built-in patterns and the matching syntax, and treats these as additions.
 */
export type ResolvedReviewConfig = {
  editor: EditorConfig;
  highlight: {
    enabled: boolean;
    maxFileBytes: number;
    maxDiffLines: number;
  };
  heuristics: {
    riskPatterns: string[];
    collapsePatterns: string[];
  };
};

/* --------------------------------------------------------------- adapter */

/**
 * The single seam through which choco-pi session features reach `core/`.
 *
 * `tree` is a Git tree object id captured per turn by `file-checkpoints.ts`,
 * which is what makes a turn diffable without re-running the agent.
 *
 * `appendReviewState` lets the host record review progress as a custom session
 * entry; it is optional because a standalone Pi install has no such entry type.
 *
 * When no provider is injected, `session` and `session-turn` targets are
 * unavailable and `/review` reports that; `branch` targets keep working.
 */
export type SessionCheckpointProvider = {
  listTurns(): Promise<Array<{ turnIndex: number; tree: string; label: string }>>;
  appendReviewState?(record: ReviewRecord): void;
};
