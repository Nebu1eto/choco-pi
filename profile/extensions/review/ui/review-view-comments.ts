/**
 * Review comments in the view: where each one is now, how the changes view
 * decorates rows and hunks with them, and writing a new one.
 */
import { propertiesWhen } from "../../lib/runtime-values.ts";
import { hunkWithExpandedContext } from "../core/expand.ts";
import { locateComment, type CommentLocation } from "../core/anchor.ts";
import { markHunksReviewed } from "../core/store.ts";
import type { FileSummary } from "../../lib/changes/git/model.ts";
import type { BodyAnnotation } from "../../lib/changes/view/body-block.ts";
import type { RowDetail } from "../../lib/changes/view/changes-view.ts";
import type { RowBadge } from "../../lib/changes/view/rows.ts";
import type { DiffHunk, ReviewComment } from "../core/types.ts";
import { commitComment } from "./view-state.ts";
import { commentBlock, commentLineIndex, outdatedCommentLines } from "./review-view-format.ts";
import { notify, type ReviewContext, type ReviewSession } from "./review-view-state.ts";

export function assessmentOf(ctx: ReviewSession, path: string) {
  return ctx.assessments.files.find((assessment) => assessment.path === path);
}

function commentsOn(ctx: ReviewSession, hunkId: string) {
  return ctx.record.comments.filter((comment) => comment.anchor.hunkHash === hunkId);
}

/** A hunk as the reader sees it, with the context revealed around it. */
export function shownHunk(ctx: ReviewSession, hunk: DiffHunk): DiffHunk {
  const expansion = ctx.expansions.get(hunk.id);
  return expansion ? hunkWithExpandedContext(hunk, expansion) : hunk;
}

/**
 * Where a comment is now: `locateComment` (core/anchor.ts), the one
 * decision the pull-request plan also makes, on the model shown and
 * with the context revealed. Nothing here trusts a stored line.
 */
export function locationOf(ctx: ReviewContext, comment: ReviewComment): CommentLocation {
  return locateComment(comment, ctx.store.model(), { shown: (hunk) => shownHunk(ctx, hunk) });
}

export function placementOf(ctx: ReviewContext, comment: ReviewComment) {
  const location = locationOf(ctx, comment);
  return location.status === "placed" ? location : undefined;
}

/**
 * The only writer of where the record says comments are. Each comment
 * takes what `locationOf` says now: placed, its current hunk,
 * position and lines; outdated, its last lines, marked `outdated`; a
 * withheld file, unchanged. Comments in `unconfirmed` (work that could
 * move them has not finished) keep their lines and are marked so,
 * never presented as current. Run on open, after each refresh, after
 * a reveal or a context read lands, and before every save.
 */
export function followComments(ctx: ReviewContext, given: ReadonlySet<string> = new Set()): void {
  // A failed read leaves its comments uncertain until one succeeds.
  const unconfirmed = new Set(given);
  for (const affects of ctx.failedReads.values()) {
    for (const comment of ctx.record.comments) if (affects(comment)) unconfirmed.add(comment.id);
  }
  let changed = false;
  const comments = ctx.record.comments.map((comment): ReviewComment => {
    const { stale: _stale, ...current } = comment;
    let next: ReviewComment;
    if (unconfirmed.has(comment.id)) {
      next = { ...current, stale: "unconfirmed" };
    } else {
      const location = locationOf(ctx, comment);
      if (location.status === "hidden") return comment;
      if (location.status === "outdated") {
        next = { ...current, stale: "outdated" };
      } else {
        const { startLine: _startLine, ...rest } = current;
        next = {
          ...rest,
          line: location.line,
          ...propertiesWhen(!(comment.startLine === undefined), () => ({
            startLine: location.startLine,
          })),
          anchor: {
            ...comment.anchor,
            hunkHash: location.hunkId,
            position: location.position,
          },
        };
      }
    }
    if (JSON.stringify(next) === JSON.stringify(comment)) return comment;
    changed = true;
    return next;
  });
  if (changed) ctx.record = { ...ctx.record, comments };
}

export function riskOrder(
  ctx: ReviewContext,
  files: readonly FileSummary[],
): readonly FileSummary[] {
  const rank = new Map(ctx.assessments.reviewOrder.map((path, index) => [path, index]));
  return files
    .map((file, index) => ({ file, rank: rank.get(file.path) ?? rank.size + index }))
    .sort((left, right) => left.rank - right.rank)
    .map((entry) => entry.file);
}

export function riskBadges(ctx: ReviewContext, path: string): RowBadge[] {
  const score = assessmentOf(ctx, path)?.riskScore ?? 0;
  return score > 0 ? [{ text: `▲${score}`, color: score >= 30 ? "error" : "warning" }] : [];
}

export function foldReason(ctx: ReviewContext, hunkId: string): string {
  const reason = ctx.record.cursor.reviewedHunkIds.includes(hunkId)
    ? "Already reviewed in this review"
    : (ctx.assessments.hunks.find((hunk) => hunk.hunkId === hunkId)?.reason ??
      "Folded by reviewer");
  const count = commentsOn(ctx, hunkId).length;
  if (count === 0) return reason;
  return `${reason} · ${count} comment${count === 1 ? "" : "s"} inside`;
}

/** True while a listed file's contents are hidden as sensitive. */
export function isHidden(ctx: ReviewContext, path: string): boolean {
  const summary = ctx.changes.files().find((file) => file.path === path);
  return summary !== undefined && !ctx.changes.canShowContents(summary);
}

