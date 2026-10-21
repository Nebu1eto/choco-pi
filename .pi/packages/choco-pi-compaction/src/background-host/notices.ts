import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { LaneRecordInput } from "../background/lane-journal.ts";
import { isStaleContextError } from "../lifecycle.ts";
import type { HostRuntime } from "./runtime.ts";

const NOTICE_PREFIX = "Background compaction";

/** Shows each distinct background-compaction warning at most once per registration. */
export type Notifier = (ctx: ExtensionContext | undefined, message: string) => void;

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function createNotifier(): Notifier {
  const notified = new Set<string>();
  return (ctx, message) => notifyOnce(notified, ctx, message);
}

function notifyOnce(
  notified: Set<string>,
  ctx: ExtensionContext | undefined,
  message: string,
): void {
  if (ctx === undefined || notified.has(message)) return;
  notified.add(message);
  showNotice(ctx, `${NOTICE_PREFIX}: ${message}`, "warning");
}

export type NoticeLevel = "info" | "warning" | "error";

/** Show a user-facing notice every time it happens (progress of a requested compaction). */
export function tell(ctx: ExtensionContext, message: string, type: NoticeLevel): void {
  showNotice(ctx, `${NOTICE_PREFIX}: ${message}`, type);
}

/** `ctx.ui.notify` with the text exactly as given; only a stale context is contained. */
function showNotice(ctx: ExtensionContext, text: string, type: NoticeLevel): void {
  try {
    ctx.ui.notify(text, type);
  } catch (cause) {
    if (!(cause instanceof Error && isStaleContextError(cause))) throw cause;
  }
}

/**
 * How a lane transition reaches the user (D5):
 * - `always`: user-initiated routes, disables and consented losses; journaled
 *   and notified on every call;
 * - `per-session-reason`: automatic routes; journaled and notified once per
 *   transition (route, event, reason, checkpoint) per session; a repeated
 *   transition is neither journaled again (D4) nor notified;
 * - `silent`: journal only (policy declines).
 */
export type NoticePolicy = "always" | "per-session-reason" | "silent";

/** A lane record as announced: `noticeAttempted` is decided by the policy, whatever the caller set. */
export type AnnouncedRecord = Omit<LaneRecordInput, "noticeAttempted"> & {
  readonly noticeAttempted?: boolean;
};

/** The runtime fields lane announcements read. */
export type AnnounceRuntime = Pick<HostRuntime, "journal" | "transitions">;

/**
 * Journal one lane transition per policy, then notify through `notify`
 * (undefined: no notice is possible). `noticeAttempted` records whether a
 * notice was attempted. Shared by the main owner (host ctx) and child owners
 * (the child bridge's report).
 */
export function announceVia(
  rt: AnnounceRuntime,
  record: AnnouncedRecord,
  policy: NoticePolicy,
  notify: (() => void) | undefined,
): void {
  if (
    policy === "per-session-reason" &&
    rt.transitions.seen(record.sessionId, {
      route: record.route,
      event: record.event,
      reason: record.reason,
      checkpointEntryId: record.checkpointEntryId,
    })
  ) {
    return;
  }
  const attempted = policy !== "silent" && notify !== undefined;
  rt.journal({ ...record, noticeAttempted: attempted });
  if (attempted) notify();
}

/**
 * Journal one lane transition and notify per policy. `always` shows `text`
 * verbatim at `level` (callers own the wording, as the replay-disable notices
 * always did); `per-session-reason` shows it through the registration notifier
 * (prefixed warning, each distinct text at most once per registration, so
 * notices never become more frequent than before the journal existed). `ctx`
 * undefined journals without a notice. Only stale-context failures are
 * contained.
 */
export function announce(
  rt: AnnounceRuntime & Pick<HostRuntime, "notify">,
  ctx: ExtensionContext | undefined,
  record: AnnouncedRecord,
  text: string,
  level: NoticeLevel,
  policy: NoticePolicy,
): void {
  let notify: (() => void) | undefined;
  if (ctx !== undefined) {
    notify = policy === "always" ? () => showNotice(ctx, text, level) : () => rt.notify(ctx, text);
  }
  announceVia(rt, record, policy, notify);
}
