import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isStaleContextError } from "../lifecycle.ts";

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
  try {
    ctx.ui.notify(`${NOTICE_PREFIX}: ${message}`, "warning");
  } catch (cause) {
    if (!(cause instanceof Error && isStaleContextError(cause))) throw cause;
  }
}
