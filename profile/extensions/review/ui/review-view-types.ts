/**
 * Public option, dependency and result types of the full-screen review,
 * re-exported unchanged by `review-view.ts`.
 */
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
  /** Puts text on the system clipboard; omitted means the review cannot copy. */
  copyText?(text: string): Promise<void>;
  createCommentId?: () => string;
  createReviewChat?: typeof createDefaultReviewChat;
  execRunner?: ExecRunner;
  zentuiLoader?: ZentuiLoader;
  /** Markdown theme for agent replies; defaults to the main Pi transcript theme. */
  markdownTheme?: MarkdownTheme;
  /** Models offered by `/model` argument completion, as `provider/id` strings. */
  listChatModels?: () => Promise<string[]>;
};

/** Recorded reviewer findings and the last change time of each listed file. */
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
  /**
   * Reads a hidden sensitive file's contents after the user presses `v` on
   * it. Without it the file stays hidden.
   */
  revealFile?: RevealFile;
  /**
   * Re-reads the target, for `r` and after the side chat's tool calls. Only
   * targets that end at the working tree pass it; the others cannot change.
   */
  reload?: () => Promise<DiffModel>;
  /** Recorded reviewer findings for `f`/`F`, read on open and after each refresh. */
  loadFindings?: (paths: readonly string[]) => Promise<ReviewFindings>;
  /** For a session target: where its changes start, as `/diff` names it. */
  sessionBaseline?: SnapshotBaseline;
  /**
   * Whether the reviewed changes end at the working tree, so Finish places an
   * instruction to address the comments in the prompt editor. Defaults to
   * what the target implies (see `targetIncludesWorkingTree`).
   */
  includesWorkingTree?: boolean;
  /** Tests only: shorter limits than FINISH_WAIT_MS and LEAVE_SAVE_MS. */
  limits?: { finishWaitMs?: number; leaveSaveMs?: number };
  pullRequest?: PullRequestMetadata;
  /** Model for the side chat's own session, as `provider/id`; the caller passes the main session's current model. */
  chatModel?: string;
  /** Thinking level for the side chat's session; the caller passes the main session's current level. */
  chatThinkingLevel?: string;
};

export type ReviewViewResult = {
  action: "save" | "finish";
  record: ReviewRecord;
  /** Present for Finish; callers may export it without recomputing. */
  markdown?: string;
  /** Present only for session targets. It has been placed in Pi's input editor, not sent. */
  agentInstruction?: string;
  /**
   * Finish only: the context the reader revealed around hunks, by hunk id, so
   * a pull-request submission locates comments written on it the way the
   * view did.
   */
  expandedContext?: ReadonlyMap<string, HunkExpansion>;
};

/** The longest Finish waits for work that can move comments (refresh, context read, reveal). */
export const FINISH_WAIT_MS = 10_000;
/** The longest q's save may take before the review stays open and says so. */
export const LEAVE_SAVE_MS = 5_000;

/** A step in flight that can move where comments are; `settled` is false when it failed. */
export type CoordinateWork = {
  label: string;
  affects: (comment: ReviewComment) => boolean;
  settled: Promise<boolean>;
};

export type RevealFile = (path: string) => Promise<RevealedFile>;
