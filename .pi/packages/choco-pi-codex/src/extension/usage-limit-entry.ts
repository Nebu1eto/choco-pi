import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  takeUsageLimitSignal,
  type UsageLimitSignal,
} from "../providers/openai-codex/usage-limit-signal.ts";
import { isOpenAISignInUsageLimitError } from "../adapter/openai-sign-in.ts";

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

function isOpenAISignInUsageLimitMessage(message: AgentMessage): boolean {
  return (
    message.role === "assistant" &&
    message.stopReason === "error" &&
    message.provider === "openai" &&
    isOpenAISignInUsageLimitError(message.errorMessage)
  );
}

/**
 * Assistant error that may carry a usage-limit entry: any `openai-codex` error, or an `openai`
 * (ChatGPT sign-in on api.openai.com) error whose text carries the subscription usage-limit code.
 */
export function isCodexErrorAssistantMessage(message: AgentMessage): boolean {
  return (
    (message.role === "assistant" &&
      message.stopReason === "error" &&
      message.provider === "openai-codex") ||
    isOpenAISignInUsageLimitMessage(message)
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
 * An `openai` sign-in usage-limit error yields `{ observedAt }` only: api.openai.com reports no
 * reset time, plan, or account id, so none is invented, and the Codex signal is left in place.
 */
export function takeCodexUsageLimitEntry(
  message: AgentMessage,
  sessionId: string,
  now: number = Date.now(),
): CodexUsageLimitEntry | undefined {
  if (isOpenAISignInUsageLimitMessage(message)) return { observedAt: now };
  if (!isCodexErrorAssistantMessage(message)) return undefined;
  const signal = takeUsageLimitSignal(sessionId, now);
  return signal ? toEntry(signal) : undefined;
}
