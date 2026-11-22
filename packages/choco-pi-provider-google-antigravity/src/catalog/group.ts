import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { arr, bool, compile, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { AntigravityError } from "../errors.ts";
import type { AntigravityModelDetails, FetchAvailableModelsResponse } from "./fetch.ts";

export const CATALOG_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type CatalogLevel = (typeof CATALOG_LEVELS)[number];
export const ANTIGRAVITY_FAMILIES = ["gemini", "claude", "gpt-oss"] as const;
export type AntigravityFamily = (typeof ANTIGRAVITY_FAMILIES)[number];

const CatalogVariantSchema = obj({
  level: opt(oneOf(CATALOG_LEVELS)),
  runtimeId: str({ minLength: 1 }),
  modelEnum: opt(str()),
  maxOutputTokens: num({ minimum: 1 }),
  /** ModelDetails.thinking_level: 1 LOW, 2 MEDIUM, 3 HIGH, 100 XHIGH. */
  wireThinkingLevel: opt(num()),
  thinkingBudget: opt(num()),
});

const CatalogModelSchema = obj({
  id: str({ minLength: 1 }),
  name: str({ minLength: 1 }),
  family: oneOf(ANTIGRAVITY_FAMILIES),
  reasoning: bool(),
  images: bool(),
  contextWindow: num({ minimum: 1 }),
  maxTokens: num({ minimum: 1 }),
  variants: arr(CatalogVariantSchema, { minItems: 1 }),
});

export const AntigravityCatalogSchema = obj({
  models: arr(CatalogModelSchema),
  webSearchModelIds: arr(str()),
  defaultModelId: opt(str()),
});
export const isAntigravityCatalog = compile(AntigravityCatalogSchema).check;

export type CatalogVariant = Static<typeof CatalogVariantSchema>;
export type CatalogModel = Static<typeof CatalogModelSchema>;
export type AntigravityCatalog = Static<typeof AntigravityCatalogSchema>;

const isCatalogLevel = compile(oneOf(CATALOG_LEVELS)).check;
const LEVEL_SUFFIX = /^(.+)-(minimal|low|medium|high|xhigh|max)$/u;
const DISPLAY_LEVEL = /\s*\((?:minimal|low|medium|high|xhigh|extra high|max)\)\s*$/iu;
const RUNTIME_ID = /^[a-z0-9][a-z0-9._-]*$/u;
const DEFAULT_CONTEXT_WINDOW = 131_072;
const DEFAULT_MAX_OUTPUT = 8192;

function normalizeSuffix(suffix: string | undefined): CatalogLevel | undefined {
  const value = suffix?.toLowerCase();
  if (value === "extra-high" || value === "extra_high") return "xhigh";
  return isCatalogLevel(value) ? value : undefined;
}

function levelFromWire(level: number | undefined): CatalogLevel | undefined {
  if (level === 1) return "low";
  if (level === 2) return "medium";
  if (level === 3) return "high";
  if (level === 100) return "xhigh";
  return undefined;
}

function levelToWire(level: CatalogLevel): number | undefined {
  if (level === "low") return 1;
  if (level === "medium") return 2;
  if (level === "high") return 3;
  if (level === "xhigh") return 100;
  return undefined;
}

function familyOf(id: string, details: AntigravityModelDetails): AntigravityFamily {
  const provider = `${details.modelProvider ?? ""} ${details.apiProvider ?? ""}`;
  if (/ANTHROPIC/u.test(provider) || id.startsWith("claude-")) return "claude";
  if (/OPENAI/u.test(provider) || id.startsWith("gpt-oss")) return "gpt-oss";
  return "gemini";
}

function selectableIds(response: FetchAvailableModelsResponse): Set<string> {
  const ids = new Set<string>();
  for (const sort of response.agentModelSorts ?? []) {
    for (const group of sort.groups ?? []) for (const id of group.modelIds ?? []) ids.add(id);
  }
  return ids;
}

function utilityIds(response: FetchAvailableModelsResponse): Set<string> {
  return new Set([
    ...(response.commandModelIds ?? []),
    ...(response.mqueryModelIds ?? []),
    ...(response.commitMessageModelIds ?? []),
    ...(response.webSearchModelIds ?? []),
    ...(response.imageGenerationModelIds ?? []),
    ...Object.values(response.tieredModelIds ?? {}).flat(),
  ]);
}

/** Whether a runtime id is an agent chat model a user may select. */
function isSelectable(
  id: string,
  details: AntigravityModelDetails,
  selectable: Set<string>,
  utility: Set<string>,
  images: Set<string>,
): boolean {
  if (!RUNTIME_ID.test(id) || /^(?:tab|chat)_/u.test(id) || id.startsWith("MODEL_")) return false;
  if (/image/iu.test(id) || /image/iu.test(details.displayName ?? "") || images.has(id))
    return false;
  if (details.isInternal || details.disabled) return false;
  if (details.apiProvider === "API_PROVIDER_INTERNAL") return false;
  if (selectable.size > 0) return selectable.has(id);
  return details.displayName !== undefined && !utility.has(id);
}

interface Placement {
  base: string;
  level: CatalogLevel | undefined;
}

function placementOf(
  id: string,
  details: AntigravityModelDetails,
  response: FetchAvailableModelsResponse,
): Placement {
  for (const [base, group] of Object.entries(response.groupedModels ?? {})) {
    for (const entry of group.supportedThinkingLevels ?? []) {
      if (entry.thinkingSuffix && id === `${base}-${entry.thinkingSuffix}`) {
        const level = normalizeSuffix(entry.thinkingSuffix);
        if (level) return { base, level };
      }
    }
  }
  const match = LEVEL_SUFFIX.exec(id);
  const suffixLevel = normalizeSuffix(match?.[2]);
  if (match?.[1] && suffixLevel) return { base: match[1], level: suffixLevel };
  if (!details.supportsThinking) return { base: id, level: undefined };
  return { base: id, level: levelFromWire(details.thinkingLevel) ?? "high" };
}

interface Draft {
  id: string;
  name: string | undefined;
  family: AntigravityFamily;
  reasoning: boolean;
  images: boolean;
  contextWindows: number[];
  variants: CatalogVariant[];
}

function variantOf(
  runtimeId: string,
  level: CatalogLevel | undefined,
  details: AntigravityModelDetails,
): CatalogVariant {
  const variant: CatalogVariant = {
    runtimeId,
    maxOutputTokens:
      details.maxOutputTokens && details.maxOutputTokens > 0
        ? details.maxOutputTokens
        : DEFAULT_MAX_OUTPUT,
  };
  if (level) variant.level = level;
  if (details.model) variant.modelEnum = details.model;
  if (details.thinkingLevel !== undefined) variant.wireThinkingLevel = details.thinkingLevel;
  if (details.thinkingBudget !== undefined) variant.thinkingBudget = details.thinkingBudget;
  return variant;
}

/**
 * Builds the catalog from fetchAvailableModels: filters internal, disabled, tab and image ids,
 * collapses effort-suffixed runtime ids into one model per base id (groupedModels first, suffix
 * parsing otherwise) and keeps per-variant runtime metadata.
 */
export function buildAntigravityCatalog(
  response: FetchAvailableModelsResponse,
): AntigravityCatalog {
  const selectable = selectableIds(response);
  const utility = utilityIds(response);
  const images = new Set(response.imageGenerationModelIds ?? []);
  const order = selectable.size > 0 ? [...selectable] : Object.keys(response.models);
  const drafts = new Map<string, Draft>();
  for (const id of order) {
    const details = response.models[id];
    if (!details || !isSelectable(id, details, selectable, utility, images)) continue;
    const { base, level } = placementOf(id, details, response);
    let draft = drafts.get(base);
    if (!draft) {
      draft = {
        id: base,
        name: response.groupedModels?.[base]?.displayName,
        family: familyOf(id, details),
        reasoning: false,
        images: false,
        contextWindows: [],
        variants: [],
      };
      drafts.set(base, draft);
    }
    if (draft.variants.some((variant) => variant.level === level)) continue;
    draft.name ??= details.displayName?.replace(DISPLAY_LEVEL, "").trim() || undefined;
    draft.reasoning ||= details.supportsThinking === true;
    draft.images ||= details.supportsImages === true;
    if (details.maxTokens && details.maxTokens > 0) draft.contextWindows.push(details.maxTokens);
    draft.variants.push(variantOf(id, level, details));
  }
  const models: CatalogModel[] = [];
  for (const draft of drafts.values()) {
    draft.variants.sort((a, b) => levelIndex(a.level) - levelIndex(b.level));
    models.push({
      id: draft.id,
      name: draft.name ?? draft.id,
      family: draft.family,
      reasoning: draft.reasoning,
      images: draft.images,
      contextWindow:
        draft.contextWindows.length > 0
          ? Math.min(...draft.contextWindows)
          : DEFAULT_CONTEXT_WINDOW,
      maxTokens: Math.min(...draft.variants.map((variant) => variant.maxOutputTokens)),
      variants: draft.variants,
    });
  }
  const catalog: AntigravityCatalog = {
    models,
    webSearchModelIds: [...(response.webSearchModelIds ?? [])],
  };
  if (response.defaultAgentModelId) catalog.defaultModelId = response.defaultAgentModelId;
  return catalog;
}

function levelIndex(level: CatalogLevel | undefined): number {
  return level === undefined ? -1 : CATALOG_LEVELS.indexOf(level);
}

type PiThinkingLevelMap = NonNullable<
  Extract<ProviderModelConfig, { reasoning: boolean }>["thinkingLevelMap"]
>;

function thinkingLevelMap(model: CatalogModel): PiThinkingLevelMap {
  const advertised = new Set(model.variants.map((variant) => variant.level));
  const level = (name: CatalogLevel) => (advertised.has(name) ? name : null);
  return {
    off: null,
    minimal: level("minimal"),
    low: level("low"),
    medium: level("medium"),
    high: level("high"),
    xhigh: level("xhigh"),
    max: level("max"),
  };
}

/** Pi model configs: one per base id, api google-generative-ai, zero cost (subscription). */
export function catalogToProviderModels(catalog: AntigravityCatalog): ProviderModelConfig[] {
  return catalog.models.map((model) => {
    const config: ProviderModelConfig = {
      id: model.id,
      name: model.name,
      api: "google-generative-ai",
      reasoning: model.reasoning,
      input: model.images ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    };
    if (model.reasoning) config.thinkingLevelMap = thinkingLevelMap(model);
    return config;
  });
}

function fallbackModel(
  id: string,
  name: string,
  family: AntigravityFamily,
  contextWindow: number,
  maxOutputTokens: number,
  levels: readonly CatalogLevel[],
): CatalogModel {
  return {
    id,
    name,
    family,
    reasoning: true,
    images: true,
    contextWindow,
    maxTokens: maxOutputTokens,
    variants: levels.map((level) => {
      const variant: CatalogVariant = { level, runtimeId: `${id}-${level}`, maxOutputTokens };
      const wireLevel = levelToWire(level);
      if (wireLevel !== undefined) variant.wireThinkingLevel = wireLevel;
      return variant;
    }),
  };
}

/**
 * The only hardcoded catalog: used until the first successful refresh (offline start, no
 * credential). Taken from the 2026-11 agy 1.5.14 capture; model enums are omitted on purpose.
 */
export const FALLBACK_CATALOG: AntigravityCatalog = {
  models: [
    fallbackModel("gemini-4-neon", "Gemini 4 Neon", "gemini", 1_048_576, 262_144, [
      "low",
      "medium",
      "high",
      "xhigh",
    ]),
    fallbackModel("gemini-3.8-flash", "Gemini 3.8 Flash", "gemini", 1_048_576, 65_536, [
      "low",
      "medium",
      "high",
    ]),
    fallbackModel("claude-opus-5-5", "Claude Opus 5.5", "claude", 1_000_000, 128_000, [
      "low",
      "medium",
      "high",
    ]),
    fallbackModel("claude-sonnet-5-5", "Claude Sonnet 5.5", "claude", 1_000_000, 128_000, [
      "low",
      "medium",
      "high",
    ]),
  ],
  webSearchModelIds: [],
};

// Pi loads extensions with separate module caches, but they share this global slot.
const ACTIVE_CATALOG_KEY = Symbol.for("choco-pi.provider-google-antigravity.catalog");
const catalogRegistry: object = globalThis;

/** Replaces the catalog resolveRuntimeModel reads. Called by refreshModels on publication. */
export function setActiveCatalog(catalog: AntigravityCatalog | undefined): void {
  if (catalog === undefined) {
    Reflect.deleteProperty(catalogRegistry, ACTIVE_CATALOG_KEY);
  } else {
    Object.defineProperty(catalogRegistry, ACTIVE_CATALOG_KEY, {
      configurable: true,
      value: catalog,
    });
  }
}

/** The refreshed catalog, or the offline fallback before the first refresh. */
export function getActiveCatalog(): AntigravityCatalog {
  const catalog =
    ACTIVE_CATALOG_KEY in catalogRegistry ? catalogRegistry[ACTIVE_CATALOG_KEY] : undefined;
  return isAntigravityCatalog(catalog) ? catalog : FALLBACK_CATALOG;
}

export type AntigravityThinkingConfig = {
  includeThoughts: boolean;
  thinkingLevel?: "LOW" | "MEDIUM" | "HIGH";
  thinkingBudget?: number;
};

export interface RuntimeModelResolution {
  runtimeId: string;
  thinkingConfig: AntigravityThinkingConfig | undefined;
  maxOutputTokens: number;
  modelEnum: string | undefined;
  family: AntigravityFamily;
  /** The advertised level actually used, after clamping. */
  level: CatalogLevel | undefined;
}

export type RequestedThinkingLevel = CatalogLevel | "off";

function chooseVariant(
  model: CatalogModel,
  requested: RequestedThinkingLevel | undefined,
): CatalogVariant | undefined {
  const variants = model.variants;
  if (requested === undefined || requested === "off") return variants[0];
  const exact = variants.find((variant) => variant.level === requested);
  if (exact) return exact;
  const wanted = CATALOG_LEVELS.indexOf(requested);
  const higher = variants.find((variant) => levelIndex(variant.level) > wanted);
  return higher ?? variants[variants.length - 1];
}

function thinkingConfigFor(
  model: CatalogModel,
  variant: CatalogVariant,
  includeThoughts: boolean,
): AntigravityThinkingConfig | undefined {
  if (!model.reasoning) return undefined;
  const config: AntigravityThinkingConfig = { includeThoughts };
  if (variant.wireThinkingLevel === 1) config.thinkingLevel = "LOW";
  else if (variant.wireThinkingLevel === 2) config.thinkingLevel = "MEDIUM";
  else if (variant.wireThinkingLevel === 3) config.thinkingLevel = "HIGH";
  else if (variant.thinkingBudget !== undefined && variant.thinkingBudget > 0) {
    config.thinkingBudget = variant.thinkingBudget;
  }
  return config;
}

/** Resolves a base model and level against a specific catalog. */
export function resolveRuntimeModelIn(
  catalog: AntigravityCatalog,
  modelId: string,
  level: RequestedThinkingLevel | undefined,
): RuntimeModelResolution {
  const model = catalog.models.find((candidate) => candidate.id === modelId);
  const variant = model ? chooseVariant(model, level) : undefined;
  if (!model || !variant) {
    throw new AntigravityError({
      kind: "model_unavailable",
      detail: `${modelId} is not in the Antigravity catalog; refresh models or pick another model`,
    });
  }
  return {
    runtimeId: variant.runtimeId,
    thinkingConfig: thinkingConfigFor(model, variant, level !== undefined && level !== "off"),
    maxOutputTokens: variant.maxOutputTokens,
    modelEnum: variant.modelEnum,
    family: model.family,
    level: variant.level,
  };
}

/**
 * Maps a Pi base model id and thinking level to the runtime id agy would send, its
 * thinkingConfig, output cap, model enum and family, from the persisted catalog metadata.
 */
export function resolveRuntimeModel(
  modelId: string,
  level: RequestedThinkingLevel | undefined,
): RuntimeModelResolution {
  const catalog = getActiveCatalog();
  if (catalog !== FALLBACK_CATALOG && !catalog.models.some((model) => model.id === modelId)) {
    return resolveRuntimeModelIn(FALLBACK_CATALOG, modelId, level);
  }
  return resolveRuntimeModelIn(catalog, modelId, level);
}
