import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

type ApexApi = "openai-completions" | "openai-responses";
type ModelInput = Array<"text" | "image">;

export type ApexModelDefaults = {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ModelInput;
};

export type ApexModelOverride = Partial<ApexModelDefaults> & { name?: string };

type ApexProviderConfig = {
  baseUrl?: string;
  api?: ApexApi;
  defaults?: Partial<ApexModelDefaults>;
  overrides?: Record<string, ApexModelOverride>;
};

const PROVIDER_ID = "callstack-apex";
const PROFILE_CONFIG_PATH = fileURLToPath(new URL("./apex-provider.json", import.meta.url));
const DISCOVERY_TIMEOUT_MS = 10_000;
const MODEL_STORE_TTL_MS = 4 * 60 * 60 * 1000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const FALLBACK_DEFAULTS: ApexModelDefaults = {
  contextWindow: 128000,
  maxTokens: 16384,
  reasoning: false,
  input: ["text"],
};

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function firstPositiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const integer = positiveInteger(value);
    if (integer !== undefined) return integer;
  }
  return undefined;
}

function normalizeInput(value: unknown, fallback: ModelInput): ModelInput {
  if (!Array.isArray(value)) return [...fallback];
  const input = [
    ...new Set(
      value.filter((item): item is "text" | "image" => item === "text" || item === "image"),
    ),
  ];
  return input.length > 0 ? input : [...fallback];
}

function modelEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const object = payload as Record<string, unknown>;
  if (Array.isArray(object.data)) return object.data;
  return Array.isArray(object.models) ? object.models : [];
}

function featureEnabled(model: Record<string, unknown>, feature: string): boolean | undefined {
  if (!Array.isArray(model.supported_features)) return undefined;
  return model.supported_features.includes(feature);
}

export function normalizeApexModels(
  payload: unknown,
  defaults: ApexModelDefaults,
  overrides: Record<string, ApexModelOverride>,
): ProviderModelConfig[] {
  const seen = new Set<string>();
  const models: ProviderModelConfig[] = [];

  for (const entry of modelEntries(payload)) {
    if (!entry || typeof entry !== "object") continue;
    const model = entry as Record<string, unknown>;
    if (typeof model.id !== "string") continue;
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const overrideValue = overrides[id];
    const override =
      overrideValue && typeof overrideValue === "object" && !Array.isArray(overrideValue)
        ? overrideValue
        : {};
    const inputSource = model.input ?? model.input_modalities;
    const apiInput = normalizeInput(inputSource, defaults.input);
    const apiReasoning =
      typeof model.reasoning === "boolean"
        ? model.reasoning
        : typeof model.supports_reasoning === "boolean"
          ? model.supports_reasoning
          : featureEnabled(model, "reasoning");
    const apiName = typeof model.name === "string" && model.name.trim() ? model.name.trim() : id;
    const overrideName =
      typeof override.name === "string" && override.name.trim() ? override.name.trim() : undefined;

    models.push({
      id,
      name: overrideName ?? apiName,
      reasoning:
        typeof override.reasoning === "boolean"
          ? override.reasoning
          : (apiReasoning ?? defaults.reasoning),
      input: Array.isArray(override.input) ? normalizeInput(override.input, apiInput) : apiInput,
      cost: ZERO_COST,
      contextWindow:
        positiveInteger(override.contextWindow) ??
        firstPositiveInteger(model.contextWindow, model.context_window, model.context_length) ??
        defaults.contextWindow,
      maxTokens:
        positiveInteger(override.maxTokens) ??
        firstPositiveInteger(model.maxTokens, model.max_tokens, model.max_output_length) ??
        defaults.maxTokens,
    });
  }

  return models;
}

