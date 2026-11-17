import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_CODEX_BASE_URL } from "./constants.ts";

const UNKNOWN_SUBSCRIPTION_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

// GPT-6.2 entries mirror the host's GPT-6 Codex entries until the host catalog ships them.
// Context windows come from the Codex `/backend-api/codex/models` catalog; prices from
// https://developers.openai.com/api/docs/models/gpt-6.2-astra and .../gpt-6.2-sol (2026-11-18).
function gpt62CodexModel(
  id: string,
  name: string,
  contextWindow: number,
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number },
): Model<"openai-codex-responses"> {
  return {
    id,
    name,
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: DEFAULT_CODEX_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    // Above 272K input tokens, input and cache rates double and output costs 1.5x.
    cost: {
      ...cost,
      tiers: [
        {
          inputTokensAbove: 272_000,
          input: cost.input * 2,
          output: cost.output * 1.5,
          cacheRead: cost.cacheRead * 2,
          cacheWrite: cost.cacheWrite * 2,
        },
      ],
    },
    contextWindow,
    maxTokens: 128_000,
    // The API rejects effort `none`; OpenAI's migration guide maps `minimal` to `low`.
    thinkingLevelMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    compat: {
      supportsOpenAIGrammarTools: true,
      supportsAdditionalTools: true,
      supportsToolSearch: true,
      supportsMidConvoSystemMessages: true,
    },
    inputLimits: {
      images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } },
    },
  };
}

const ADDITIONAL_MODELS: Model<"openai-codex-responses">[] = [
  gpt62CodexModel("gpt-6.2-astra", "GPT-6.2 Astra", 272_000, {
    input: 8,
    output: 40,
    cacheRead: 0.4,
    cacheWrite: 10,
  }),
  gpt62CodexModel("gpt-6.2-sol", "GPT-6.2 Sol", 500_000, {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
  }),
  {
    id: "gpt-daybreak-blue-latest",
    name: "Daybreak Blue",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: DEFAULT_CODEX_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: UNKNOWN_SUBSCRIPTION_COST,
    contextWindow: 272_000,
    maxTokens: 128_000,
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    compat: {
      supportsOpenAIGrammarTools: true,
      supportsAdditionalTools: true,
      supportsToolSearch: true,
      supportsMidConvoSystemMessages: true,
    },
  },
  {
    id: "gpt-daybreak-red-latest",
    name: "Daybreak Red",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: DEFAULT_CODEX_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: UNKNOWN_SUBSCRIPTION_COST,
    contextWindow: 372_000,
    maxTokens: 128_000,
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    compat: {
      supportsOpenAIGrammarTools: true,
      supportsAdditionalTools: true,
      supportsToolSearch: true,
      supportsMidConvoSystemMessages: true,
    },
  },
];

export function openAICodexModelsWithDaybreak(): Model<Api>[] {
  const models: Model<Api>[] = getBuiltinModels("openai-codex");
  const existing = new Set(models.map(({ id }) => id));
  return [...models, ...ADDITIONAL_MODELS.filter(({ id }) => !existing.has(id))];
}
