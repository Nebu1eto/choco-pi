/**
 * Shared contracts for the interactive review view (`/review-assist`).
 *
 * The diff never enters model context. Diff computation, rendering, folding,
 * risk ordering, comment collection, and later GitHub submission all run
 * inside the extension process, so every type here describes local,
 * in-process data. Session-aware behaviour arrives through
 * `SessionCheckpointProvider`.
 *
 * The diff, process, and rendering contracts live in `lib/changes/types.ts`,
 * shared with the changes pane; they are re-exported here so review importers
 * keep one import site.
 */

import type { DiffSide, HighlightLimits, TurnTreeProvider } from "../../lib/changes/types.ts";

export type {
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffModel,
  DiffRenderOptions,
  DiffSide,
  ExecRunner,
  HighlightFn,
  HighlightLimits,
  TurnTreeProvider,
} from "../../lib/changes/types.ts";

/* ---------------------------------------------------------------- target */

/**
 * What a review covers, mirroring the `/review-assist` command grammar.
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
  /**
   * Index of the comment's first line among the hunk's lines on the comment's
   * side. Written since comments are placed by text rather than by number;
   * absent in older records, whose position is found from `snippet`.
   */
  position?: number;
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
  /**
   * Absent while the comment's text was found where `line` says when the
   * record was last saved. `outdated`: its text was not found in that
   * comparison, and `line` is where it was last found. `unconfirmed`: work
   * that could move it (a refresh, a context read, a reveal) had not finished
   * when the record was saved, so `line` was not checked. Older records have
   * neither; the view works it out again on open.
   */
  stale?: "outdated" | "unconfirmed";
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
  highlight: HighlightLimits;
  heuristics: {
    riskPatterns: string[];
    collapsePatterns: string[];
  };
};

/* --------------------------------------------------------------- adapter */

/**
 * The single seam through which choco-pi session features reach `core/`:
 * the per-turn trees (`TurnTreeProvider`) plus review progress.
 *
 * `appendReviewState` lets the host record review progress as a custom session
 * entry; it is optional because a standalone Pi install has no such entry type.
 *
 * When no provider is injected, `session` and `session-turn` targets are
 * unavailable and `/review-assist` reports that; `branch` targets keep working.
 */
export type SessionCheckpointProvider = TurnTreeProvider & {
  appendReviewState?(record: ReviewRecord): void;
};
