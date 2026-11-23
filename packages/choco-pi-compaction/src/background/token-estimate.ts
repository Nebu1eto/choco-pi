import type { Usage } from "@earendil-works/pi-ai";
import { estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";

import type { CompactionMessage } from "../types.ts";

const CHARS_PER_TOKEN = 4;
export const MIN_TOKENS_PER_CHAR = 1 / 6;
export const MAX_TOKENS_PER_CHAR = 1 / 2;

interface RangeMessage {
  readonly entryId: string;
  readonly message: CompactionMessage;
}

export interface CalibrationInput {
  readonly entries: readonly SessionEntry[];
  readonly range: readonly RangeMessage[];
  readonly baseChars: number;
}

export interface PromptEstimate {
  readonly tokens: number;
  readonly source: "usage-calibrated" | "chars";
  readonly ratio: number;
}

function promptTokens(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function messageChars(message: CompactionMessage): number {
  return estimateTokens(message) * CHARS_PER_TOKEN;
}

function clampRatio(ratio: number): number {
  return Math.min(MAX_TOKENS_PER_CHAR, Math.max(MIN_TOKENS_PER_CHAR, ratio));
}

function measuredPromptTokens(entry: SessionEntry): number | undefined {
  if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
  const message = entry.message;
  if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
  const tokens = promptTokens(message.usage);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

export function usageCalibration(input: CalibrationInput): number | undefined {
  for (let index = input.entries.length - 1; index >= 0; index--) {
    const entry = input.entries[index];
    if (entry === undefined) continue;
    if (entry.type === "compaction" || entry.type === "context_edit") return undefined;
    const tokens = measuredPromptTokens(entry);
    if (tokens === undefined) continue;
    const position = input.range.findIndex((item) => item.entryId === entry.id);
    if (position < 0) continue;
    const chars = input.range
      .slice(0, position)
      .reduce((sum, item) => sum + messageChars(item.message), input.baseChars);
    return chars > 0 ? clampRatio(tokens / chars) : undefined;
  }
  return undefined;
}

export function estimatePromptTokens(
  promptChars: number,
  ratio: number | undefined,
): PromptEstimate {
  if (ratio === undefined) {
    return {
      tokens: Math.ceil(promptChars / CHARS_PER_TOKEN),
      source: "chars",
      ratio: 1 / CHARS_PER_TOKEN,
    };
  }
  return { tokens: Math.ceil(promptChars * ratio), source: "usage-calibrated", ratio };
}
