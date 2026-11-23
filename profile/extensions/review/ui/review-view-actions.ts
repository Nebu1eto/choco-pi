import type { RuntimeValue } from "../../lib/runtime-values.ts";
import { resolve } from "node:path";
import { launchEditor } from "../core/editor-launch.ts";
import { assessDiff } from "../core/heuristics.ts";
import { clipboardText } from "../../lib/changes/references.ts";
import type { AskTarget } from "../../lib/changes/view/changes-view.ts";
import { plural } from "../../lib/changes/view/rows.ts";
import { assessmentOf, followComments } from "./review-view-comments.ts";
import { dropMovedContext, restoreCommentContext } from "./review-view-context.ts";
import { failureLine, HIDDEN_FILE_HINT } from "./review-view-format.ts";
import { withHostPrompt } from "./review-view-lifecycle.ts";
import { notify, type ReviewContext } from "./review-view-state.ts";

export function copySelection(ctx: ReviewContext, target: AskTarget): void {
  const hunk = target.hunk;
  if (!hunk) {
    notify(ctx, "Nothing to copy on a file's row: move to a line first.", "info");
    return;
  }
  const write = ctx.options.copyText;
  if (!write) {
    notify(ctx, "Copying is not available here.", "warning");
    return;
  }
  const lines = target.lines;
  const text = clipboardText(hunk, lines);
  const copied = lines
    ? `Copied ${plural(lines.last - lines.first + 1, "line")}.`
    : `Copied the hunk as a diff (${plural(hunk.lines.length, "line")}).`;
  void (async () => {
    await write(text);
    if (!ctx.closed) notify(ctx, copied, "info");
  })().catch((error: RuntimeValue) =>
    notify(ctx, `Cannot copy to the clipboard: ${failureLine(error)}`, "warning"),
  );
}

export function seedFolds(ctx: ReviewContext): void {
  const reviewed = new Set(ctx.record.cursor.reviewedHunkIds);
  const collapsed = new Set(
    ctx.assessments.hunks.filter((hunk) => hunk.collapsed).map((hunk) => hunk.hunkId),
  );
  for (const file of ctx.store.model().files) {
    for (const hunk of file.hunks) {
      if (ctx.seenHunks.has(hunk.id)) continue;
      ctx.seenHunks.add(hunk.id);
      if (reviewed.has(hunk.id) || collapsed.has(hunk.id)) ctx.changes.setFolded(hunk.id, true);
    }
  }
  for (const file of ctx.store.model().files) {
    if (ctx.seenFiles.has(file.path)) continue;
    ctx.seenFiles.add(file.path);
    if (!assessmentOf(ctx, file.path)?.collapsed) ctx.changes.expand(file.path);
  }
}

export function applyStoreState(ctx: ReviewContext): void {
  const state = ctx.store.getState();
  const revision = state.kind === "ready" ? state.snapshot.revision : ctx.lastRevision;
  if (revision !== ctx.lastRevision && ctx.lastRevision >= 0) {
    ctx.assessments = assessDiff(ctx.store.model(), ctx.config);
  }
  ctx.changes.setState(state);
  if (revision !== ctx.lastRevision) {
    ctx.lastRevision = revision;
    seedFolds(ctx);
    ctx.changes.invalidate();
  }
}

export function placeInitialCursor(ctx: ReviewContext): void {
  const reviewed = new Set(ctx.record.cursor.reviewedHunkIds);
  const model = ctx.store.model();
  const located = ctx.changes.files().flatMap((summary) =>
    (model.files.find((file) => file.path === summary.path)?.hunks ?? []).map((hunk) => ({
      path: summary.path,
      hunk,
    })),
  );
  const target = located.find((entry) => !reviewed.has(entry.hunk.id)) ?? located[0];
  if (!target) {
    const first = ctx.changes.files()[0];
    if (first) ctx.changes.setCursor({ path: first.path });
    return;
  }
  if (!ctx.changes.expanded.has(target.path)) {
    ctx.changes.setCursor({ path: target.path });
    return;
  }
  const folded = ctx.changes.foldedHunks.has(target.hunk.id);
  ctx.changes.setCursor(
    folded || target.hunk.lines.length === 0
      ? { path: target.path, hunkId: target.hunk.id }
      : { path: target.path, hunkId: target.hunk.id, lineIndex: 0 },
  );
}

