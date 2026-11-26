import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { arr, bool, compile, obj, oneOf, str, unknown } from "@earendil-works/pi-schema";
import { isSyntheticApiModel, type SyntheticApiModel } from "../../src/client/types";
import { finiteNum } from "../../src/schema.ts";

type ProviderChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

export type SyntheticModel = Omit<ProviderChatModelConfig, "api" | "compat"> & {
  api?: "openai-completions";
  compat?: OpenAICompletionsCompat;
};

export const SYNTHETIC_MODELS: SyntheticModel[] = [
  {
    id: "infinite:small:vision",
    name: "infinite:small:vision",
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    compat: {
      supportsReasoningEffort: true,
    },
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 524288,
    maxTokens: 65536,
  },
  {
    id: "syn:large:text",
    name: "syn:large:text",
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    compat: {
      supportsReasoningEffort: true,
    },
    input: ["text", "image"],
    cost: {
      input: 0.6,
      output: 1.2,
      cacheRead: 0.03,
      cacheWrite: 0,
    },
    contextWindow: 524288,
    maxTokens: 65536,
  },
  {
    id: "syn:small:text",
    name: "syn:small:text",
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
    compat: {
      supportsReasoningEffort: true,
    },
    input: ["text"],
    cost: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.02,
      cacheWrite: 0,
    },
    contextWindow: 196608,
    maxTokens: 65536,
  },
  {
    id: "syn:large:vision",
    name: "syn:large:vision",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    compat: {
      supportsReasoningEffort: true,
    },
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 0,
    },
    contextWindow: 524288,
    maxTokens: 65536,
  },
  {
    id: "syn:small:vision",
    name: "syn:small:vision",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: null,
      xhigh: "xhigh",
      max: null,
    },
    compat: {
      supportsReasoningEffort: true,
    },
    input: ["text", "image"],
    cost: {
      input: 0.08,
      output: 0.4,
      cacheRead: 0.02,
      cacheWrite: 0,
    },
    contextWindow: 1024000,
    maxTokens: 65536,
  },
  {
    id: "hf:openai/gpt-oss-120b",
    name: "openai/gpt-oss-120b",
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
    compat: {
      supportsReasoningEffort: true,
    },
    input: ["text"],
    cost: {
      input: 0.1,
      output: 0.1,
      cacheRead: 0.02,
      cacheWrite: 0,
    },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: "hf:zai-org/GLM-5.3-Flash",
    name: "zai-org/GLM-5.3-Flash",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    compat: {
      supportsReasoningEffort: true,
    },
    input: ["text", "image"],
    cost: {
      input: 0.15,
      output: 0.5,
      cacheRead: 0.04,
      cacheWrite: 0,
    },
    contextWindow: 524288,
    maxTokens: 65536,
  },
  {
    id: "hf:zai-org/GLM-5.3",
    name: "zai-org/GLM-5.3",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    compat: {
      supportsReasoningEffort: true,
    },
    input: ["text"],
    cost: {
      input: 1.4,
      output: 4.4,
      cacheRead: 0.26,
      cacheWrite: 0,
    },
    contextWindow: 524288,
    maxTokens: 65536,
  },
  {
    id: "hf:zai-org/GLM-4.7-Flash",
    name: "zai-org/GLM-4.7-Flash",
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
    compat: {
      supportsReasoningEffort: true,
    },
    input: ["text"],
    cost: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.02,
      cacheWrite: 0,
    },
    contextWindow: 196608,
    maxTokens: 65536,
  },
  {
    id: "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
    name: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    compat: {
      supportsReasoningEffort: true,
    },
    input: ["text", "image"],
    cost: {
      input: 0.6,
      output: 1.2,
      cacheRead: 0.03,
      cacheWrite: 0,
    },
    contextWindow: 524288,
    maxTokens: 65536,
  },
  {
    id: "hf:moonshotai/Kimi-K3.1-Pro",
    name: "moonshotai/Kimi-K3.1-Pro",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    compat: {
      supportsReasoningEffort: true,
    },
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 0,
    },
    contextWindow: 524288,
    maxTokens: 65536,
  },
  {
    id: "hf:Qwen/Qwen3.8-27B",
    name: "Qwen/Qwen3.8-27B",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: null,
      xhigh: "xhigh",
      max: null,
    },
    compat: {
      supportsReasoningEffort: true,
    },
    input: ["text", "image"],
    cost: {
      input: 0.45,
      output: 2.2,
      cacheRead: 0.09,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 65536,
  },
  {
    id: "hf:thinkingmachines/Inkling-2-Mini",
    name: "thinkingmachines/Inkling-2-Mini",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: null,
      xhigh: "xhigh",
      max: null,
    },
    compat: {
      supportsReasoningEffort: true,
    },
    input: ["text", "image"],
    cost: {
      input: 0.08,
      output: 0.4,
      cacheRead: 0.02,
      cacheWrite: 0,
    },
    contextWindow: 1024000,
    maxTokens: 65536,
  },
];

const StoredSyntheticModelSchema = obj(
  {
    id: str({ minLength: 1 }),
    name: str(),
    reasoning: bool(),
    input: arr(oneOf(["text", "image"]), { minItems: 1 }),
    cost: obj(
      {
        input: finiteNum(),
        output: finiteNum(),
        cacheRead: finiteNum(),
        cacheWrite: finiteNum(),
      },
      { open: true },
    ),
    contextWindow: finiteNum(),
    maxTokens: finiteNum(),
  },
  { open: true },
);

