import type { DiffFile } from "../types.ts";

export type DiffSource =
  | { kind: "session" }
  | { kind: "uncommitted" }
  | { kind: "since-checkpoint"; checkpointId: string; label: string; turnOnly?: true }
  | { kind: "branch-base"; base: string }
  | { kind: "range"; base: string; head: string; label: string; turnOnly?: true };

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
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  staged: boolean;
  unstaged: boolean;
};

export type DiffSnapshot = {
  revision: number;
  source: DiffSource;
  repoRoot: string;
  head: string | null;
  branch: string | null;
  base: string;
  capturedAt: number;
  files: FileSummary[];
  totals: { files: number; additions: number; deletions: number };
  omittedFiles: number;
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
  | { kind: "gone" };

export type RefreshReason =
  | "open"
  | "tool"
  | "turn"
  | "settled"
  | "subagent"
  | "poll"
  | "manual"
  | "source";

export const MAX_EXCERPT_LINES = 20;

export type FileExcerpt =
  | { kind: "lines"; from: number; lines: string[] }
  | { kind: "unavailable"; reason: string };

export type DiffStore = {
  getState(): DiffStoreState;
  subscribe(listener: (state: DiffStoreState) => void): () => void;
  requestRefresh(reason: RefreshReason): void;
  refreshNow(): Promise<void>;
  loadFile(path: string): Promise<{ revision: number; body: FileBody }>;
  loadContext(
    path: string,
    from: number,
    to: number,
  ): Promise<{ revision: number; excerpt: FileExcerpt }>;
  setSource(source: DiffSource): void;
  setVisible(visible: boolean): void;
  dispose(): void;
};
