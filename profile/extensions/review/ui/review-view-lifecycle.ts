/**
 * Leaving, finishing and failing to draw: the review's lifecycle phases and
 * the one `close` every completion goes through.
 */
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

/** True while the Finish or leave started with `token` still owns the view. */
export function owns(ctx: ReviewContext, token: number): boolean {
  return (
    !ctx.closed &&
    (ctx.phase.kind === "finishing" || ctx.phase.kind === "leaving") &&
    ctx.phase.token === token
  );
}

/** Pi's notifications, for what must outlive the view. Never throws; silent when stale. */
export function hostNotice(ctx: ReviewContext, text: string, type: "warning" | "error"): void {
  try {
    ctx.options.host.notify(safe(text), type);
  } catch {
    // A stale context: the session ended, there is nobody to tell.
  }
}

/**
 * Run a host prompt that draws into the session's own editor row.
 *
 * The review is a focus-capturing overlay: while it is visible it covers
 * the editor row and holds the keyboard. A `select` or `input` opened from
 * inside it is mounted underneath, so it renders invisibly while taking
 * focus away from the review — the user sees a frozen review, every key
 * reaches a prompt that is not on screen, and the awaited promise never
 * settles. Hiding the overlay for the duration puts the prompt where it
 * can be seen and answered, and restores the review afterwards.
 */
export async function withHostPrompt<T>(ctx: ReviewContext, prompt: () => Promise<T>): Promise<T> {
  ctx.overlayHandle?.setHidden(true);
  try {
    return await prompt();
  } finally {
    ctx.overlayHandle?.setHidden(false);
    ctx.tui.requestRender(true);
  }
}

/** Sensitive paths whose comments must not quote source lines. */
export function hiddenCommentPaths(ctx: ReviewContext): string[] {
  const listed = new Set(ctx.changes.files().map((file) => file.path));
  const paths = new Set(hiddenPaths(ctx));
  for (const comment of ctx.record.comments) {
    if (!listed.has(comment.path) && isSensitivePath(comment.path)) paths.add(comment.path);
  }
  return [...paths];
}

/**
 * The record as it is exported: every comment where `locateComment`
 * finds it now, and `unconfirmed` ones (work that could move them did
 * not finish) marked so rather than presented as current.
 */
export function prepareRecord(ctx: ReviewContext, unconfirmed: ReadonlySet<string>): ReviewRecord {
  followComments(ctx, unconfirmed);
  ctx.record = { ...ctx.record, updatedAt: ctx.now() };
  return ctx.record;
}

/** Comments that pending coordinate work could still move. */
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

/**
 * Finish waits for the work that can move comments (a refresh, a
 * context read, a reveal), at most FINISH_WAIT_MS in all, saying so on
 * the message line; q cancels the wait. Work that started meanwhile
 * (a refresh starts a context read) is waited for too. Undefined when
 * the Finish no longer owns the view; else the comments to export as
 * unconfirmed (work still pending at the limit, or failed).
 */
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
    // Let what the settled work does next run (the store's update, a follow-up read).
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!owns(ctx, token)) return undefined;
    if (outcome === "timeout") break;
  }
  return pendingComments(ctx, failed);
}

/**
 * q, Esc and the chat's /quit. From open or finishing: one save of the
 * record as it stands (a pending Finish is cancelled), at most
 * LEAVE_SAVE_MS; the message line says that q again leaves without
 * saving. While that save runs: q closes at once. A save that fails or
 * takes too long keeps the review open and says so; leaving again then
 * closes without saving, so a store that keeps failing can never keep
 * the user in the review.
 */
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
  // Started now, in this key's turn; a store that throws at once counts as failing.
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
    // Committed: the chosen outcome enters the record only now, so a
    // Finish cancelled before its save leaves the verdict and body as
    // they were. From here on the user has confirmed them; if this save
    // fails they stay, and the next save (q or S) writes them.
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
    // A Finish that a q cancelled stays silent, whatever its save does.
    if (owns(ctx, token)) throw error;
  } finally {
    if (owns(ctx, token)) ctx.phase = { kind: "open" };
  }
}

export function renderFailed(ctx: ReviewContext, error: RuntimeValue): void {
  if (ctx.renderFailure) return;
  ctx.renderFailure = { error };
  const reason = failureLine(error);
  // After this frame: closing inside pi-tui's render would re-enter it.
  // Nothing in this microtask may throw: nothing above it would catch.
  queueMicrotask(() => {
    if (ctx.closed || ctx.phase.kind === "closed") return;
    let updatedAt = ctx.record.updatedAt;
    try {
      updatedAt = ctx.now();
    } catch {
      // The clock is what failed: keep the last time.
    }
    const kept = { ...ctx.record, updatedAt };
    try {
      close(ctx, { action: "save", record: kept });
    } catch {
      // The host already tore the view down; the save below still runs.
    }
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
