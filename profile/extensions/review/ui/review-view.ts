/**
 * The full-screen review (`/review-assist`): the shared changes view
 * (`lib/changes/view/changes-view.ts`, the same view `/diff` docks beside the
 * transcript) with a line cursor, mounted in a host that fills the terminal
 * and adds the review's footer, comment editor and side chat.
 *
 * The view reads a store that lives as long as the review: static for pull
 * requests and commit ranges, re-read on `r` and after the side chat's tool
 * calls for targets that end at the working tree.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { hunkWithExpandedContext } from "../core/expand.ts";
import { ChangesView, type PaneActions } from "../../lib/changes/view/changes-view.ts";
import { actionFor } from "../../lib/changes/view/keys.ts";
import { changedLineMatches } from "../../lib/changes/view/line-cursor.ts";
import type { PaneStyler } from "../../lib/changes/view/rows.ts";
import type { PaneScroller } from "../../lib/changes/view/surface.ts";
import { ReviewInput } from "./review-input.ts";
import { REVIEW_HELP_LINES, REVIEW_KEY_HINT, REVIEW_KEYS } from "./review-keys.ts";
import {
  applyStoreState,
  copySelection,
  placeInitialCursor,
  refresh,
  reloadFindings,
} from "./review-view-actions.ts";
import { createChatCommands, submitChat } from "./review-view-chat.ts";
import {
  annotations,
  fileTrailer,
  foldReason,
  followComments,
  riskBadges,
  riskOrder,
  rowDetails,
  submitComment,
  trailer,
} from "./review-view-comments.ts";
import { restoreCommentContext } from "./review-view-context.ts";
import { failureLine, reviewEditorTheme, reviewViewHeights } from "./review-view-format.ts";
import { handleReviewKey, handleReviewMouse } from "./review-view-input.ts";
import { fallbackFrame, leave, renderFailed } from "./review-view-lifecycle.ts";
import { createFileBodyRenderer, renderReviewFrame } from "./review-view-render.ts";
import {
  createReviewSession,
  notify,
  type ReviewContext,
  type ReviewSession,
} from "./review-view-state.ts";
import type { OpenReviewViewOptions, ReviewViewResult } from "./review-view-types.ts";

export type {
  OpenReviewViewOptions,
  RevealedFile,
  RevealFile,
  ReviewFindings,
  ReviewViewDependencies,
  ReviewViewHost,
  ReviewViewResult,
} from "./review-view-types.ts";
export { FINISH_WAIT_MS, LEAVE_SAVE_MS } from "./review-view-types.ts";
export {
  COLLAPSED_TOOL_RENDER_WIDTH,
  composeSessionReviewInstruction,
  formatRelativeTime,
  HIDDEN_FILE_HINT,
  REVIEW_CHAT_SPLIT_MIN_WIDTH,
  REVIEW_CHROME_ROWS,
  reviewViewHeights,
  targetIncludesWorkingTree,
  type ReviewViewHeights,
} from "./review-view-format.ts";

/** Rows use the theme; diff text keeps the caller's styler for inversion and backgrounds. */
function paneStyler(session: ReviewSession, theme: Theme): PaneStyler {
  const diffStyler = session.options.styler;
  const styler: PaneStyler = {
    fg: (color, text) => theme.fg(color, text),
    bold: (text) => theme.bold(text),
    inverse: (text) => diffStyler.inverse(text),
  };
  if (diffStyler.bg) styler.bg = diffStyler.bg.bind(diffStyler);
  if (diffStyler.getFgAnsi) styler.getFgAnsi = diffStyler.getFgAnsi.bind(diffStyler);
  if (diffStyler.getBgAnsi) styler.getBgAnsi = diffStyler.getBgAnsi.bind(diffStyler);
  if (diffStyler.getColorMode) styler.getColorMode = diffStyler.getColorMode.bind(diffStyler);
  return styler;
}

/** What Pi mounts: the review's own view, with every entry point guarded. */
type ReviewComponent = {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
};

