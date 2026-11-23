import { estimateTextTokens } from "./serialize.ts";
import type { CompactionMessage, CompactionSettings } from "./types.ts";

export const RESPONSE_MARGIN_TOKENS = 512;

export const REASONING_SUMMARY_OUTPUT_TOKENS = 32_768;

export interface ModelBudget {
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning?: boolean;
}

export interface BackgroundLimits {
  readonly maxOutputTokens: number;
  readonly maxInputTokens: number;
}

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

export function resolveMaxTokens(model: ModelBudget, settings: CompactionSettings): number {
  const reserveCap = Math.floor(0.8 * settings.reserveTokens);
  const requested = reasoningOutputCap(model, reserveCap);
  return model.maxTokens > 0 ? Math.min(requested, model.maxTokens) : requested;
}

function reasoningOutputCap(model: ModelBudget | undefined, base: number): number {
  return model?.reasoning === true ? Math.max(base, REASONING_SUMMARY_OUTPUT_TOKENS) : base;
}

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

export type TailPromptRenderer = (tail: readonly CompactionMessage[]) => string;

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