async function readConfig(cwd: string): Promise<ApexProviderConfig> {
  const configPaths = [
    join(cwd, ".pi", "extensions", "apex-provider.json"),
    join(getAgentDir(), "extensions", "apex-provider.json"),
    PROFILE_CONFIG_PATH,
  ];
  for (const configPath of configPaths) {
    try {
      return JSON.parse(await readFile(configPath, "utf8")) as ApexProviderConfig;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("apex-provider.json was not found");
}

function resolveDefaults(config: ApexProviderConfig): ApexModelDefaults {
  return {
    contextWindow:
      positiveInteger(config.defaults?.contextWindow) ?? FALLBACK_DEFAULTS.contextWindow,
    maxTokens: positiveInteger(config.defaults?.maxTokens) ?? FALLBACK_DEFAULTS.maxTokens,
    reasoning:
      typeof config.defaults?.reasoning === "boolean"
        ? config.defaults.reasoning
        : FALLBACK_DEFAULTS.reasoning,
    input: normalizeInput(config.defaults?.input, FALLBACK_DEFAULTS.input),
  };
}

function resolveBaseUrl(config: ApexProviderConfig): string | undefined {
  const value = process.env.CALLSTACK_APEX_BASE_URL?.trim() || config.baseUrl?.trim();
  if (!value) return undefined;
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Apex baseUrl must be an HTTP(S) URL without credentials, query, or fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function resolveApi(config: ApexProviderConfig): ApexApi {
  if (config.api === undefined || config.api === "openai-completions") return "openai-completions";
  if (config.api === "openai-responses") return "openai-responses";
  throw new Error(`Unsupported Apex API type: ${String(config.api)}`);
}

async function discoverApexModels(
  baseUrl: string,
  apiKey: string,
  defaults: ApexModelDefaults,
  overrides: Record<string, ApexModelOverride>,
  signal: AbortSignal,
): Promise<ProviderModelConfig[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!response.ok) throw new Error(`Apex model discovery failed: HTTP ${response.status}`);

  const models = normalizeApexModels(await response.json(), defaults, overrides);
  if (models.length === 0) throw new Error("Apex model discovery returned no valid models");
  return models;
}

export default async function apexProvider(pi: ExtensionAPI): Promise<void> {
  const config = await readConfig(process.cwd());
  const baseUrl = resolveBaseUrl(config);
  if (!baseUrl) return;

  const defaults = resolveDefaults(config);
  const overrides =
    config.overrides && typeof config.overrides === "object" && !Array.isArray(config.overrides)
      ? config.overrides
      : {};
  let initialModels: ProviderModelConfig[] = [];
  const environmentApiKey = process.env.CALLSTACK_APEX_API_KEY?.trim();
  if (environmentApiKey && process.env.PI_OFFLINE === undefined) {
    try {
      initialModels = await discoverApexModels(
        baseUrl,
        environmentApiKey,
        defaults,
        overrides,
        AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      );
    } catch {
      // Keep startup usable; refreshModels can fall back to Pi's persisted catalog.
    }
  }

  pi.registerProvider(PROVIDER_ID, {
    name: "Callstack Apex",
    baseUrl,
    apiKey: "$CALLSTACK_APEX_API_KEY",
    api: resolveApi(config),
    models: initialModels,
    refreshModels: async (context) => {
      const cached = normalizeApexModels(context.stored?.models ?? [], defaults, overrides);
      const fallback = initialModels.length > 0 ? initialModels : cached;
      const persist = (models: ProviderModelConfig[]) =>
        context.publish({
          persist: {
            models: models as unknown as Model<Api>[],
            checkedAt: Date.now(),
          },
        });
      if (!context.allowNetwork) {
        if (initialModels.length > 0 && !context.signal.aborted) {
          try {
            await persist(initialModels);
          } catch {
            // Persistence is best-effort; the freshly discovered models remain usable in memory.
          }
        }
        return fallback;
      }
      if (
        cached.length > 0 &&
        !context.force &&
        context.stored?.checkedAt &&
        Date.now() - context.stored.checkedAt < MODEL_STORE_TTL_MS
      )
        return cached;

      const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
      if (!apiKey) return fallback;

      try {
        const models = await discoverApexModels(
          baseUrl,
          apiKey,
          defaults,
          overrides,
          context.signal,
        );

        context.signal.throwIfAborted();
        await persist(models);
        return models;
      } catch (error) {
        if (context.signal.aborted) throw error;
        if (fallback.length > 0) return fallback;
        throw error;
      }
    },
  });

  pi.on("session_start", async (_event, context) => {
    if (initialModels.length > 0 || process.env.PI_OFFLINE !== undefined) return;
    if (!context.modelRegistry.getProviderAuthStatus(PROVIDER_ID).configured) return;
    await context.modelRegistry.refresh({ allowNetwork: true, providers: [PROVIDER_ID] });
  });

  pi.registerCommand("apex-refresh", {
    description: "Refresh Callstack Apex models",
    handler: async (_args, context) => {
      const result = await context.modelRegistry.refresh({
        allowNetwork: process.env.PI_OFFLINE === undefined,
        force: true,
        providers: [PROVIDER_ID],
      });
      const error = result.errors.get(PROVIDER_ID);
      if (error) {
        context.ui.notify(error.message, "error");
        return;
      }
      const count = context.modelRegistry
        .getAll()
        .filter((model) => model.provider === PROVIDER_ID).length;
      context.ui.notify(`Refreshed ${count} Apex model${count === 1 ? "" : "s"}`, "info");
    },
  });
}
