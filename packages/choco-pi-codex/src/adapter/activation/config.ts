import { isBoolean, isNumber, isString } from "@choco-pi/code-mode/value-guards";
import { conditionalProperties } from "@choco-pi/code-mode/runtime-values";
import { isJsonObject } from "@choco-pi/code-mode/runtime-values";
import type { JsonObject, BoundaryValue } from "@choco-pi/code-mode/runtime-values";
import { normalizeExecutionMode, type ExecutionMode } from "./execution-mode.ts";

export type CodexVerbosity = "low" | "medium" | "high";
export type CacheDiagnosticsMode = "off" | "status" | "status-and-log";
export type AllProvidersMode = "off" | "on" | "extras";
export type HelperModel =
  | "gpt-6.1-terra"
  | "gpt-6.1-sol"
  | "gpt-6-sol"
  | "gpt-6-luna"
  | "gpt-5.6-luna"
  | "gpt-5.6-terra"
  | "gpt-5.6-sol";
export type WebSearchModel = HelperModel;
export type V2UserMessageRetention = 16 | 32 | 64;
export const MIN_NOTEBOOK_HEAP_MIB = 256;
export const MAX_NOTEBOOK_HEAP_MIB = 65_536;

// Pi 1.4.0 removed gpt-5.5 and gpt-5.3-codex-spark from openai-codex: they always fail for
// ChatGPT accounts. gpt-5.4-mini is retired from this list. A saved value naming any of
// them normalizes to the default.
export const WEB_SEARCH_MODELS: readonly WebSearchModel[] = [
  "gpt-6.1-terra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
];
export const V2_USER_MESSAGE_RETENTION_OPTIONS: readonly V2UserMessageRetention[] = [16, 32, 64];

export interface CodexConversionConfig {
  executionMode: ExecutionMode;
  voiceFeaturesOnly: boolean;
  prompt: { heavySystemPromptOverwrite: boolean };
  scope: { allProviders: AllProvidersMode; additionalProviders: string[] };
  tools: {
    customRustBinariesDir: string;
    webRun: boolean;
    imageGeneration: boolean;
    viewImageFallback: boolean;
    applyPatchOnly: boolean;
    viewImageOnly: boolean;
    webRunOnly: boolean;
    imageGenerationOnly: boolean;
  };
  ui: {
    statusLine: boolean;
    toolRenaming: boolean;
    compactTools: boolean;
    codeModeDetails: boolean;
    steeringDeliveryStatus: boolean;
  };
  compaction: {
    responsesCompaction: boolean;
    v2UserMessageRetention: V2UserMessageRetention;
  };
  notebook: { maxHeapMiB: number; profile?: string | undefined };
  openai: {
    fast: boolean;
    verbosity: CodexVerbosity;
    cacheKeepalive: boolean;
    proxyResponsesLite: boolean;
    forceCachedWebSockets: boolean;
    midTurnSteering: boolean;
    asyncCodeMode: boolean;
    cacheDiagnostics: CacheDiagnosticsMode;
    webSearchModel: WebSearchModel;
  };
}

export const DEFAULT_CODEX_CONVERSION_CONFIG: CodexConversionConfig = {
  executionMode: "code",
  voiceFeaturesOnly: false,
  prompt: { heavySystemPromptOverwrite: false },
  scope: { allProviders: "on", additionalProviders: [] },
  tools: {
    customRustBinariesDir: "",
    webRun: true,
    imageGeneration: true,
    viewImageFallback: false,
    applyPatchOnly: false,
    viewImageOnly: false,
    webRunOnly: false,
    imageGenerationOnly: false,
  },
  ui: {
    statusLine: true,
    toolRenaming: true,
    compactTools: false,
    codeModeDetails: false,
    steeringDeliveryStatus: false,
  },
  compaction: { responsesCompaction: false, v2UserMessageRetention: 64 },
  notebook: { maxHeapMiB: 4_096 },
  openai: {
    fast: false,
    verbosity: "low",
    cacheKeepalive: false,
    proxyResponsesLite: false,
    forceCachedWebSockets: true,
    midTurnSteering: true,
    asyncCodeMode: true,
    cacheDiagnostics: "off",
    webSearchModel: "gpt-6.1-terra",
  },
};

