import { propertiesWhen, type RuntimeValue } from "../../lib/runtime-values.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderReviewMarkdown } from "../core/markdown-export.ts";
import { sanitizeTerminalText as safe } from "../../lib/changes/terminal-text.ts";
import { isSensitivePath } from "../../lib/changes/sensitive.ts";
import type { ReviewRecord } from "../core/types.ts";
import { followComments, hiddenPaths } from "./review-view-comments.ts";
import {
  composeSessionReviewInstruction,
  failureLine,
  targetIncludesWorkingTree,
} from "./review-view-format.ts";
import { notify, type ReviewContext } from "./review-view-state.ts";
import type { CoordinateWork, ReviewViewResult } from "./review-view-types.ts";

export function close(ctx: ReviewContext, result: ReviewViewResult): boolean {
  if (ctx.phase.kind === "closed" || ctx.closed) return false;
  if (ctx.phase.kind === "leaving") clearTimeout(ctx.phase.timer);
  ctx.phase = { kind: "closed" };
  ctx.done(result);
  return true;
}

export function owns(ctx: ReviewContext, token: number): boolean {
  return (
    !ctx.closed &&
    (ctx.phase.kind === "finishing" || ctx.phase.kind === "leaving") &&
    ctx.phase.token === token
  );
}

export function hostNotice(ctx: ReviewContext, text: string, type: "warning" | "error"): void {
  try {
    ctx.options.host.notify(safe(text), type);
  } catch {}
}

export async function withHostPrompt<T>(ctx: ReviewContext, prompt: () => Promise<T>): Promise<T> {
  ctx.overlayHandle?.setHidden(true);
  try {
    return await prompt();
  } finally {
    ctx.overlayHandle?.setHidden(false);
    ctx.tui.requestRender(true);
  }
}

export function hiddenCommentPaths(ctx: ReviewContext): string[] {
  const listed = new Set(ctx.changes.files().map((file) => file.path));
  const paths = new Set(hiddenPaths(ctx));
  for (const comment of ctx.record.comments) {
    if (!listed.has(comment.path) && isSensitivePath(comment.path)) paths.add(comment.path);
  }
  return [...paths];
}

export function prepareRecord(ctx: ReviewContext, unconfirmed: ReadonlySet<string>): ReviewRecord {
  followComments(ctx, unconfirmed);
  ctx.record = { ...ctx.record, updatedAt: ctx.now() };
  return ctx.record;
}

export function pendingComments(
  ctx: ReviewContext,
  extra: readonly CoordinateWork[] = [],
): Set<string> {
  const open = [...ctx.coordinateWork, ...extra];
  return new Set(
    ctx.record.comments
      .filter((entry) => open.some((work) => work.affects(entry)))
      .map((entry) => entry.id),
  );
}

export async function settleCoordinateWork(
  ctx: ReviewContext,
  token: number,
): Promise<Set<string> | undefined> {
  const deadline = Date.now() + ctx.finishWaitMs;
  const failed: CoordinateWork[] = [];
  while (ctx.coordinateWork.size > 0) {
    const pending = [...ctx.coordinateWork];
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const labels = [...new Set(pending.map((work) => work.label))].join(", ");
    notify(
      ctx,
      `Finishing: waiting for ${labels} (at most ${Math.ceil(remaining / 1000)} s; q cancels).`,
      "info",
    );
    ctx.tui.requestRender();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      Promise.all(
        pending.map((work) =>
          work.settled.then((ok) => {
            if (!ok) failed.push(work);
          }),
        ),
      ).then(() => "settled" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining);
      }),
    ]);
    clearTimeout(timer);
    if (!owns(ctx, token)) return undefined;
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!owns(ctx, token)) return undefined;
    if (outcome === "timeout") break;
  }
  return pendingComments(ctx, failed);
}

