import type { CallRecord } from "./records.ts";

/**
 * Whether Fast mode was applied to one call, read from the log alone.
 *
 * Pi persists no service tier. What it does persist is the price: Codex and
 * xAI both charge an applied Fast call at a multiple of the list rate before
 * the message is written, so the recorded output rate against the list rate
 * of the tier the call fell in says whether Fast was applied. xAI also echoes
 * the Fast model id. When neither is available the session's requested state
 * (the choco-pi-fast-mode entry in force at the call) decides: not requested
 * means not applied; requested without price evidence stays unknown, since
 * whether it was honoured depends on host and auth the log does not record.
 */

export type FastState = "on" | "off" | "unknown";

/** One price tier: rates in dollars per million tokens, in force above a context size. */
export type PriceTier = {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type PriceRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ModelPrices = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: readonly PriceTier[];
};

export type PriceLookup = (provider: string, model: string) => ModelPrices | undefined;

/** Providers whose calls can carry Fast; every other provider is never split. */
const FAST_PROVIDERS: ReadonlySet<string> = new Set(["openai", "openai-codex", "xai"]);

/** xAI serves Fast as a model variant; the base id is what the tables name. */
const XAI_FAST_VARIANTS: ReadonlyMap<string, string> = new Map([
  ["grok-4.7-build-fast", "grok-4.7"],
]);

/** A Fast price multiple at or above this is Fast; at or below LIST_RATIO it is the list rate. */
const FAST_RATIO = 1.9;
/** Long-context tiers cost up to 1.5x; anything up to this is standard pricing. */
const LIST_RATIO = 1.6;
/** xAI Fast price multiple (lib/fast-mode-state.ts XAI_FAST_PRICE_MULTIPLIER). */
const XAI_FAST_PRICE_MULTIPLIER = 2;

export function supportsFast(provider: string): boolean {
  return FAST_PROVIDERS.has(provider);
}

/** The model id the tables name: an xAI Fast variant maps back to its base model. */
export function baseModelId(model: string): string {
  return XAI_FAST_VARIANTS.get(model) ?? model;
}

/** The rates (dollars per million tokens) of the tier this call fell in, as pi-ai prices it. */
export function tierRates(prices: ModelPrices, record: CallRecord): PriceRates {
  const context = record.tokens.input + record.tokens.cacheRead + record.tokens.cacheWrite;
  let rates: PriceRates = prices;
  let matched = -1;
  for (const tier of prices.tiers ?? []) {
    if (context > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
      rates = tier;
      matched = tier.inputTokensAbove;
    }
  }
  return rates;
}

/** Output rate (dollars per million tokens) at the tier this call fell in. */
export function listOutputRate(prices: ModelPrices, record: CallRecord): number {
  return tierRates(prices, record).output;
}

/**
 * The price multiple an applied Fast call carries, as the integrations apply
 * it: Codex priority tier 2x (gpt-5.5: 2.5x), xAI Fast 2x. 1 elsewhere.
 */
export function fastPriceMultiplier(provider: string, model: string): number {
  if (provider === "openai" || provider === "openai-codex") return model === "gpt-5.5" ? 2.5 : 2;
  if (provider === "xai") return XAI_FAST_PRICE_MULTIPLIER;
  return 1;
}

/** Fast from the recorded price alone, or undefined when the call carries no price evidence. */
export function fastFromPrice(
  record: CallRecord,
  prices: ModelPrices | undefined,
): FastState | undefined {
  if (prices === undefined || record.tokens.output <= 0 || record.cost.output <= 0)
    return undefined;
  const list = listOutputRate(prices, record);
  if (!(list > 0)) return undefined;
  const ratio = ((record.cost.output / record.tokens.output) * 1_000_000) / list;
  if (ratio >= FAST_RATIO) return "on";
  if (ratio <= LIST_RATIO) return "off";
  return undefined;
}

/**
 * Fast state of one call; undefined for providers that never carry Fast.
 * `lookup` prices the base model (the Fast variant is unlisted).
 */
export function fastStateOf(
  record: CallRecord,
  lookup: PriceLookup | undefined,
): FastState | undefined {
  if (!supportsFast(record.provider)) return undefined;
  if (
    XAI_FAST_VARIANTS.has(record.model) ||
    (record.responseModel !== undefined && XAI_FAST_VARIANTS.has(record.responseModel))
  )
    return "on";
  const priced = fastFromPrice(record, lookup?.(record.provider, baseModelId(record.model)));
  if (priced !== undefined) return priced;
  if (record.fastRequested === false) return "off";
  return "unknown";
}
