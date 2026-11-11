import type { DiffFile } from "../types.ts";

/** What the pane compares against the working tree. */
export type DiffSource =
  // The first file checkpoint of the Pi session versus the working tree; see SnapshotBaseline.
  | { kind: "session" }
  | { kind: "uncommitted" } // HEAD versus working tree, staged and unstaged, plus untracked files
  // `turnOnly`: the label names the turns whose changes are listed, not where a comparison starts.
  | { kind: "since-checkpoint"; checkpointId: string; label: string; turnOnly?: true }
  | { kind: "branch-base"; base: string }
  // Tree against tree; the working tree is not read. Not offered by /diff.
  // Tree against tree; the working tree is not read. /diff uses it for an earlier turn alone.
  | { kind: "range"; base: string; head: string; label: string; turnOnly?: true };

/**
 * Where a "session" snapshot's comparison starts: the checkpoint captured
 * before the session's first checkpointed prompt, or none yet (nothing is
 * listed then, and `reason` says why).
 */
export type SnapshotBaseline =
  | { kind: "checkpoint"; label: string }
  | { kind: "none"; reason: string };

export type FileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "type-changed";

export type FileSummary = {
  path: string; // repository-relative, forward slashes
  oldPath?: string; // renames and copies
  status: FileStatus;
  additions: number | null; // null when binary or not counted
  deletions: number | null;
  binary: boolean;
  staged: boolean;
  unstaged: boolean;
};

export type DiffSnapshot = {
  /** Increases only when the listed content differs from the previous snapshot. */
  revision: number;
  source: DiffSource;
  repoRoot: string;
  head: string | null; // null in a repository with no commits; the head tree-ish for "range"
  branch: string | null; // null when detached
  /** Tree-ish the listed changes are compared against. */
  base: string;
  capturedAt: number; // epoch ms from the injected clock
  files: FileSummary[]; // sorted by path
  totals: { files: number; additions: number; deletions: number };
  /** Changed files beyond the list cap that are not in `files`. */
  omittedFiles: number;
  /** Present for the "session" source only. */
  baseline?: SnapshotBaseline;
};

export type DiffStoreState =
  | { kind: "idle" }
  | { kind: "not-a-repository"; cwd: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: DiffSnapshot; refreshing: boolean };

export type FileBody =
  | { kind: "text"; file: DiffFile }
  | { kind: "binary" }
  | { kind: "too-large"; bytes: number; limit: number }
  | { kind: "unreadable"; reason: string }
  | { kind: "gone" }; // the file is no longer changed

export type RefreshReason =
  | "open"
  | "tool"
  | "turn"
  | "settled"
  | "subagent"
  | "poll"
  | "manual"
  | "source";

export type DiffStore = {
  getState(): DiffStoreState;
  /** The listener is called after every state change; returns an unsubscribe function. */
  subscribe(listener: (state: DiffStoreState) => void): () => void;
  /** Debounced and coalesced; never rejects. */
  requestRefresh(reason: RefreshReason): void;
  /** Resolves when a refresh that started after this call has been applied or discarded. */
  refreshNow(): Promise<void>;
  /** Hunks for one listed file, cached per snapshot revision and path. */
  loadFile(path: string): Promise<{ revision: number; body: FileBody }>;
  setSource(source: DiffSource): void;
  /** Polling runs only while visible. */
  setVisible(visible: boolean): void;
  dispose(): void;
};
