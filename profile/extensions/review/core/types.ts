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

export type {
  CommentAnchor,
  ReviewComment,
  ReviewCursorState,
  ReviewRecord,
  ReviewTarget,
} from "../../lib/changes/review-records.ts";

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

export type ReviewStore = {
  load(repoKey: string, targetKey: string): Promise<ReviewRecord | undefined>;
  save(record: ReviewRecord): Promise<void>;
  list(repoKey: string): Promise<ReviewRecord[]>;
};

export type EditorConfig = {
  command: string[];
  mode: "gui" | "terminal";
};

export type ReviewConfig = {
  editor?: EditorConfig;
  highlight?: {
    enabled?: boolean;
    maxFileBytes?: number;
    maxDiffLines?: number;
  };
  heuristics?: {
    riskPatterns?: string[];
    collapsePatterns?: string[];
  };
};

export type ResolvedReviewConfig = {
  editor: EditorConfig;
  highlight: HighlightLimits;
  heuristics: {
    riskPatterns: string[];
    collapsePatterns: string[];
  };
};

export type SessionCheckpointProvider = TurnTreeProvider & {
  appendReviewState?(record: ReviewRecord): void;
};
