import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  takeUsageLimitSignal,
  type UsageLimitSignal,
} from "../providers/openai-codex/usage-limit-signal.ts";
import { isOpenAISignInUsageLimitError } from "../adapter/openai-sign-in.ts";

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