/** Builds the view inside Pi's `custom` callback and starts it on the current record. */
function mountReviewView(
  session: ReviewSession,
  tui: TUI,
  theme: Theme,
  done: (result: ReviewViewResult | undefined) => void,
): ReviewComponent {
  const { options } = session;
  session.terminalRows = tui.terminal.rows;
  const styler = paneStyler(session, theme);
  const actions: PaneActions = {
    unfocus: () => leave(ctx),
    close: () => leave(ctx),
    resizeBy: () => {},
    refresh: () => {
      void refresh(ctx, "manual");
    },
    requestRender: () => tui.requestRender(),
    isToggleKey: () => false,
    isFocusKey: () => false,
    copy: (target) => copySelection(ctx, target),
  };

  const changes = new ChangesView({
    store: session.store,
    styler,
    actions,
    renderFileBody: createFileBodyRenderer(session.config),
    keyHint: REVIEW_KEY_HINT,
    helpLines: REVIEW_HELP_LINES,
    keepMessages: true,
    keys: REVIEW_KEYS,
    title: "Review",
    cursor: "line",
    fileOrder: (files) => riskOrder(ctx, files),
    rowBadges: (path) => riskBadges(ctx, path),
    foldReason: (hunkId) => foldReason(ctx, hunkId),
    reviewedHunks: () => new Set(session.record.cursor.reviewedHunkIds),
    mode: () => session.mode,
    search: (query) => changedLineMatches(session.store.model().files, query),
    expandContext: (hunk) => hunkWithExpandedContext(hunk, session.expansions.get(hunk.id)),
    annotations: (path, hunks, width) => annotations(ctx, path, hunks, width),
    fileTrailer: (path, hunks, width) => fileTrailer(ctx, path, hunks, width),
    rowDetails: (path, expanded) => rowDetails(ctx, path, expanded),
    trailer: (width) => trailer(ctx, width),
  });
  session.view = changes;
  session.repaint = () => tui.requestRender();

  const editorTheme = reviewEditorTheme(theme);
  // Two inputs, two providers, two histories. Both complete against the
  // review root rather than the process directory, because a pull request
  // review reads a checked-out worktree that is not the user's cwd.
  const commentInput = new ReviewInput(tui, editorTheme, { root: options.reviewRoot });
  const chatCommands = createChatCommands(session);
  const chatInput = new ReviewInput(tui, editorTheme, {
    root: options.reviewRoot,
    commands: chatCommands,
  });

  const ctx: ReviewContext = Object.assign(session, {
    tui,
    theme,
    done,
    styler,
    changes,
    commentInput,
    chatInput,
    chatCommands,
    busy: false,
    phase: { kind: "open" } as const,
    tokens: 0,
    saveFailedFor: undefined,
    chatOpen: false,
    focus: "review" as const,
    lastBodyHeight: reviewViewHeights(session.terminalRows).bodyHeight,
    scrollTop: 0,
    diffArea: undefined,
    selecting: false,
    lastRevision: -1,
    seenHunks: new Set<string>(),
    seenFiles: new Set<string>(),
    seenTools: new Set<string>(),
    toolViews: new Map(),
    builtInToolDefinitions: new Map(),
    toolsExpanded: false,
    chatScrollOffset: 0,
    contextRestore: 0,
    renderFailure: undefined,
  });
  const scroller: PaneScroller = {
    top: () => ctx.scrollTop,
    viewportHeight: () => ctx.lastBodyHeight,
    scrollTo: (top) => {
      ctx.scrollTop = Math.max(0, top);
    },
    scrollBy: (lines) => {
      ctx.scrollTop = Math.max(0, ctx.scrollTop + lines);
    },
  };
  changes.attachScroller(scroller);
  commentInput.onSubmit = (body) => submitComment(ctx, body);
  chatInput.onSubmit = (question) => submitChat(ctx, question);

  // A resumed record's comments take the line numbers their text has now.
  followComments(ctx);
  restoreCommentContext(ctx);
  // A step that can move comments landed (a reveal, a context read, a refresh): follow it.
  session.afterWork = () => {
    if (session.closed) return;
    followComments(ctx);
    tui.requestRender();
  };
  applyStoreState(ctx);
  placeInitialCursor(ctx);
  session.unsubscribeStore = session.store.subscribe(() => {
    if (session.closed) return;
    applyStoreState(ctx);
    tui.requestRender();
  });
  void reloadFindings(ctx);
  return guardedComponent(ctx);
}

