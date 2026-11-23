/**
 * Unchanged context the reader reveals around hunks (`+`/`-`), and the
 * reads that restore it for comments written on revealed lines.
 */
import {
  collapseHunkContext,
  EXPANSION_LIMIT,
  EXPANSION_STEP,
  expandHunkContext,
  hunkWithExpandedContext,
  type HunkExpansion,
} from "../core/expand.ts";
import { locateComment, revealedContextFits } from "../core/anchor.ts";
import type { DiffModel } from "../core/types.ts";
import { followComments, isHidden, placementOf, shownHunk } from "./review-view-comments.ts";
import { notify, trackWork, type ReviewContext } from "./review-view-state.ts";

export async function expandContext(ctx: ReviewContext): Promise<void> {
  const current = ctx.changes.currentHunk();
  if (!current || !ctx.changes.commentPosition()) {
    notify(ctx, "Select an expanded hunk line before expanding context.", "warning");
    return;
  }
  const model = ctx.store.model();
  const file = model.files.find((entry) => entry.path === current.file.path);
  if (!file) return;
  const hunk = current.hunk;
  const expansion = ctx.expansions.get(hunk.id) ?? { above: [], below: [] };
  const expandEdge = (edge: "above" | "below") =>
    expandHunkContext({
      cwd: ctx.options.reviewRoot,
      model,
      file,
      hunk,
      edge,
      expansion,
      expandedContext: ctx.expansions,
      runner: ctx.options.execRunner,
    });
  const [above, below] = await Promise.all([expandEdge("above"), expandEdge("below")]);
  if (ctx.closed) return;
  if (above.addedLines + below.addedLines === 0) {
    notify(ctx, "No more unchanged context to expand.", "info");
    return;
  }
  setExpansion(ctx, hunk.id, { above: above.expansion.above, below: below.expansion.below });
}

/** Replace one hunk's context; the cursor stays on its line and a selection collapses. */
export function setExpansion(ctx: ReviewContext, hunkId: string, next: HunkExpansion): void {
  const before = ctx.expansions.get(hunkId)?.above.length ?? 0;
  if (next.above.length === 0 && next.below.length === 0) ctx.expansions.delete(hunkId);
  else ctx.expansions.set(hunkId, next);
  ctx.changes.contextChanged(hunkId, next.above.length - before);
}

/**
 * Revealed context is read for a hunk's place: a hunk id names content,
 * not place, so after a refresh a hunk that moved (or left) loses the
 * context read for where it was, which would show other lines under
 * the old numbers. `restoreCommentContext` reads again what comments need.
 */
export function dropMovedContext(ctx: ReviewContext): void {
  const hunks = new Map(
    ctx.store
      .model()
      .files.flatMap((file) => file.hunks)
      .map((hunk) => [hunk.id, hunk]),
  );
  for (const [hunkId, expansion] of ctx.expansions) {
    const hunk = hunks.get(hunkId);
    if (!hunk || !revealedContextFits(hunk, expansion)) {
      setExpansion(ctx, hunkId, { above: [], below: [] });
    }
  }
}

/**
 * A comment written on expanded context (`+`) is not in its hunk as
 * read, so after a resume or a refresh it would be outdated though
 * nothing changed. Expand that hunk the way `+` does, step by step up
 * to `EXPANSION_LIMIT`, until the comment's text is found; keep the
 * expansion only then. A comment whose text is not found within the
 * limit (its text is gone) stays outdated, and its hunk keeps the
 * context it had. A failed read leaves it outdated too: that is what
 * the reader can verify.
 */
export function restoreCommentContext(ctx: ReviewContext): void {
  const started = (ctx.contextRestore += 1);
  const model = ctx.store.model();
  const targets = new Set(
    ctx.record.comments
      .filter((comment) => {
        if (placementOf(ctx, comment)) return false;
        const file = model.files.find((entry) => entry.path === comment.path);
        return (
          file !== undefined &&
          !isHidden(ctx, file.path) &&
          file.hunks.some((hunk) => hunk.id === comment.anchor.hunkHash)
        );
      })
      .map((comment) => comment.id),
  );
  if (targets.size === 0) return;
  void trackWork(
    ctx,
    "context",
    "reading context for comments",
    (comment) => targets.has(comment.id),
    readCommentContext(ctx, started, model, targets),
  ).catch(() => {
    // Reported as unconfirmed by a Finish waiting for it; nothing else to do.
  });
}

export async function readCommentContext(
  ctx: ReviewContext,
  started: number,
  model: DiffModel,
  targets: ReadonlySet<string>,
): Promise<void> {
  const current = () =>
    !ctx.closed && started === ctx.contextRestore && ctx.store.model() === model;
  let restored = false;
  for (const comment of ctx.record.comments) {
    if (!targets.has(comment.id)) continue;
    const file = model.files.find((entry) => entry.path === comment.path);
    const hunk = file?.hunks.find((entry) => entry.id === comment.anchor.hunkHash);
    if (!file || !hunk || isHidden(ctx, file.path)) continue;
    const before = ctx.expansions.get(hunk.id);
    let expansion = before ?? { above: [], below: [] };
    for (let step = 0; step < EXPANSION_LIMIT / EXPANSION_STEP; step += 1) {
      const edge = (side: "above" | "below") =>
        expandHunkContext({
          cwd: ctx.options.reviewRoot,
          model,
          file,
          hunk,
          edge: side,
          expansion,
          expandedContext: ctx.expansions,
          runner: ctx.options.execRunner,
        });
      let read: [Awaited<ReturnType<typeof edge>>, Awaited<ReturnType<typeof edge>>];
      try {
        read = await Promise.all([edge("above"), edge("below")]);
      } catch {
        break;
      }
      if (!current()) return;
      // The user changed this hunk's context meanwhile: theirs stands.
      if (ctx.expansions.get(hunk.id) !== before) break;
      const [above, below] = read;
      if (above.addedLines + below.addedLines === 0) break;
      expansion = { above: above.expansion.above, below: below.expansion.below };
      const trial = hunkWithExpandedContext(hunk, expansion);
      const found = locateComment(comment, model, {
        shown: (candidate) => (candidate.id === hunk.id ? trial : shownHunk(ctx, candidate)),
      });
      if (found.status === "placed" && found.hunkId === hunk.id) {
        setExpansion(ctx, hunk.id, expansion);
        restored = true;
        break;
      }
    }
  }
  if (!restored || !current()) return;
  followComments(ctx);
  ctx.tui.requestRender();
}

export function collapseContext(ctx: ReviewContext): void {
  const current = ctx.changes.currentHunk();
  if (!current || !ctx.changes.commentPosition()) {
    notify(ctx, "Select an expanded hunk line before collapsing context.", "warning");
    return;
  }
  const expansion = ctx.expansions.get(current.hunk.id) ?? { above: [], below: [] };
  if (expansion.above.length === 0 && expansion.below.length === 0) {
    notify(ctx, "No expanded context to collapse.", "info");
    return;
  }
  setExpansion(
    ctx,
    current.hunk.id,
    collapseHunkContext(collapseHunkContext(expansion, "above"), "below"),
  );
}