const isStoredSyntheticModel = compile(StoredSyntheticModelSchema).check;

const ModelIdentifierSchema = obj({ id: unknown() }, { open: true });
const hasModelIdentifier = compile(ModelIdentifierSchema).check;

export function parseApiPrice(priceStr: string): number {
  const match = priceStr.match(/\$?(\d+\.?\d*)/);
  if (!match) return 0;
  const pricePerToken = Number.parseFloat(match[1]);
  return pricePerToken * 1_000_000;
}

function apiInputModalities(model: SyntheticApiModel): ("text" | "image")[] {
  const inputs = new Set<"text" | "image">();
  for (const modality of model.input_modalities) {
    if (modality === "text" || modality === "image") {
      inputs.add(modality);
    }
  }
  return inputs.size > 0 ? [...inputs] : ["text"];
}

function apiModelSupportsReasoning(model: SyntheticApiModel): boolean {
  return model.supported_features?.includes("reasoning") ?? false;
}

const isApiEffort = compile(str({ minLength: 1 })).check;

function buildThinkingLevelMapFromApiEfforts(
  efforts: readonly unknown[],
): NonNullable<SyntheticModel["thinkingLevelMap"]> {
  const available = new Set(efforts.filter((effort): effort is string => isApiEffort(effort)));
  return {
    off: available.has("none") ? "none" : null,
    minimal: available.has("minimal") ? "minimal" : null,
    low: available.has("low") ? "low" : null,
    medium: available.has("medium") ? "medium" : null,
    high: available.has("high") ? "high" : null,
    xhigh: available.has("xhigh") ? "xhigh" : null,
    max: available.has("max") ? "max" : null,
  };
}

function apiModelToSyntheticModel(model: SyntheticApiModel): SyntheticModel {
  const syntheticModel: SyntheticModel = {
    id: model.id,
    name: model.name,
    reasoning: apiModelSupportsReasoning(model),
    input: apiInputModalities(model),
    cost: {
      input: parseApiPrice(model.pricing.prompt),
      output: parseApiPrice(model.pricing.completion),
      cacheRead: parseApiPrice(model.pricing.input_cache_reads),
      cacheWrite: parseApiPrice(model.pricing.input_cache_writes),
    },
    contextWindow: model.context_length,
    maxTokens: model.max_output_length,
  };
  if (model.reasoning_parameters?.efforts) {
    syntheticModel.thinkingLevelMap = buildThinkingLevelMapFromApiEfforts(
      model.reasoning_parameters.efforts,
    );
  }
  return syntheticModel;
}

function applyDefaultCompat(model: SyntheticModel): SyntheticModel {
  const compat: NonNullable<SyntheticModel["compat"]> = {
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
    ...model.compat,
  };
  if (model.reasoning && model.compat?.supportsReasoningEffort === undefined) {
    compat.supportsReasoningEffort = true;
  }
  return { ...model, compat };
}

function finalizeModel(model: SyntheticModel): SyntheticModel {
  return applyDefaultCompat(model);
}

const THINKING_LEVEL_MAP_OVERRIDES = new Map<
  string,
  Partial<NonNullable<SyntheticModel["thinkingLevelMap"]>>
>([
  ["hf:zai-org/GLM-5.3-Flash", { low: null }],
  ["hf:zai-org/GLM-5.3", { low: null }],
]);

function mergeWithStaticOverride(
  apiModel: SyntheticModel,
  override: SyntheticModel | undefined,
): SyntheticModel {
  if (!override) return apiModel;

  const translatedThinkingLevelMap = apiModel.thinkingLevelMap ?? override.thinkingLevelMap;
  const thinkingLevelMapOverride = THINKING_LEVEL_MAP_OVERRIDES.get(apiModel.id);

  return {
    ...apiModel,
    thinkingLevelMap:
      translatedThinkingLevelMap && thinkingLevelMapOverride
        ? { ...translatedThinkingLevelMap, ...thinkingLevelMapOverride }
        : translatedThinkingLevelMap,
    compat: {
      ...apiModel.compat,
      ...override.compat,
    },
  };
}

export function buildSyntheticProviderModels(): SyntheticModel[] {
  return SYNTHETIC_MODELS.map(finalizeModel);
}

export function buildSyntheticProviderModelsFromApi(
  apiModels: readonly unknown[],
): SyntheticModel[] {
  const overrides = new Map(SYNTHETIC_MODELS.map((m) => [m.id, m]));

  return apiModels
    .map((model, index) => {
      if (!isSyntheticApiModel(model) || model.id.length === 0) {
        const id = hasModelIdentifier(model) ? String(model.id) : String(index);
        throw new Error(`Synthetic API returned invalid model entry "${id}"`);
      }
      return mergeWithStaticOverride(apiModelToSyntheticModel(model), overrides.get(model.id));
    })
    .map(finalizeModel);
}

export function buildSyntheticProviderModelsFromStore(
  storedModels: readonly unknown[],
): SyntheticModel[] {
  const overrides = new Map(SYNTHETIC_MODELS.map((m) => [m.id, m]));

  return storedModels
    .map((model, index) => {
      if (!isStoredSyntheticModel(model)) {
        const id = hasModelIdentifier(model) ? String(model.id) : String(index);
        throw new Error(`Synthetic model store contains invalid entry "${id}"`);
      }
      return mergeWithStaticOverride(model, overrides.get(model.id));
    })
    .map(finalizeModel);
}