/**
 * pi-tui calls render and handleInput with nothing around them, and Pi
 * exits on any throw that escapes (interactive mode's uncaughtCrash).
 * A full-screen view that cannot draw would also trap the user, so a
 * render failure closes the review at once (the terminal and the pane
 * underneath come back), saves the record as it stands through the
 * store, and says so in Pi's notifications. Later frames until the
 * overlay is gone draw one fallback line without calling the view.
 */
function guardedComponent(ctx: ReviewContext): ReviewComponent {
  const invalidate = () => {
    ctx.changes.invalidate();
    ctx.commentInput.invalidate();
    ctx.chatInput.invalidate();
    for (const toolView of ctx.toolViews.values()) toolView.component.invalidate();
  };
  return {
    render: (width: number): string[] => {
      if (ctx.renderFailure) return fallbackFrame(ctx, width);
      try {
        return renderReviewFrame(ctx, width);
      } catch (error) {
        renderFailed(ctx, error);
        return fallbackFrame(ctx, width);
      }
    },
    invalidate: () => {
      if (ctx.renderFailure) return;
      try {
        invalidate();
      } catch (error) {
        renderFailed(ctx, error);
      }
    },
    handleInput: (data: string) => {
      if (ctx.renderFailure || ctx.closed) return;
      // Closing: only leaving keys count. A change now would miss the copy
      // being saved and be reported as kept when it was not.
      if (ctx.phase.kind !== "open") {
        // A leaving key leaves, whatever has focus (the chat after /quit
        // too): the immediate escape must not depend on where focus is.
        if (actionFor(REVIEW_KEYS, data) === "back") {
          leave(ctx);
          return;
        }
        notify(
          ctx,
          ctx.phase.kind === "leaving"
            ? "Saving the review… q again leaves without saving."
            : "Finishing… q cancels.",
          "info",
        );
        try {
          ctx.tui.requestRender();
        } catch {
          // Drawn with the next frame.
        }
        return;
      }
      try {
        handleReviewKey(ctx, data);
      } catch (error) {
        // The view stays: the failure is on its message line. If the key
        // was one that leaves, leave anyway, so a failing handler can
        // never keep the user in the review.
        if (
          actionFor(REVIEW_KEYS, data) === "back" &&
          !ctx.commentDraft &&
          ctx.focus === "review"
        ) {
          leave(ctx);
        }
        notify(ctx, `That key failed: ${failureLine(error)}`, "error");
        try {
          ctx.tui.requestRender();
        } catch {
          // Drawn with the next frame.
        }
      }
    },
    handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
      if (ctx.renderFailure || ctx.closed || ctx.phase.kind !== "open") return undefined;
      try {
        return handleReviewMouse(ctx, event);
      } catch (error) {
        // The view stays, as for a key that fails.
        ctx.selecting = false;
        notify(ctx, `That click failed: ${failureLine(error)}`, "error");
        return { handled: true, render: true };
      }
    },
  };
}

export async function openReviewView(
  options: OpenReviewViewOptions,
): Promise<ReviewViewResult | undefined> {
  const session = await createReviewSession(options);
  try {
    return await options.host.custom<ReviewViewResult | undefined>(
      (tui, theme, _keybindings, done) => mountReviewView(session, tui, theme, done),
      {
        overlay: true,
        overlayOptions: () => ({
          width: "100%",
          maxHeight: reviewViewHeights(session.terminalRows).overlayMaxHeight,
          margin: 0,
        }),
        onHandle: (handle) => {
          session.overlayHandle = handle;
        },
      },
    );
  } finally {
    session.closed = true;
    session.unsubscribeStore?.();
    session.view?.dispose();
    session.store.dispose();
    session.unsubscribeChat?.();
    session.chat?.dispose();
  }
}