export async function guarded(ctx: ReviewContext, action: () => Promise<void>): Promise<void> {
  if (ctx.busy) return;
  ctx.busy = true;
  try {
    await action();
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  } finally {
    ctx.busy = false;
    ctx.tui.requestRender();
  }
}

export async function search(ctx: ReviewContext): Promise<void> {
  const query = await withHostPrompt(ctx, () =>
    ctx.options.host.input("Search changed lines", ctx.changes.searchState?.query ?? ""),
  );
  if (query === undefined || ctx.closed) return;
  ctx.changes.setSearch(query);
  const found = ctx.changes.searchState;
  if (found && found.matches.length === 0)
    notify(ctx, `No changed line contains “${query}”.`, "info");
}

export function editorLine(ctx: ReviewContext): number {
  const position = ctx.changes.commentPosition();
  if (position) return position.line;
  const current = ctx.changes.currentHunk();
  if (!current) return 1;
  return current.file.status === "deleted" ? current.hunk.oldStart : current.hunk.newStart;
}

export async function editCurrentHunk(ctx: ReviewContext): Promise<void> {
  const file = ctx.changes.selectedFile();
  if (!file) return;
  if (!ctx.changes.canShowContents(file)) {
    notify(ctx, HIDDEN_FILE_HINT, "warning");
    return;
  }
  await launchEditor(
    ctx.config.editor,
    {
      path: resolve(ctx.options.reviewRoot, file.path),
      line: editorLine(ctx),
      column: 1,
      dir: ctx.options.reviewRoot,
    },
    ctx.tui,
    ctx.options.spawnEditor,
  );
}

export function moveFile(ctx: ReviewContext, delta: number): void {
  const files = ctx.changes.files();
  const file = files[Math.max(0, Math.min(files.length - 1, ctx.changes.selectedIndex + delta))];
  if (!file) return;
  ctx.changes.setCursor({ path: file.path });
  if (ctx.changes.expanded.has(file.path) && (ctx.changes.displayHunks(file)?.length ?? 0) > 0) {
    ctx.changes.moveCursor(1);
  }
}

export async function reloadFindings(ctx: ReviewContext): Promise<void> {
  const load = ctx.options.loadFindings;
  if (!load) return;
  try {
    const found = await load(ctx.changes.files().map((file) => file.path));
    if (ctx.closed) return;
    ctx.changes.setRecorded(found.recorded, found.changeTimes);
    ctx.tui.requestRender();
  } catch (error) {
    if (!ctx.closed)
      notify(
        ctx,
        `Review findings could not be read: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
  }
}

export async function refresh(ctx: ReviewContext, reason: "manual" | "tool"): Promise<void> {
  if (!ctx.store.canRefresh) {
    if (reason === "manual") {
      ctx.changes.setMessage("This review's target cannot change, so there is nothing to refresh.");
      ctx.tui.requestRender();
    }
    return;
  }
  try {
    const outcome = await ctx.store.refresh();
    if (ctx.closed || outcome === "stale") return;
    followComparison(ctx);
    if (reason === "manual") {
      ctx.changes.setMessage(
        outcome === "changed"
          ? "Read the changes again."
          : "Read the changes again; nothing changed.",
      );
    }
    await reloadFindings(ctx);
  } catch (error) {
    if (!ctx.closed) {
      notify(
        ctx,
        `Refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  } finally {
    if (!ctx.closed) ctx.tui.requestRender();
  }
}

export function followComparison(ctx: ReviewContext): void {
  dropMovedContext(ctx);
  followComments(ctx);
  restoreCommentContext(ctx);
  if (ctx.record.target.kind === "pr") return;
  const { baseSha, headSha } = ctx.store.model();
  if (ctx.record.baseSha === baseSha && ctx.record.headSha === headSha) return;
  ctx.record = {
    ...ctx.record,
    baseSha,
    headSha,
    cursor: { ...ctx.record.cursor, lastHeadSha: headSha },
  };
}
