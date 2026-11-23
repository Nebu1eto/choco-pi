import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { LaneRecordInput } from "../background/lane-journal.ts";
import { isStaleContextError } from "@choco-pi/shared/lifecycle";
import type { HostRuntime } from "./runtime.ts";

const NOTICE_PREFIX = "Background compaction";

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

export function tell(ctx: ExtensionContext, message: string, type: NoticeLevel): void {
  showNotice(ctx, `${NOTICE_PREFIX}: ${message}`, type);
}

function showNotice(ctx: ExtensionContext, text: string, type: NoticeLevel): void {
  try {
    ctx.ui.notify(text, type);
  } catch (cause) {
    if (!(cause instanceof Error && isStaleContextError(cause))) throw cause;
  }
}

export type NoticePolicy = "always" | "per-session-reason" | "silent";

export type AnnouncedRecord = Omit<LaneRecordInput, "noticeAttempted"> & {
  readonly noticeAttempted?: boolean;
};

export type AnnounceRuntime = Pick<HostRuntime, "journal" | "transitions">;

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
