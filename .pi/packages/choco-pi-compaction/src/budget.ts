import { estimateTextTokens } from "./serialize.ts";
import type { CompactionMessage, CompactionSettings } from "./types.ts";

/**
 * Headroom above the requested output cap, in tokens.
 *
 * `estimateTextTokens` is a chars/4 heuristic, not a tokenizer, so a prompt
 * that only just fits by the estimate can still overflow the real context
 * window. This margin absorbs that error.
 */
export const RESPONSE_MARGIN_TOKENS = 512;

/** The active model's request limits, as the fit test needs them. */
export interface ModelBudget {
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/** Output cap for a summarization request, computed like the host's. */
export function resolveMaxTokens(model: ModelBudget, settings: CompactionSettings): number {
  const reserveCap = Math.floor(0.8 * settings.reserveTokens);
  return model.maxTokens > 0 ? Math.min(reserveCap, model.maxTokens) : reserveCap;
}

/** Whether a request fits: prompt plus reserved output plus margin. */
export function promptFits(
  model: ModelBudget,
  maxTokens: number,
  systemPrompt: string,
  promptText: string,
): boolean {
  if (model.contextWindow <= 0) {
    return true;
  }
  const prompt = estimateTextTokens(systemPrompt) + estimateTextTokens(promptText);
  return prompt + maxTokens + RESPONSE_MARGIN_TOKENS <= model.contextWindow;
}

/** Renders the prompt that would carry a given slice of the retained tail. */
export type TailPromptRenderer = (tail: readonly CompactionMessage[]) => string;

/**
 * Largest suffix of the tail that fits, dropping the oldest messages first.
 *
 * The newest message is never dropped: it is the most recent statement about
 * the work, which is exactly the evidence this package exists to preserve. If
 * even that message alone does not fit, the compaction fails loudly rather
 * than silently committing a summary built from stale history.
 */
export function selectTailWithinBudget(
  model: ModelBudget,
  maxTokens: number,
  systemPrompt: string,
  render: TailPromptRenderer,
  tail: readonly CompactionMessage[],
): readonly CompactionMessage[] {
  if (tail.length === 0) {
    if (promptFits(model, maxTokens, systemPrompt, render(tail))) {
      return tail;
    }
    throw new Error("compaction evidence exceeds the model budget");
  }
  for (let start = 0; start < tail.length; start++) {
    const candidate = tail.slice(start);
    if (promptFits(model, maxTokens, systemPrompt, render(candidate))) {
      return candidate;
    }
  }
  throw new Error("compaction evidence exceeds the model budget");
}
