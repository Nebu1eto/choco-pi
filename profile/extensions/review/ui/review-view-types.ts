import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { createReviewChat as createDefaultReviewChat } from "../core/ask.ts";
import type { PullRequestMetadata } from "../core/pr.ts";
import type { SpawnEditor } from "../core/editor-launch.ts";
import type { HunkExpansion } from "../core/expand.ts";
import type { DiffAssessment } from "../core/heuristics.ts";
import type { DiffStyler } from "../../lib/changes/render/diff-render.ts";
import type { SnapshotBaseline } from "../../lib/changes/git/model.ts";
import type { FindingsSummary } from "../../lib/changes/findings.ts";
import type { RevealedFile } from "../../lib/changes/model-store.ts";
import type {
  DiffModel,
  ExecRunner,
  ResolvedReviewConfig,
  ReviewComment,
  ReviewRecord,
  ReviewStore,
} from "../core/types.ts";
import type { ZentuiLoader } from "./zentui-frame.ts";

export type { RevealedFile } from "../../lib/changes/model-store.ts";

export type ReviewViewHost = Pick<
  ExtensionUIContext,
  "custom" | "input" | "notify" | "select" | "setEditorText"
>;

export type ReviewViewDependencies = {
  host: ReviewViewHost;
  store: ReviewStore;
  styler: DiffStyler;
  spawnEditor?: SpawnEditor;
  now?: () => string;
  copyText?(text: string): Promise<void>;
  createCommentId?: () => string;
  createReviewChat?: typeof createDefaultReviewChat;
  execRunner?: ExecRunner;
  zentuiLoader?: ZentuiLoader;
  markdownTheme?: MarkdownTheme;
  listChatModels?: () => Promise<string[]>;
};

export type ReviewFindings = {
  recorded: FindingsSummary;
  changeTimes: ReadonlyMap<string, number | null>;
};

export type OpenReviewViewOptions = ReviewViewDependencies & {
  model: DiffModel;
  assessments: DiffAssessment;
  record: ReviewRecord;
  config: ResolvedReviewConfig;
  reviewRoot: string;
  revealFile?: RevealFile;
  reload?: () => Promise<DiffModel>;
  loadFindings?: (paths: readonly string[]) => Promise<ReviewFindings>;
  sessionBaseline?: SnapshotBaseline;
  includesWorkingTree?: boolean;
  limits?: { finishWaitMs?: number; leaveSaveMs?: number };
  pullRequest?: PullRequestMetadata;
  chatModel?: string;
  chatThinkingLevel?: string;
};

export type ReviewViewResult = {
  action: "save" | "finish";
  record: ReviewRecord;
  markdown?: string;
  agentInstruction?: string;
  expandedContext?: ReadonlyMap<string, HunkExpansion>;
};

export const FINISH_WAIT_MS = 10_000;
export const LEAVE_SAVE_MS = 5_000;

export type CoordinateWork = {
  label: string;
  affects: (comment: ReviewComment) => boolean;
  settled: Promise<boolean>;
};

export type RevealFile = (path: string) => Promise<RevealedFile>;