export function leave(ctx: ReviewContext): void {
  if (ctx.closed || ctx.phase.kind === "closed") return;
  if (ctx.phase.kind === "leaving") {
    close(ctx, { action: "save", record: ctx.record });
    hostNotice(
      ctx,
      "The review was closed without waiting for its save. If that save finishes, the review is saved; otherwise it is as it was last saved.",
      "warning",
    );
    return;
  }
  if (ctx.saveFailedFor !== undefined && ctx.saveFailedFor === ctx.record) {
    close(ctx, { action: "save", record: ctx.record });
    hostNotice(ctx, "The review was closed without saving; it is as it was last saved.", "warning");
    return;
  }
  ctx.saveFailedFor = undefined;
  const token = (ctx.tokens += 1);
  const kept = prepareRecord(ctx, pendingComments(ctx));
  const timer = setTimeout(
    () =>
      leaveSaveFailed(
        ctx,
        token,
        new Error(`Saving the review took longer than ${ctx.leaveSaveMs / 1000} s.`),
        kept,
      ),
    ctx.leaveSaveMs,
  );
  ctx.phase = { kind: "leaving", token, timer };
  notify(ctx, "Saving the review… q again leaves without saving.", "info");
  ctx.tui.requestRender();
  let saving: Promise<void>;
  try {
    saving = Promise.resolve(ctx.options.store.save(kept));
  } catch (error) {
    saving = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  void saving.then(
    () => {
      if (owns(ctx, token)) close(ctx, { action: "save", record: kept });
    },
    (error: RuntimeValue) => leaveSaveFailed(ctx, token, error, kept),
  );
}

export function leaveSaveFailed(
  ctx: ReviewContext,
  token: number,
  error: RuntimeValue,
  kept: ReviewRecord,
): void {
  if (!owns(ctx, token) || ctx.phase.kind !== "leaving") return;
  clearTimeout(ctx.phase.timer);
  ctx.phase = { kind: "open" };
  ctx.saveFailedFor = kept;
  notify(
    ctx,
    `${error instanceof Error ? error.message : String(error)} Leave again to close without saving; after any change, leaving tries to save again.`,
    "error",
  );
  ctx.tui.requestRender();
}

export async function finish(ctx: ReviewContext): Promise<void> {
  if (ctx.closed || ctx.phase.kind !== "open") return;
  const token = (ctx.tokens += 1);
  ctx.phase = { kind: "finishing", token };
  let outcome: { verdict: ReviewRecord["verdict"]; body: string } | undefined;
  try {
    if (ctx.record.target.kind === "pr") {
      const choices = [
        "Comment",
        "Approve",
        "Request changes",
        "Pending draft to inspect on GitHub",
      ] as const;
      const selected = await withHostPrompt(ctx, () =>
        ctx.options.host.select("Pull request outcome", [...choices]),
      );
      if (selected === undefined || !owns(ctx, token)) return;
      const verdict =
        selected === choices[0]
          ? "comment"
          : selected === choices[1]
            ? "approve"
            : selected === choices[2]
              ? "request-changes"
              : undefined;
      const body = await withHostPrompt(ctx, () =>
        ctx.options.host.input(
          "Overall review summary (required for comment and request changes)",
          ctx.record.body ?? "",
        ),
      );
      if (body === undefined || !owns(ctx, token)) return;
      outcome = { verdict, body: body.trim() };
    }
    const unconfirmed = await settleCoordinateWork(ctx, token);
    if (unconfirmed === undefined || !owns(ctx, token)) return;
    if (outcome) {
      const { verdict: _verdict, body: _body, ...rest } = ctx.record;
      const chosen = outcome;
      ctx.record = {
        ...rest,
        ...propertiesWhen(!(chosen.verdict === undefined), () => ({
          verdict: chosen.verdict,
        })),
        ...propertiesWhen(chosen.body, () => ({ body: chosen.body })),
      };
    }
    const kept = prepareRecord(ctx, unconfirmed);
    await ctx.options.store.save(kept);
    if (!owns(ctx, token)) return;
    const markdown = renderReviewMarkdown(kept, { hiddenPaths: hiddenCommentPaths(ctx) });
    const agentInstruction = composeSessionReviewInstruction(
      kept,
      markdown,
      ctx.options.includesWorkingTree ?? targetIncludesWorkingTree(kept.target),
    );
    const finished = close(ctx, {
      action: "finish",
      record: kept,
      markdown,
      ...propertiesWhen(agentInstruction, () => ({ agentInstruction })),
      ...propertiesWhen(ctx.expansions.size, () => ({ expandedContext: new Map(ctx.expansions) })),
    });
    if (finished && agentInstruction) ctx.options.host.setEditorText(agentInstruction);
  } catch (error) {
    if (owns(ctx, token)) throw error;
  } finally {
    if (owns(ctx, token)) ctx.phase = { kind: "open" };
  }
}

export function renderFailed(ctx: ReviewContext, error: RuntimeValue): void {
  if (ctx.renderFailure) return;
  ctx.renderFailure = { error };
  const reason = failureLine(error);
  queueMicrotask(() => {
    if (ctx.closed || ctx.phase.kind === "closed") return;
    let updatedAt = ctx.record.updatedAt;
    try {
      updatedAt = ctx.now();
    } catch {}
    const kept = { ...ctx.record, updatedAt };
    try {
      close(ctx, { action: "save", record: kept });
    } catch {}
    void Promise.resolve()
      .then(() => ctx.options.store.save(kept))
      .then(
        () =>
          hostNotice(
            ctx,
            `The review could not be drawn (${reason}) and was closed. Your comments and reviewed marks were saved; /review-assist resume opens it again.`,
            "warning",
          ),
        (saveError: RuntimeValue) =>
          hostNotice(
            ctx,
            `The review could not be drawn (${reason}) and was closed, and saving it failed (${failureLine(saveError)}); the review is as it was last saved.`,
            "error",
          ),
      );
  });
}

export function fallbackFrame(ctx: ReviewContext, width: number): string[] {
  const reason = ctx.renderFailure ? failureLine(ctx.renderFailure.error) : "unknown error";
  return [
    truncateToWidth(
      `The review could not be drawn: ${reason}. Closing it.`,
      Math.max(1, width),
      "…",
    ),
  ];
}
