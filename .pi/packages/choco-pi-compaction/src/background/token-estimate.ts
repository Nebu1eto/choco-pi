/**
 * Prompt-size estimate for background compaction admission.
 *
 * The host's `estimateTokens` is chars/4 over the raw messages, including
 * every untruncated tool result, while the summarization prompt the backend
 * sends renders each tool result truncated. Admission therefore estimates the
 * rendered prompt, and scales it by the tokens-per-character rate the provider
 * itself reported for this prefix when that measurement is still valid.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";

import type { CompactionMessage } from "../types.ts";

/** Host heuristic: four characters per token. */
const CHARS_PER_TOKEN = 4;
/** Calibrated rates outside this band are treated as noise, not as text. */
export const MIN_TOKENS_PER_CHAR = 1 / 6;
export const MAX_TOKENS_PER_CHAR = 1 / 2;

/** One model-visible message of the prefix, tagged with its entry. */
interface RangeMessage {
  readonly entryId: string;
  readonly message: CompactionMessage;
}

export interface CalibrationInput {
  /** Frozen prefix entries, root first. */
  readonly entries: readonly SessionEntry[];
  /** Model-visible messages of the prefix after the latest checkpoint, in order. */
  readonly range: readonly RangeMessage[];
  /** Characters every request since the latest checkpoint carried (its summary). */
  readonly baseChars: number;
}

export interface PromptEstimate {
  readonly tokens: number;
  readonly source: "usage-calibrated" | "chars";
  /** Tokens per character applied. */
  readonly ratio: number;
}

/** Server-measured prompt size of one assistant call. */
function promptTokens(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** Characters of a message as the host's chars/4 heuristic counts them. */
function messageChars(message: CompactionMessage): number {
  return estimateTokens(message) * CHARS_PER_TOKEN;
}

function clampRatio(ratio: number): number {
  return Math.min(MAX_TOKENS_PER_CHAR, Math.max(MIN_TOKENS_PER_CHAR, ratio));
}

/** Prompt tokens of an assistant entry with usable usage, else undefined. */
function measuredPromptTokens(entry: SessionEntry): number | undefined {
  if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
  const message = entry.message;
  if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
  const tokens = promptTokens(message.usage);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

/**
 * Tokens per character measured by the last valid assistant usage in the
 * prefix: its prompt tokens over the characters of every message it was sent
 * (the checkpoint summary plus the visible messages before it), clamped to
 * [{@link MIN_TOKENS_PER_CHAR}, {@link MAX_TOKENS_PER_CHAR}].
 *
 * Usage recorded before a later `compaction` or `context_edit` entry measured
 * a different context and is ignored, as the host invalidates it. Aborted,
 * errored, and zero usage is skipped. Undefined when nothing valid remains.
 */
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

/** Tokens of a rendered prompt: calibrated when a ratio is known, else chars/4. */
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
