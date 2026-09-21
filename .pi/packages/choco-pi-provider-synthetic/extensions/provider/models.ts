// Hardcoded model fallback, synced from https://api.synthetic.new/openai/v1/models
// maxTokens sourced from https://models.dev/api.json (synthetic provider).
//
// This list is used as the offline fallback and as the override catalog for
// model-specific compatibility settings (thinkingLevelMap, compat). The live
// API exposes per-model effort values via reasoning_parameters.efforts, which
// the API/store model builders translate into thinkingLevelMap entries; the
// static maps below apply when that field is absent (offline fallback), except
// for explicit compatibility overrides applied after API/store translation.
// cacheRead stores the price reported by the API's input_cache_reads field
// directly.

import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { SyntheticApiModelSchema, type SyntheticApiModel } from "../../src/client/types";

export type SyntheticModel = Omit<ProviderModelConfig, "api" | "compat"> & {
  api?: "openai-completions";
  compat?: OpenAICompletionsCompat;
};

export const SYNTHETIC_MODELS: SyntheticModel[] = [
  // API: syn:large:text → ctx=524288, out=65536
  // API efforts: ['none', 'low', 'high', 'xhigh', 'max'] ('minimal'/'medium' rejected upstream).
  // Live API/store models get this map from reasoning_parameters.efforts.
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
  // API: syn:small:text → ctx=196608, out=65536
  // API efforts: ['none', 'low', 'medium', 'high'] ('minimal'/'xhigh'/'max' rejected upstream).
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
  // API: syn:large:vision → ctx=524288, out=65536
  // Routes to Kimi-K3. API efforts: ['low', 'high', 'max'] — reasoning is
  // always on (upstream rejects 'none'), so off is hidden. Live API/store
  // models get this map from reasoning_parameters.efforts instead.
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
      input: 3,
      output: 15,
      cacheRead: 0.45,
      cacheWrite: 0,
    },
    contextWindow: 524288,
    maxTokens: 65536,
  },
  // API: syn:small:vision → ctx=262144, out=65536
  // API efforts: ['low', 'medium', 'xhigh'] — reasoning is always on, so off is hidden.
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
      input: 0.45,
      output: 2.2,
      cacheRead: 0.09,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 65536,
  },
  // API: hf:openai/gpt-oss-120b → ctx=131072, out=65536
  // API efforts: ['none', 'low', 'medium', 'high'] ('minimal'/'xhigh'/'max'
  // rejected upstream). The model reasons at every accepted effort including
  // 'none', so off still reasons — it only lowers effort.
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
  // API: hf:zai-org/GLM-5.3-Flash → ctx=524288, out=65536
  // API efforts: ['low', 'high', 'max'] — reasoning is always on; off and the
  // unreliable low effort are intentionally hidden.
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
  // API: hf:zai-org/GLM-4.7-Flash → ctx=196608, out=65536
  // API efforts: ['none', 'low', 'medium', 'high'] ('minimal'/'xhigh'/'max' rejected upstream).
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
  // API: hf:deepseek-ai/DeepSeek-V4.1-Flash → ctx=524288, out=65536
  // API efforts: ['none', 'low', 'high', 'xhigh', 'max'] ('minimal'/'medium' rejected upstream).
  {
    id: "hf:deepseek-ai/DeepSeek-V4.1-Flash",
    name: "deepseek-ai/DeepSeek-V4.1-Flash",
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
  // API: hf:moonshotai/Kimi-K3 → ctx=524288, out=65536
  // API efforts: ['low', 'high', 'max'] — reasoning is always on (upstream
  // rejects 'none'), so off is hidden. Live API/store models get this map
  // from reasoning_parameters.efforts instead.
  {
    id: "hf:moonshotai/Kimi-K3",
    name: "moonshotai/Kimi-K3",
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
      input: 3,
      output: 15,
      cacheRead: 0.45,
      cacheWrite: 0,
    },
    contextWindow: 524288,
    maxTokens: 65536,
  },
  // API: hf:Qwen/Qwen3.8-27B → ctx=262144, out=65536
  // API efforts: ['low', 'medium', 'xhigh'] — reasoning is always on, so off is hidden.
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
  // API: hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4 → ctx=262144, out=65536
  // API efforts: ['none', 'low', 'medium', 'high'] ('minimal'/'xhigh'/'max' rejected upstream).
  {
    id: "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
    name: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
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
      input: 0.3,
      output: 1,
      cacheRead: 0.06,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 65536,
  },
];

const StoredSyntheticModelSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String(),
  reasoning: Type.Boolean(),
  input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
    minItems: 1,
  }),
  cost: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
  }),
  contextWindow: Type.Number(),
  maxTokens: Type.Number(),
});

const ModelIdentifierSchema = Type.Object({ id: Type.Unknown() });

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

// Translate the API's reasoning_parameters.efforts into a thinkingLevelMap.
// "none" maps to pi's "off" level. Levels the API does not list are marked null
// (hidden) — model backends accept exactly the values they declare, so an
// unlisted level must be hidden rather than sent upstream. Every level key is
// written explicitly because pi gates "xhigh"/"max" on key presence, not value.
const ApiEffortSchema = Type.String({ minLength: 1 });

function buildThinkingLevelMapFromApiEfforts(
  efforts: readonly unknown[],
): NonNullable<SyntheticModel["thinkingLevelMap"]> {
  const available = new Set(
    efforts.filter((effort): effort is string => Value.Check(ApiEffortSchema, effort)),
  );
  return {
    // No "none" entry means the upstream rejects it (e.g. Kimi-K3 always
    // reasons), so hide "off" rather than trying to disable reasoning.
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
  // Direct API probes on 2026-09-21 showed low can exhaust output on reasoning
  // or stop with empty content, despite being advertised by the live catalog.
  ["hf:zai-org/GLM-5.3-Flash", { low: null }],
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
    // API-sourced efforts normally win. Explicit compatibility overrides are
    // applied last so live refreshes and cached catalogs cannot restore them.
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
      if (!Value.Check(SyntheticApiModelSchema, model) || model.id.length === 0) {
        const id = Value.Check(ModelIdentifierSchema, model) ? String(model.id) : String(index);
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
      if (!Value.Check(StoredSyntheticModelSchema, model)) {
        const id = Value.Check(ModelIdentifierSchema, model) ? String(model.id) : String(index);
        throw new Error(`Synthetic model store contains invalid entry "${id}"`);
      }
      return mergeWithStaticOverride(model, overrides.get(model.id));
    })
    .map(finalizeModel);
}
