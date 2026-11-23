/**
 * Keys and the mouse in the full-screen review, once the lifecycle guard in
 * `review-view.ts` has let them through.
 */
import { matchesKey, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { launchEditorProject } from "../core/editor-launch.ts";
import { actionFor } from "../../lib/changes/view/keys.ts";
import { REVIEW_KEYS, SPLIT_TOGGLE_KEY } from "./review-keys.ts";
import { editCurrentHunk, guarded, moveFile, search } from "./review-view-actions.ts";
import { closeChat, openChat } from "./review-view-chat.ts";
import { markReviewed, startComment, stopComment } from "./review-view-comments.ts";
import { collapseContext, expandContext } from "./review-view-context.ts";
import { finish } from "./review-view-lifecycle.ts";
import { notify, setFocus, type ReviewContext } from "./review-view-state.ts";
import { toggleToolExpansion } from "./review-view-tools.ts";

/** A key while the review is open and nothing is closing it. */
export function handleReviewKey(ctx: ReviewContext, data: string): void {
  if (ctx.closed) return;
  // A focused input owns the keys the prompt gives it: ↑/↓ move
  // through the text and reach history at the edges, Tab completes a
  // path, and an open completion list takes Esc to dismiss itself
  // before the view reads Esc as leaving.
  if (ctx.commentDraft) {
    if (matchesKey(data, "escape") && !ctx.commentInput.isShowingAutocomplete()) stopComment(ctx);
    else {
      ctx.commentInput.handleInput(data);
      if (ctx.commentDraft)
        ctx.commentDraft = { ...ctx.commentDraft, body: ctx.commentInput.getText() };
      ctx.tui.requestRender();
    }
    return;
  }
  // The main agent's Ctrl+O owns tool-output expansion, so the
  // review chat honors it from either pane whenever tools exist.
  if (matchesKey(data, "ctrl+o") && ctx.chatOpen) {
    toggleToolExpansion(ctx);
    return;
  }
  if (ctx.focus === "chat") {
    // Tab belongs to the editor here, so returning to the diff moves
    // to Shift+Tab rather than costing the chat its completions.
    if (matchesKey(data, "shift+tab")) setFocus(ctx, "review");
    else if (matchesKey(data, "escape") && !ctx.chatInput.isShowingAutocomplete()) closeChat(ctx);
    // The input has no use for page keys, so they scroll the
    // transcript pane instead, one viewport at a time.
    else if (matchesKey(data, "pageUp")) {
      ctx.chatScrollOffset += Math.max(1, ctx.lastBodyHeight - 2);
      ctx.tui.requestRender();
    } else if (matchesKey(data, "pageDown")) {
      ctx.chatScrollOffset = Math.max(
        0,
        ctx.chatScrollOffset - Math.max(1, ctx.lastBodyHeight - 2),
      );
      ctx.tui.requestRender();
    } else {
      ctx.chatInput.handleInput(data);
      ctx.tui.requestRender();
    }
    return;
  }
  if ((matchesKey(data, "tab") || matchesKey(data, "shift+tab")) && ctx.chatOpen) {
    setFocus(ctx, "chat");
    return;
  }
  // Leaving (and closing the key list) never waits for other work.
  if (actionFor(REVIEW_KEYS, data) === "back") {
    ctx.changes.handleKey(data);
    ctx.tui.requestRender();
    return;
  }
  if (ctx.busy) return;
  if (data === "c") startComment(ctx);
  else if (data === "a") openChat(ctx);
  else if (data === "e") void guarded(ctx, () => editCurrentHunk(ctx));
  else if (data === "E")
    void guarded(ctx, () =>
      launchEditorProject(
        ctx.config.editor,
        ctx.options.reviewRoot,
        ctx.tui,
        ctx.options.spawnEditor,
      ),
    );
  else if (data === "m") markReviewed(ctx);
  else if (data === "S") void guarded(ctx, () => finish(ctx));
  else if (data === "/") void guarded(ctx, () => search(ctx));
  else if (data === ">") ctx.changes.moveSearchMatch(1);
  else if (data === "<") ctx.changes.moveSearchMatch(-1);
  else if (data === "+") void guarded(ctx, () => expandContext(ctx));
  else if (data === "-") collapseContext(ctx);
  else if (data === SPLIT_TOGGLE_KEY) {
    ctx.mode = ctx.mode === "unified" ? "split" : "unified";
    ctx.changes.invalidate();
  } else if (matchesKey(data, "right")) moveFile(ctx, 1);
  else if (matchesKey(data, "left")) moveFile(ctx, -1);
  else if (data === "t") {
    notify(ctx, "Type information from review is planned for a later phase.", "info");
  } else ctx.changes.handleKey(data);
  ctx.tui.requestRender();
}

/**
 * The mouse on the diff, as in the `/diff` pane: a press on a line
 * puts the cursor there and drags select lines; a click on a file
 * row opens or closes it. Every left press on the diff is taken,
 * because Pi starts its own text selection on a press nothing takes
 * and copies it on release. The chat, the input and the title row
 * are left to Pi.
 */
export function handleReviewMouse(
  ctx: ReviewContext,
  event: TuiMouseEvent,
): TuiMouseEventResult | undefined {
  const area = ctx.diffArea;
  if (ctx.closed || !area) return undefined;
  if (ctx.selecting && (event.type === "drag" || event.type === "release")) {
    if (event.type === "release") ctx.selecting = false;
    else {
      // At most one row past either edge, so the selection scrolls a row at a time.
      const visible = Math.max(-1, Math.min(area.rows, event.y - area.top));
      ctx.changes.pointer({ kind: "drag", row: ctx.scrollTop + visible });
    }
    // The view asks for a frame itself, and only when the selection changed.
    return { handled: true };
  }
  if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) {
    return undefined;
  }
  const onDiff =
    event.x < area.width && event.y >= area.headerTop && event.y < area.top + area.rows;
  if (!onDiff) return undefined;
  const visible = event.y - area.top;
  const row = visible >= 0 ? ctx.scrollTop + visible : undefined;
  // A comment being written keeps its lines, and a running action its target.
  const usable = !ctx.commentDraft && !ctx.busy;
  if (event.type === "press") {
    const onLine =
      usable &&
      row !== undefined &&
      ctx.changes.pointer({ kind: "press", row, extend: event.shift });
    if (!onLine) return { handled: true, render: false };
    ctx.selecting = true;
    if (ctx.focus !== "review") setFocus(ctx, "review");
    return { handled: true, capture: true, render: true };
  }
  if (!usable) return { handled: true, render: false };
  if (ctx.focus !== "review") setFocus(ctx, "review");
  if (row !== undefined) ctx.changes.pointer({ kind: "click", row });
  return { handled: true, render: true };
}