export function isObject(value: BoundaryValue): value is JsonObject {
  return isJsonObject(value);
}

export function normalizeAllProvidersMode(value: BoundaryValue): AllProvidersMode | undefined {
  if (value === true) return "on";
  if (value === false) return "off";
  return value === "off" || value === "on" || value === "extras" ? value : undefined;
}

export function normalizeCodexVerbosity(value: BoundaryValue): CodexVerbosity | undefined {
  if (!isString(value)) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "low" || normalized === "medium" || normalized === "high"
    ? normalized
    : undefined;
}

export function normalizeCacheDiagnosticsMode(
  value: BoundaryValue,
): CacheDiagnosticsMode | undefined {
  return value === "off" || value === "status" || value === "status-and-log" ? value : undefined;
}

export function normalizeWebSearchModel(value: BoundaryValue): WebSearchModel | undefined {
  return WEB_SEARCH_MODELS.find((model) => model === value);
}

export function normalizeV2UserMessageRetention(
  value: BoundaryValue,
): V2UserMessageRetention | undefined {
  return value === 16 || value === 32 || value === 64 ? value : undefined;
}

export function normalizeProviderList(value: BoundaryValue): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string => isString(entry))
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function bool(value: BoundaryValue, fallback: boolean): boolean {
  return isBoolean(value) ? value : fallback;
}

function optionalString(value: BoundaryValue): string | undefined {
  if (!isString(value)) return undefined;
  const normalized = value.trim();
  return normalized && Buffer.byteLength(normalized) <= 512 ? normalized : undefined;
}

