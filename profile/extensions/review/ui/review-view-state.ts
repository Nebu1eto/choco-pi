/**
 * The mutable state one `/review-assist` view shares across its modules.
 *
 * `ReviewSession` lives for the whole `openReviewView` call: the record,
 * the store and the work that can move comments. `ReviewScreen` is added
 * once Pi mounts the view (the TUI, the changes view, the inputs). Both are
 * one object, `ReviewContext`, so a field the session sets is the field the
 * screen reads.
 */
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

/**
 * Leaving and finishing, as one explicit state machine (the table is
 * in tests/review-lifecycle.test.ts):
 *   open -> finishing (S) -> closed (its save done) | open (failed or cancelled prompt)
 *   open | finishing -> leaving (q: one save, bounded by LEAVE_SAVE_MS)
 *   leaving -> closed (save done, or q again) | open (save failed or too slow)
 *   any -> closed (render failure, session ended)
 * Every completion goes through `close`, which runs once. A Finish or a
 * save that started under an earlier token finds it no longer owns the
 * view after its await and does nothing: no editor text, no result that
 * makes the command submit, no second completion.
 */
export type ReviewPhase =
  | { kind: "open" }
  | { kind: "finishing"; token: number }
  | { kind: "leaving"; token: number; timer: ReturnType<typeof setTimeout> }
  | { kind: "closed" };

/** Where the diff was last drawn: the rows of the view's header and body and its columns. */
export type ReviewDiffArea = { headerTop: number; top: number; rows: number; width: number };

/** A tool call's transcript component, cached per call so a streaming result updates it in place. */
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
  /** Display-only context around hunks, keyed by the stable hunk id. */
  readonly expansions: Map<string, HunkExpansion>;
  repaint: () => void;
  terminalRows: number;
  chat: ReviewChat | undefined;
  unsubscribeChat: (() => void) | undefined;
  unsubscribeStore: (() => void) | undefined;
  view: ChangesView | undefined;
  /**
   * Handle for the review's own overlay, captured when Pi shows it. Needed so a
   * host prompt can be made visible; absent in hosts that ignore `onHandle`.
   */
  overlayHandle: OverlayHandle | undefined;
  /** Set when the view closes; results that arrive later (a reveal, a refresh, a context read) are dropped. */
  closed: boolean;
  readonly store: ModelStore;
  /**
   * Work in flight that can move where comments are: a refresh (r, or after a
   * chat tool call), a reveal of a hidden file, a context read for comments
   * on revealed context. Finish waits for it; q's save marks what it affects
   * as unconfirmed. Each is bounded by the git runner's own limit (30 s per
   * command); Finish waits at most FINISH_WAIT_MS for all of it.
   */
  readonly coordinateWork: Set<CoordinateWork>;
  readonly finishWaitMs: number;
  readonly leaveSaveMs: number;
  /** Set by the view: run after a tracked step settles, so the record follows it. */
  afterWork: (() => void) | undefined;
  /**
   * Reads that failed, by kind ("refresh", "context", "reveal:<path>"), with
   * the comments they could have moved. Those comments stay unconfirmed in
   * every follow, save and Finish until a later read of the same kind succeeds.
   */
  readonly failedReads: Map<string, (comment: ReviewComment) => boolean>;
};

export type ReviewScreen = {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly done: (result: ReviewViewResult | undefined) => void;
  /** Rows use the theme; diff text keeps the caller's styler for inversion and backgrounds. */
  readonly styler: PaneStyler;
  readonly changes: ChangesView;
  readonly commentInput: ReviewInput;
  readonly chatInput: ReviewInput;
  /** The array the chat input's completion provider reads, so appending reaches the open menu. */
  readonly chatCommands: SlashCommand[];
  busy: boolean;
  phase: ReviewPhase;
  tokens: number;
  /**
   * The record whose save on leaving failed. Leaving closes without
   * saving only while `record` is still that very object: any change
   * since (a comment, a mark, a verdict or body, a refresh that
   * re-follows comments) makes a new record, and leaving then tries to
   * save again under the same bounded rule. "Leave again to close without
   * saving" covers only what the failed save held; nothing later is lost.
   */
  saveFailedFor: ReviewRecord | undefined;
  chatOpen: boolean;
  focus: ReviewPaneFocus;
  lastBodyHeight: number;
  scrollTop: number;
  /** Undefined while the chat is drawn in the diff's place. */
  diffArea: ReviewDiffArea | undefined;
  /** A press on a line started a selection; drags extend it until the release. */
  selecting: boolean;
  lastRevision: number;
  readonly seenHunks: Set<string>;
  readonly seenFiles: Set<string>;
  readonly seenTools: Set<string>;
  readonly toolViews: Map<string, ReviewToolView>;
  /** Pi 0.85 moved the built-in renderer fallback from the component to callers. */
  readonly builtInToolDefinitions: Map<string, ToolExecutionDefinition>;
  /** Collapsed by default, exactly like the main transcript; Ctrl+O flips every tool at once. */
  toolsExpanded: boolean;
  /** Rows of the chat transcript hidden below the viewport; 0 follows the tail. */
  chatScrollOffset: number;
  /** Bumped by each restore; an older restore stops after its next await. */
  contextRestore: number;
  /** Set by the first render failure; later frames draw a fallback line. */
  renderFailure: { error: RuntimeValue } | undefined;
};

export type ReviewContext = ReviewSession & ReviewScreen;

/**
 * Messages can embed repository text (paths, git errors) and chat errors.
 * The review covers the whole screen, so Pi's own notifications are drawn
 * behind it: while the view is open every message goes to its message line
 * (which keeps it until another replaces it). Errors are also sent to Pi's
 * notifications, so they can still be read after the review closes.
 * Many callers report from work nothing awaits (refreshes, chat commands,
 * key actions), so this never throws: a stale context after the session
 * ended is silent, and any other host failure leaves the message line as
 * the only copy.
 */
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
  } catch {
    // A stale context (the session ended) stays silent. Any other host failure has
    // no other place to go: while the view is open its message line holds the text.
  }
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
    // After the store's own continuation (it applies a reveal after this promise).
    setImmediate(() => session.afterWork?.());
  });
  return work;
}

/** The state of one review before Pi mounts it: the record, the store, and the work in flight. */
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
