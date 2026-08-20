// Hardcoded model fallback, synced from https://api.synthetic.new/openai/v1/models
// maxTokens sourced from https://models.dev/api.json (synthetic provider).
//
// This list is used as the offline fallback and as the override catalog for
// model-specific compatibility settings (thinkingLevelMap, compat). The live
// API exposes per-model effort values via reasoning_parameters.efforts, which
// the API/store model builders translate into thinkingLevelMap entries; the
// static maps below only apply when that field is absent (offline fallback).
// cacheRead stores the price reported by the API's input_cache_reads field
// directly.

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { SyntheticApiModel } from "../../src/client/types";

export type SyntheticModel = ProviderModelConfig;

export const SYNTHETIC_MODELS: SyntheticModel[] = [
  // API: syn:large:text → ctx=524288, out=65536
  // Reasoning: GLM-5.2 accepts `max` (default, highest), `high` (lower), and
  // `none` (disables reasoning) as effort values; "low", "medium", "minimal", and
  // "xhigh" are rejected upstream. Map the three accepted values; hide the rest.
  // Live API/store models get this map from reasoning_parameters.efforts.
  {
    id: "syn:large:text",
    name: "syn:large:text",
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
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
      input: 1,
      output: 3,
      cacheRead: 0.16,
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
  // API efforts: ['none', 'low', 'medium', 'high'] ('minimal'/'xhigh'/'max' rejected upstream).
  {
    id: "syn:small:vision",
    name: "syn:small:vision",
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
  // API: hf:zai-org/GLM-5.2 → ctx=524288, out=65536
  {
    id: "hf:zai-org/GLM-5.2",
    name: "zai-org/GLM-5.2",
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
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
      input: 1,
      output: 3,
      cacheRead: 0.16,
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
  // API: hf:Qwen/Qwen3.6-27B → ctx=262144, out=65536
  // API efforts: ['none', 'low', 'medium', 'high'] ('minimal'/'xhigh'/'max' rejected upstream).
  {
    id: "hf:Qwen/Qwen3.6-27B",
    name: "Qwen/Qwen3.6-27B",
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

export function isValidApiModel(model: unknown): model is SyntheticApiModel {
  if (!model || typeof model !== "object") return false;
  const m = model as Partial<SyntheticApiModel>;
  return (
    typeof m.id === "string" &&
    m.id.length > 0 &&
    typeof m.name === "string" &&
    Array.isArray(m.input_modalities) &&
    m.input_modalities.every((x) => typeof x === "string") &&
    Array.isArray(m.output_modalities) &&
    m.output_modalities.every((x) => typeof x === "string") &&
    typeof m.context_length === "number" &&
    Number.isFinite(m.context_length) &&
    typeof m.max_output_length === "number" &&
    Number.isFinite(m.max_output_length) &&
    m.pricing !== null &&
    typeof m.pricing === "object" &&
    typeof m.pricing.prompt === "string" &&
    typeof m.pricing.completion === "string" &&
    typeof m.pricing.input_cache_reads === "string" &&
    typeof m.pricing.input_cache_writes === "string"
  );
}

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

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function isValidApiEffort(effort: unknown): effort is string {
  return typeof effort === "string" && effort.length > 0;
}

// Translate the API's reasoning_parameters.efforts into a thinkingLevelMap.
// "none" maps to pi's "off" level. Levels the API does not list are marked null
// (hidden) — model backends accept exactly the values they declare, so an
// unlisted level must be hidden rather than sent upstream. Every level key is
// written explicitly because pi gates "xhigh"/"max" on key presence, not value.
function buildThinkingLevelMapFromApiEfforts(
  efforts: readonly unknown[],
): Partial<Record<ThinkingLevel, string | null>> {
  const available = new Set(efforts.filter(isValidApiEffort));
  const map: Partial<Record<ThinkingLevel, string | null>> = {};

  for (const level of THINKING_LEVELS) {
    if (level === "off") {
      // No "none" entry means the upstream rejects it (e.g. Kimi-K3 always
      // reasons), so hide "off" rather than trying to disable reasoning.
      map.off = available.has("none") ? "none" : null;
      continue;
    }
    map[level] = available.has(level) ? level : null;
  }

  return map;
}

function apiModelToSyntheticModel(model: SyntheticApiModel): SyntheticModel {
  return {
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
    ...(model.reasoning_parameters?.efforts
      ? {
          thinkingLevelMap: buildThinkingLevelMapFromApiEfforts(
            model.reasoning_parameters.efforts,
          ),
        }
      : {}),
  };
}

function isValidSyntheticModel(model: unknown): model is SyntheticModel {
  if (!model || typeof model !== "object") return false;
  const m = model as Partial<SyntheticModel>;
  return (
    typeof m.id === "string" &&
    m.id.length > 0 &&
    typeof m.name === "string" &&
    typeof m.reasoning === "boolean" &&
    Array.isArray(m.input) &&
    m.input.every((x) => x === "text" || x === "image") &&
    m.input.length > 0 &&
    m.cost !== null &&
    typeof m.cost === "object" &&
    typeof m.cost.input === "number" &&
    Number.isFinite(m.cost.input) &&
    typeof m.cost.output === "number" &&
    Number.isFinite(m.cost.output) &&
    typeof m.contextWindow === "number" &&
    Number.isFinite(m.contextWindow) &&
    typeof m.maxTokens === "number" &&
    Number.isFinite(m.maxTokens)
  );
}

function applyDefaultCompat(model: SyntheticModel): SyntheticModel {
  return {
    ...model,
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens" as const,
      ...(model.reasoning ? { supportsReasoningEffort: true } : {}),
      ...model.compat,
    },
  };
}

function finalizeModel(model: SyntheticModel): SyntheticModel {
  return applyDefaultCompat(model);
}

function mergeWithStaticOverride(
  apiModel: SyntheticModel,
  override: SyntheticModel | undefined,
): SyntheticModel {
  if (!override) return apiModel;

  return {
    ...apiModel,
    // API-sourced efforts win; the static map is a fallback for models whose
    // API entries do not declare reasoning_parameters (offline catalogs).
    thinkingLevelMap: apiModel.thinkingLevelMap ?? override.thinkingLevelMap,
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
      if (!isValidApiModel(model)) {
        const id =
          model && typeof model === "object" && "id" in model
            ? String((model as { id: unknown }).id)
            : String(index);
        throw new Error(`Synthetic API returned invalid model entry "${id}"`);
      }
      return mergeWithStaticOverride(
        apiModelToSyntheticModel(model),
        overrides.get(model.id),
      );
    })
    .map(finalizeModel);
}

export function buildSyntheticProviderModelsFromStore(
  storedModels: readonly unknown[],
): SyntheticModel[] {
  const overrides = new Map(SYNTHETIC_MODELS.map((m) => [m.id, m]));

  return storedModels
    .map((model, index) => {
      if (!isValidSyntheticModel(model)) {
        const id =
          model && typeof model === "object" && "id" in model
            ? String((model as { id: unknown }).id)
            : String(index);
        throw new Error(`Synthetic model store contains invalid entry "${id}"`);
      }
      return mergeWithStaticOverride(model, overrides.get(model.id));
    })
    .map(finalizeModel);
}