export function rowDetails(ctx: ReviewContext, path: string, expanded: boolean): RowDetail[] {
  const details: RowDetail[] = [];
  const assessment = assessmentOf(ctx, path);
  if (assessment && assessment.riskScore > 0 && assessment.reasons.length > 0) {
    details.push({ text: assessment.reasons.join("; "), color: "muted" });
  }
  if (!expanded && assessment?.collapsed) {
    details.push({
      text: `Hidden: ${assessment.collapseReason ?? "folded by the review's rules"} · ⏎ shows it`,
      color: "dim",
    });
  }
  // A read limit or error kept the body out; say so on the row, as the body does.
  const notice = ctx.store.model().notices?.find((entry) => entry.path === path)?.message;
  if (notice !== undefined) details.push({ text: notice, color: "warning" });
  if (isHidden(ctx, path)) {
    const count = ctx.record.comments.filter((comment) => comment.path === path).length;
    if (count > 0) {
      details.push({
        text: `${count} comment${count === 1 ? "" : "s"} on this file, shown with its contents.`,
        color: "dim",
      });
    }
  }
  return details;
}

export function annotations(
  ctx: ReviewContext,
  path: string,
  hunks: readonly DiffHunk[],
  width: number,
): BodyAnnotation[] {
  const placed: BodyAnnotation[] = [];
  for (const hunk of hunks) {
    for (const comment of ctx.record.comments) {
      if (comment.path !== path) continue;
      // Placed by its text, in whichever hunk holds it now; a comment
      // whose text is gone is drawn outdated below.
      const at = placementOf(ctx, comment);
      if (!at || at.hunkId !== hunk.id) continue;
      const lineIndex = commentLineIndex(hunk, { side: comment.side, line: at.line });
      placed.push({
        hunkId: hunk.id,
        // A line no longer displayed (its context collapsed) falls back to the header.
        place: lineIndex < 0 ? "header" : { afterLine: lineIndex },
        lines: commentBlock(comment, width, ctx.styler),
      });
    }
  }
  return placed;
}

/** Comments whose text is no longer in their listed file (hunk gone, or text not found in it). */
export function fileTrailer(
  ctx: ReviewContext,
  path: string,
  _hunks: readonly DiffHunk[],
  width: number,
): string[] {
  return ctx.record.comments
    .filter((comment) => comment.path === path && locationOf(ctx, comment).status === "outdated")
    .flatMap((comment) => outdatedCommentLines(comment, false, width, ctx.styler));
}

/** Comments on files that left the diff, under the pane's heading. */
export function trailer(ctx: ReviewContext, width: number): string[] {
  const listed = new Set(ctx.changes.files().map((file) => file.path));
  const gone = ctx.record.comments.filter((comment) => !listed.has(comment.path));
  if (gone.length === 0) return [];
  return [
    "",
    ctx.styler.fg("dim", "Not in this diff:"),
    ...gone.flatMap((comment) => outdatedCommentLines(comment, true, width, ctx.styler)),
  ];
}

export function stopComment(ctx: ReviewContext): void {
  ctx.commentInput.focused = false;
  ctx.commentDraft = undefined;
  ctx.tui.requestRender();
}

/** A hunk as displayed now (revealed context included), from the current model. */
export function displayHunk(
  ctx: ReviewContext,
  path: string,
  hunkId: string,
): DiffHunk | undefined {
  const hunk = ctx.store
    .model()
    .files.find((file) => file.path === path)
    ?.hunks.find((candidate) => candidate.id === hunkId);
  return hunk ? hunkWithExpandedContext(hunk, ctx.expansions.get(hunk.id)) : undefined;
}

export function submitComment(ctx: ReviewContext, body: string): void {
  // Recall before the outcome is decided: a comment refused for being
  // empty is dropped by the history itself, and one that lands is worth
  // recalling when the next hunk needs the same remark.
  ctx.commentInput.remember(body);
  if (!ctx.commentDraft) return;
  ctx.commentDraft = { ...ctx.commentDraft, body };
  if (body.trim().length === 0) {
    ctx.tui.requestRender();
    return;
  }
  const draft = ctx.commentDraft;
  const hunk = displayHunk(ctx, draft.position.path, draft.position.hunkId);
  if (!hunk) {
    notify(
      ctx,
      "The comment's hunk is no longer in this review; the comment was not added.",
      "warning",
    );
    return;
  }
  ctx.record = commitComment(ctx.record, draft, hunk, {
    id: ctx.createCommentId(),
    timestamp: ctx.now(),
  });
  ctx.commentDraft = undefined;
  ctx.commentInput.focused = false;
  ctx.changes.invalidate();
  ctx.tui.requestRender();
}

/** Sensitive files whose contents are hidden now. */
export function hiddenPaths(ctx: ReviewContext): string[] {
  return ctx.changes
    .files()
    .filter((file) => !ctx.changes.canShowContents(file))
    .map((file) => file.path);
}

export function startComment(ctx: ReviewContext): void {
  const position = ctx.changes.commentPosition();
  if (!position) {
    notify(ctx, "Select an expanded diff line before commenting.", "warning");
    return;
  }
  ctx.commentDraft = { position, body: "" };
  ctx.commentInput.setText("");
  ctx.commentInput.focused = true;
  ctx.tui.requestRender();
}

export function markReviewed(ctx: ReviewContext): void {
  const current = ctx.changes.currentHunk();
  if (!current) return;
  ctx.record = {
    ...markHunksReviewed(ctx.record, [current.hunk.id], ctx.store.model().headSha),
    updatedAt: ctx.now(),
  };
  ctx.changes.setFolded(current.hunk.id, true);
  ctx.changes.invalidate();
}
