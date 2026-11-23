import { randomUUID } from "node:crypto";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme, OverlayHandle, SlashCommand, TUI } from "@earendil-works/pi-tui";
import type { RuntimeValue } from "../../lib/runtime-values.ts";
import { createReviewChat as createDefaultReviewChat, type ReviewChat } from "../core/ask.ts";
import type { HunkExpansion } from "../core/expand.ts";
import type { DiffAssessment } from "../core/heuristics.ts";
import { sanitizeTerminalText as safe } from "../../lib/changes/terminal-text.ts";
import type { ChangesView } from "../../lib/changes/view/changes-view.ts";
import type { PaneStyler } from "../../lib/changes/view/rows.ts";
import {
  createModelStore,
  type ModelStore,
  type ModelStoreOptions,
} from "../../lib/changes/model-store.ts";
import type { ResolvedReviewConfig, ReviewComment, ReviewRecord } from "../core/types.ts";
import type { ReviewInput } from "./review-input.ts";
import { createZentuiFrameAdapter, type ZentuiFrameAdapter } from "./zentui-frame.ts";
import type { CommentDraft, DiffViewMode } from "./view-state.ts";
import { sourceOfTarget } from "./review-view-format.ts";
import {
  FINISH_WAIT_MS,
  LEAVE_SAVE_MS,
  type CoordinateWork,
  type OpenReviewViewOptions,
  type ReviewViewHost,
  type ReviewViewResult,
} from "./review-view-types.ts";

export type ReviewPaneFocus = "review" | "chat";
export type ToolExecutionDefinition = ConstructorParameters<typeof ToolExecutionComponent>[4];

export type ReviewPhase =
  | { kind: "open" }
  | { kind: "finishing"; token: number }
  | { kind: "leaving"; token: number; timer: ReturnType<typeof setTimeout> }
  | { kind: "closed" };

export type ReviewDiffArea = { headerTop: number; top: number; rows: number; width: number };

export type ReviewToolView = {
  component: ToolExecutionComponent;
  result?: unknown;
  done?: boolean;
};

export type ReviewSession = {
  readonly options: OpenReviewViewOptions;
  readonly now: () => string;
  readonly createCommentId: () => string;
  readonly createChat: typeof createDefaultReviewChat;
  readonly markdownTheme: MarkdownTheme;
  readonly frameAdapter: ZentuiFrameAdapter;
  readonly config: ResolvedReviewConfig;
  record: ReviewRecord;
  assessments: DiffAssessment;
  mode: DiffViewMode;
  commentDraft: CommentDraft | undefined;
  readonly expansions: Map<string, HunkExpansion>;
  repaint: () => void;
  terminalRows: number;
  chat: ReviewChat | undefined;
  unsubscribeChat: (() => void) | undefined;
  unsubscribeStore: (() => void) | undefined;
  view: ChangesView | undefined;
  overlayHandle: OverlayHandle | undefined;
  closed: boolean;
  readonly store: ModelStore;
  readonly coordinateWork: Set<CoordinateWork>;
  readonly finishWaitMs: number;
  readonly leaveSaveMs: number;
  afterWork: (() => void) | undefined;
  readonly failedReads: Map<string, (comment: ReviewComment) => boolean>;
};

export type ReviewScreen = {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly done: (result: ReviewViewResult | undefined) => void;
  readonly styler: PaneStyler;
  readonly changes: ChangesView;
  readonly commentInput: ReviewInput;
  readonly chatInput: ReviewInput;
  readonly chatCommands: SlashCommand[];
  busy: boolean;
  phase: ReviewPhase;
  tokens: number;
  saveFailedFor: ReviewRecord | undefined;
  chatOpen: boolean;
  focus: ReviewPaneFocus;
  lastBodyHeight: number;
  scrollTop: number;
  diffArea: ReviewDiffArea | undefined;
  selecting: boolean;
  lastRevision: number;
  readonly seenHunks: Set<string>;
  readonly seenFiles: Set<string>;
  readonly seenTools: Set<string>;
  readonly toolViews: Map<string, ReviewToolView>;
  readonly builtInToolDefinitions: Map<string, ToolExecutionDefinition>;
  toolsExpanded: boolean;
  chatScrollOffset: number;
  contextRestore: number;
  renderFailure: { error: RuntimeValue } | undefined;
};

export type ReviewContext = ReviewSession & ReviewScreen;

export function notify(
  session: ReviewSession,
  message: string,
  type?: Parameters<ReviewViewHost["notify"]>[1],
): void {
  const open = session.view !== undefined && !session.closed;
  if (open) {
    session.view?.setMessage(message, type === "error" || type === "warning" ? type : "muted");
    session.repaint();
    if (type !== "error") return;
  }
  try {
    session.options.host.notify(safe(message), type);
  } catch {}
}

export function trackWork<T>(
  session: ReviewSession,
  kind: string,
  label: string,
  affects: (comment: ReviewComment) => boolean,
  work: Promise<T>,
): Promise<T> {
  void work.then(
    () => session.failedReads.delete(kind),
    () => session.failedReads.set(kind, affects),
  );
  const entry: CoordinateWork = {
    label,
    affects,
    settled: work.then(
      () => true,
      () => false,
    ),
  };
  session.coordinateWork.add(entry);
  void entry.settled.then(() => {
    session.coordinateWork.delete(entry);
    setImmediate(() => session.afterWork?.());
  });
  return work;
}

export async function createReviewSession(options: OpenReviewViewOptions): Promise<ReviewSession> {
  const now = options.now ?? (() => new Date().toISOString());
  const createCommentId = options.createCommentId ?? randomUUID;
  const createChat = options.createReviewChat ?? createDefaultReviewChat;
  const markdownTheme = options.markdownTheme ?? getMarkdownTheme();
  const frameAdapter = await createZentuiFrameAdapter(options.zentuiLoader);
  const storeOptions: ModelStoreOptions = {
    model: options.model,
    source: sourceOfTarget(options.record.target),
    repoRoot: options.reviewRoot,
  };
  const revealFile = options.revealFile;
  if (revealFile) {
    storeOptions.reveal = (path) =>
      trackWork(
        session,
        `reveal:${path}`,
        `reading ${path}`,
        (comment) => comment.path === path,
        revealFile(path),
      );
  }
  const reload = options.reload;
  if (reload) {
    storeOptions.reload = () =>
      trackWork(session, "refresh", "reading the changes again", () => true, reload());
  }
  if (options.sessionBaseline) storeOptions.baseline = options.sessionBaseline;
  const session: ReviewSession = {
    options,
    now,
    createCommentId,
    createChat,
    markdownTheme,
    frameAdapter,
    config: options.config,
    record: options.record,
    assessments: options.assessments,
    mode: "unified",
    commentDraft: undefined,
    expansions: new Map(),
    repaint: () => {},
    terminalRows: 24,
    chat: undefined,
    unsubscribeChat: undefined,
    unsubscribeStore: undefined,
    view: undefined,
    overlayHandle: undefined,
    closed: false,
    store: createModelStore(storeOptions),
    coordinateWork: new Set(),
    finishWaitMs: options.limits?.finishWaitMs ?? FINISH_WAIT_MS,
    leaveSaveMs: options.limits?.leaveSaveMs ?? LEAVE_SAVE_MS,
    afterWork: undefined,
    failedReads: new Map(),
  };
  return session;
}

export function setFocus(ctx: ReviewContext, next: ReviewPaneFocus): void {
  ctx.focus = next;
  ctx.chatInput.focused = next === "chat";
  ctx.tui.requestRender();
}
