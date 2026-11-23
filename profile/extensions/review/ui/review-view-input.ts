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

export function handleReviewKey(ctx: ReviewContext, data: string): void {
  if (ctx.closed) return;
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
  if (matchesKey(data, "ctrl+o") && ctx.chatOpen) {
    toggleToolExpansion(ctx);
    return;
  }
  if (ctx.focus === "chat") {
    if (matchesKey(data, "shift+tab")) setFocus(ctx, "review");
    else if (matchesKey(data, "escape") && !ctx.chatInput.isShowingAutocomplete()) closeChat(ctx);
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

export function handleReviewMouse(
  ctx: ReviewContext,
  event: TuiMouseEvent,
): TuiMouseEventResult | undefined {
  const area = ctx.diffArea;
  if (ctx.closed || !area) return undefined;
  if (ctx.selecting && (event.type === "drag" || event.type === "release")) {
    if (event.type === "release") ctx.selecting = false;
    else {
      const visible = Math.max(-1, Math.min(area.rows, event.y - area.top));
      ctx.changes.pointer({ kind: "drag", row: ctx.scrollTop + visible });
    }
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
