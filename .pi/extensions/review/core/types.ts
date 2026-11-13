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

import type { HighlightLimits, TurnTreeProvider } from "../../lib/changes/types.ts";
import type { ReviewRecord } from "../../lib/changes/review-records.ts";

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

/*
 * The review target, comment and record types live in lib/changes, where the
 * changes pane reads the records too; they are re-exported here unchanged.
 */
export type {
  CommentAnchor,
  ReviewComment,
  ReviewCursorState,
  ReviewRecord,
  ReviewTarget,
} from "../../lib/changes/review-records.ts";

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