function integerInRange(
  value: BoundaryValue,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export function normalizeCustomRustBinariesDir(value: BoundaryValue): string {
  return optionalString(value) ?? "";
}

// Retired upstream keys (`voice.*`, `ui.backgroundShell*`) are not read: the
// normalizer drops them, and writes merge into the existing document, so a
// legacy file keeps them untouched.
export function normalizeCodexConversionConfig(value: BoundaryValue): CodexConversionConfig {
  if (!isObject(value)) return structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
  const prompt = isObject(value["prompt"]) ? value["prompt"] : {};
  const scope = isObject(value["scope"]) ? value["scope"] : {};
  const tools = isObject(value["tools"]) ? value["tools"] : {};
  const ui = isObject(value["ui"]) ? value["ui"] : {};
  const compaction = isObject(value["compaction"]) ? value["compaction"] : {};
  const notebook = isObject(value["notebook"]) ? value["notebook"] : {};
  const openai = isObject(value["openai"]) ? value["openai"] : {};
  const notebookProfile = normalizeNotebookProfile(notebook["profile"]);
  const executionMode =
    normalizeExecutionMode(value["executionMode"]) ?? DEFAULT_CODEX_CONVERSION_CONFIG.executionMode;
  return {
    executionMode,
    voiceFeaturesOnly: bool(
      value["voiceFeaturesOnly"],
      DEFAULT_CODEX_CONVERSION_CONFIG.voiceFeaturesOnly,
    ),
    prompt: {
      heavySystemPromptOverwrite: bool(
        prompt["heavySystemPromptOverwrite"],
        DEFAULT_CODEX_CONVERSION_CONFIG.prompt.heavySystemPromptOverwrite,
      ),
    },
    scope: {
      allProviders:
        normalizeAllProvidersMode(scope["allProviders"]) ??
        DEFAULT_CODEX_CONVERSION_CONFIG.scope["allProviders"],
      additionalProviders: normalizeProviderList(scope["additionalProviders"]),
    },
    tools: {
      customRustBinariesDir: normalizeCustomRustBinariesDir(tools["customRustBinariesDir"]),
      webRun: bool(tools["webRun"], DEFAULT_CODEX_CONVERSION_CONFIG.tools["webRun"]),
      imageGeneration: bool(
        tools["imageGeneration"],
        DEFAULT_CODEX_CONVERSION_CONFIG.tools["imageGeneration"],
      ),
      viewImageFallback: bool(
        tools["viewImageFallback"],
        DEFAULT_CODEX_CONVERSION_CONFIG.tools["viewImageFallback"],
      ),
      applyPatchOnly: bool(
        tools["applyPatchOnly"],
        DEFAULT_CODEX_CONVERSION_CONFIG.tools["applyPatchOnly"],
      ),
      viewImageOnly: bool(
        tools["viewImageOnly"],
        DEFAULT_CODEX_CONVERSION_CONFIG.tools["viewImageOnly"],
      ),
      webRunOnly: bool(tools["webRunOnly"], DEFAULT_CODEX_CONVERSION_CONFIG.tools["webRunOnly"]),
      imageGenerationOnly: bool(
        tools["imageGenerationOnly"],
        DEFAULT_CODEX_CONVERSION_CONFIG.tools["imageGenerationOnly"],
      ),
    },
    ui: {
      statusLine: bool(ui["statusLine"], DEFAULT_CODEX_CONVERSION_CONFIG.ui["statusLine"]),
      toolRenaming: bool(
        ui["toolRenaming"],
        bool(ui["toolRendering"], DEFAULT_CODEX_CONVERSION_CONFIG.ui["toolRenaming"]),
      ),
      compactTools: bool(ui["compactTools"], DEFAULT_CODEX_CONVERSION_CONFIG.ui["compactTools"]),
      codeModeDetails: bool(
        ui["codeModeDetails"],
        DEFAULT_CODEX_CONVERSION_CONFIG.ui["codeModeDetails"],
      ),
      steeringDeliveryStatus: bool(
        ui["steeringDeliveryStatus"],
        DEFAULT_CODEX_CONVERSION_CONFIG.ui.steeringDeliveryStatus,
      ),
    },
    compaction: {
      responsesCompaction: bool(
        compaction["responsesCompaction"],
        DEFAULT_CODEX_CONVERSION_CONFIG.compaction["responsesCompaction"],
      ),
      v2UserMessageRetention:
        normalizeV2UserMessageRetention(compaction["v2UserMessageRetention"]) ??
        DEFAULT_CODEX_CONVERSION_CONFIG.compaction.v2UserMessageRetention,
    },
    notebook: {
      maxHeapMiB: integerInRange(
        notebook["maxHeapMiB"],
        DEFAULT_CODEX_CONVERSION_CONFIG.notebook.maxHeapMiB,
        MIN_NOTEBOOK_HEAP_MIB,
        MAX_NOTEBOOK_HEAP_MIB,
      ),
      ...conditionalProperties(Boolean(notebookProfile), { profile: notebookProfile }),
    },
    openai: {
      fast: bool(openai["fast"], DEFAULT_CODEX_CONVERSION_CONFIG.openai["fast"]),
      verbosity:
        normalizeCodexVerbosity(openai["verbosity"]) ??
        DEFAULT_CODEX_CONVERSION_CONFIG.openai["verbosity"],
      cacheKeepalive: bool(
        openai["cacheKeepalive"],
        DEFAULT_CODEX_CONVERSION_CONFIG.openai["cacheKeepalive"],
      ),
      proxyResponsesLite: bool(
        openai["proxyResponsesLite"],
        DEFAULT_CODEX_CONVERSION_CONFIG.openai.proxyResponsesLite,
      ),
      forceCachedWebSockets: bool(
        openai["forceCachedWebSockets"],
        DEFAULT_CODEX_CONVERSION_CONFIG.openai["forceCachedWebSockets"],
      ),
      midTurnSteering: bool(openai["midTurnSteering"], true),
      asyncCodeMode: bool(openai["asyncCodeMode"], true),
      cacheDiagnostics:
        normalizeCacheDiagnosticsMode(openai["cacheDiagnostics"]) ??
        DEFAULT_CODEX_CONVERSION_CONFIG.openai.cacheDiagnostics,
      webSearchModel:
        normalizeWebSearchModel(openai["webSearchModel"]) ??
        DEFAULT_CODEX_CONVERSION_CONFIG.openai["webSearchModel"],
    },
  };
}

function normalizeNotebookProfile(value: BoundaryValue): string | undefined {
  const name = optionalString(value);
  return name && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : undefined;
}
