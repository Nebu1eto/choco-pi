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

/**
 * Output cap granted to a summary request on a reasoning model, in tokens.
 *
 * Reasoning shares the output cap on OpenAI-compatible and Anthropic
 * endpoints, so a model that always reasons can spend the whole summary cap
 * before writing the summary. A live GLM-5.3 compaction of a 290k-token
 * session hit the host-derived 13,107-token cap after nine minutes of
 * reasoning (2026-10-16). Both lanes therefore grant at least this much to a
 * reasoning model, clamped to the model's own output limit; the summary call
 * also asks for the lowest thinking level the model supports.
 */
export const REASONING_SUMMARY_OUTPUT_TOKENS = 32_768;

/** The active model's request limits, as the fit test needs them. */
export interface ModelBudget {
  readonly contextWindow: number;
  readonly maxTokens: number;
  /** Whether the model reasons; raises a summary cap to {@link REASONING_SUMMARY_OUTPUT_TOKENS}. */
  readonly reasoning?: boolean;
}

/** Output cap sent with a background summary request and the input budget beside it. */
export interface BackgroundLimits {
  readonly maxOutputTokens: number;
  readonly maxInputTokens: number;
}

/**
 * Effective background preparation limits: the configured ceiling, narrowed
 * by the model window minus the output cap and response margin. Without a
 * model budget only the configured values apply. Undefined when nothing fits.
 */
export function resolveBackgroundLimits(
  model: ModelBudget | undefined,
  budget: { readonly maxInputTokens: number; readonly maxOutputTokens: number },
): BackgroundLimits | undefined {
  const requested = reasoningOutputCap(model, budget.maxOutputTokens);
  const maxOutputTokens =
    model !== undefined && model.maxTokens > 0 ? Math.min(requested, model.maxTokens) : requested;
  const windowLimit =
    model !== undefined && model.contextWindow > 0
      ? model.contextWindow - maxOutputTokens - RESPONSE_MARGIN_TOKENS
      : Number.POSITIVE_INFINITY;
  const maxInputTokens = Math.min(budget.maxInputTokens, windowLimit);
  if (!(maxOutputTokens > 0) || !(maxInputTokens > 0)) return undefined;
  return { maxOutputTokens, maxInputTokens };
}

/**
 * Output cap for a summarization request: Pi 1.3.0's host formula
 * (`0.8 * reserveTokens`, clamped to the model limit), raised for reasoning
 * models. Pi 1.4.0 dropped its own cap and lets summaries use the model's
 * output limit; this package keeps an explicit cap because {@link promptFits}
 * reserves it from the context window, and the model's full output limit
 * would leave far less room for the history being summarized.
 */
export function resolveMaxTokens(model: ModelBudget, settings: CompactionSettings): number {
  const reserveCap = Math.floor(0.8 * settings.reserveTokens);
  const requested = reasoningOutputCap(model, reserveCap);
  return model.maxTokens > 0 ? Math.min(requested, model.maxTokens) : requested;
}

/** `base`, or the reasoning summary cap when it is larger and the model reasons. */
function reasoningOutputCap(model: ModelBudget | undefined, base: number): number {
  return model?.reasoning === true ? Math.max(base, REASONING_SUMMARY_OUTPUT_TOKENS) : base;
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
