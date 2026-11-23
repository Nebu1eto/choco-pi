import type { CallRecord } from "./records.ts";

export type FastState = "on" | "off" | "unknown";

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

const FAST_PROVIDERS: ReadonlySet<string> = new Set(["openai", "openai-codex", "xai"]);

const XAI_FAST_VARIANTS: ReadonlyMap<string, string> = new Map([
  ["grok-4.7-build-fast", "grok-4.7"],
]);

const FAST_RATIO = 1.9;
const LIST_RATIO = 1.6;
const XAI_FAST_PRICE_MULTIPLIER = 2;

export function supportsFast(provider: string): boolean {
  return FAST_PROVIDERS.has(provider);
}

export function baseModelId(model: string): string {
  return XAI_FAST_VARIANTS.get(model) ?? model;
}

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

export function listOutputRate(prices: ModelPrices, record: CallRecord): number {
  return tierRates(prices, record).output;
}

export function fastPriceMultiplier(provider: string, model: string): number {
  if (provider === "openai" || provider === "openai-codex") return model === "gpt-5.5" ? 2.5 : 2;
  if (provider === "xai") return XAI_FAST_PRICE_MULTIPLIER;
  return 1;
}

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
