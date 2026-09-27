import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  takeUsageLimitSignal,
  type UsageLimitSignal,
} from "../providers/openai-codex/usage-limit-signal.ts";

/**
 * Structural copy of `CodexUsageLimitEntry` in `.pi/extensions/lib/usage-limit-contract.ts`.
 * This vendored package must not import root extension code; keep the name, custom type, and
 * shape identical. `resetAt` and `observedAt` are epoch milliseconds.
 */
export const CODEX_USAGE_LIMIT_ENTRY = "choco-pi-codex-usage-limit";
export type CodexUsageLimitEntry = {
  resetAt?: number;
  planType?: string;
  accountId?: string;
  observedAt: number;
};

export function isCodexErrorAssistantMessage(message: AgentMessage): boolean {
  return (
    message.role === "assistant" &&
    message.stopReason === "error" &&
    message.provider === "openai-codex"
  );
}

function toEntry(signal: UsageLimitSignal): CodexUsageLimitEntry {
  const entry: CodexUsageLimitEntry = { observedAt: signal.observedAt };
  if (signal.resetAt !== undefined) entry.resetAt = signal.resetAt;
  if (signal.planType !== undefined) entry.planType = signal.planType;
  if (signal.accountId !== undefined) entry.accountId = signal.accountId;
  return entry;
}

/**
 * Drain the provider's usage-limit signal for `sessionId` when `message` is a Codex error.
 * Non-Codex or non-error messages leave any pending signal in place.
 */
export function takeCodexUsageLimitEntry(
  message: AgentMessage,
  sessionId: string,
  now: number = Date.now(),
): CodexUsageLimitEntry | undefined {
  if (!isCodexErrorAssistantMessage(message)) return undefined;
  const signal = takeUsageLimitSignal(sessionId, now);
  return signal ? toEntry(signal) : undefined;
}
