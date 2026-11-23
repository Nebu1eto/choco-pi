import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { readAgentPreferencesAsync } from "../agent-preferences.ts";
import { rethrowUnlessStaleContext } from "../lifecycle.ts";
import {
  CODEX_USAGE_LIMIT_ENTRY,
  parseCodexUsageLimitEntry,
  parseUsageLimitPendingEntry,
  parseUsageLimitResolvedEntry,
  USAGE_LIMIT_PENDING_ENTRY,
  USAGE_LIMIT_RESOLVED_ENTRY,
  type ChildSessionProbe,
  type CodexUsageLimitEntry,
  type OnUsageLimit,
  type UsageLimitEvidence,
  type UsageLimitPendingEntry,
} from "../usage-limit-contract.ts";
import {
  MINUTE_MS,
  type LimitedTurn,
  type ModelRef,
  type PendingRecord,
  type TimerHandle,
  type UsageLimitHostContext,
  type UsageLimitModel,
} from "./types.ts";

export function scheduleUnrefTimer(callback: () => void, delayMs: number): TimerHandle {
  const timer = setTimeout(callback, Math.max(0, delayMs));
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

export async function readOnUsageLimitPreference(): Promise<OnUsageLimit> {
  return (await readAgentPreferencesAsync()).onUsageLimit;
}

export function modelKey(model: ModelRef | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

export function lastAssistantTurn(branch: readonly SessionEntry[]): LimitedTurn | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    return message.role === "assistant" ? { entryId: entry.id, message } : undefined;
  }
  return undefined;
}

export function latestCodexEntry(
  branch: readonly SessionEntry[],
): CodexUsageLimitEntry | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== CODEX_USAGE_LIMIT_ENTRY) continue;
    const parsed = parseCodexUsageLimitEntry(entry.data);
    if (parsed) return parsed;
  }
  return undefined;
}

export function latestUnresolvedPending(
  branch: readonly SessionEntry[],
): PendingRecord | undefined {
  const resolved = new Set<string>();
  let latest: PendingRecord | undefined;
  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    if (entry.customType === USAGE_LIMIT_PENDING_ENTRY) {
      const pending = parseUsageLimitPendingEntry(entry.data);
      if (!pending) continue;
      const recordedAt = Date.parse(entry.timestamp);
      latest = Number.isFinite(recordedAt) ? { pending, recordedAt } : { pending };
    } else if (entry.customType === USAGE_LIMIT_RESOLVED_ENTRY) {
      const parsed = parseUsageLimitResolvedEntry(entry.data);
      if (parsed) resolved.add(parsed.recoveryId);
    }
  }
  return latest && !resolved.has(latest.pending.recoveryId) ? latest : undefined;
}

export function unresolvedPendingEntry(
  branch: readonly SessionEntry[],
): UsageLimitPendingEntry | undefined {
  return latestUnresolvedPending(branch)?.pending;
}

export function formatReset(resetAt: number | undefined, now: number): string {
  if (resetAt === undefined) return "at an unknown time";
  const minutes = Math.max(1, Math.ceil((resetAt - now) / MINUTE_MS));
  if (minutes < 90) return `in ~${minutes}m`;
  return `in ~${Math.round((minutes / 60) * 10) / 10}h`;
}

type NotifyTarget = Pick<UsageLimitHostContext<UsageLimitModel>, "hasUI" | "ui">;

export function notify(
  ctx: NotifyTarget,
  message: string,
  level: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

export function isInterruptedByLimit(message: AssistantMessage): boolean {
  return message.stopReason === "error";
}

export function isSuccessfulStop(message: AssistantMessage): boolean {
  return (
    message.stopReason === "stop" ||
    message.stopReason === "length" ||
    message.stopReason === "toolUse"
  );
}

export function hasCapacity(evidence: UsageLimitEvidence): boolean {
  return evidence === "capacity";
}

export async function contained(run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
  } catch (error) {
    rethrowUnlessStaleContext(error);
  }
}

export function isChildSession(
  readProbe: () => ChildSessionProbe | undefined,
  sessionId: string | undefined,
): boolean {
  try {
    const probe = readProbe();
    if (!probe) return false;
    if (probe.isChildSessionContext()) return true;
    return sessionId !== undefined && probe.isChildSessionId(sessionId);
  } catch {
    return true;
  }
}
