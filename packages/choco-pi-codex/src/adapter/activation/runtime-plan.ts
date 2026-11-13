import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  supportsNativeImageGeneration,
  supportsNativeWebSearch,
  supportsViewImageInputs,
} from "../tool-support.ts";
import {
  canonicalCodexAliasModelKey,
  type CodexLikeModelDescriptor,
  isCanonicalCodexAliasModel,
  isCodexLikeModel,
  isCodexTransportContext,
  isCodexTransportModel,
  isOpenAIResponsesContext,
  isResponsesModel,
} from "../prompt/codex-model.ts";
import type { CodexConversionConfig } from "./config.ts";
import type { ExecutionMode } from "./execution-mode.ts";
import type { AdapterState } from "./state.ts";
import {
  APPLY_PATCH_TOOL_NAME,
  CODE_MODE_TOOL_NAMES,
  CORE_ADAPTER_TOOL_NAMES,
  IMAGE_GENERATION_TOOL_NAME,
  NOTEBOOK_MODE_TOOL_NAMES,
  SHELL_ADAPTER_TOOL_NAMES,
  VIEW_IMAGE_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "./tool-set.ts";

type RuntimeContext = Pick<ExtensionContext, "model">;

interface RuntimePlanBase {
  kind: "inactive" | "extras" | "normal" | "code" | "notebook";
  toolNames: string[];
  ownedToolNames: string[];
  configuredProvider: boolean;
  codexTransport: boolean;
  effectiveOpenAICodex: boolean;
  nativeCompaction: boolean;
}

export interface InactiveRuntimePlan extends RuntimePlanBase {
  kind: "inactive";
  toolNames: [];
  prompt: undefined;
  transport: undefined;
}

export interface ExtrasRuntimePlan extends RuntimePlanBase {
  kind: "extras";
  prompt: undefined;
  transport: "responses";
}

export interface NormalRuntimePlan extends RuntimePlanBase {
  kind: "normal";
  prompt: "normal";
  transport: "responses";
}

export interface CodeRuntimePlan extends RuntimePlanBase {
  kind: "code";
  prompt: "code";
  transport: "responses" | "responses-lite";
}

export interface NotebookRuntimePlan extends RuntimePlanBase {
  kind: "notebook";
  prompt: "notebook";
  transport: "responses" | "responses-lite";
}

export type CodexRuntimePlan =
  | InactiveRuntimePlan
  | ExtrasRuntimePlan
  | NormalRuntimePlan
  | CodeRuntimePlan
  | NotebookRuntimePlan;

const ALL_ADAPTER_TOOL_NAMES = [
  ...CORE_ADAPTER_TOOL_NAMES,
  ...NOTEBOOK_MODE_TOOL_NAMES,
  WEB_SEARCH_TOOL_NAME,
  IMAGE_GENERATION_TOOL_NAME,
  VIEW_IMAGE_TOOL_NAME,
];

type PlanModel = Partial<CodexLikeModelDescriptor> | null | undefined;

function configuredProviderModel(model: PlanModel, config: CodexConversionConfig): boolean {
  const provider = model?.provider?.trim().toLowerCase();
  return Boolean(
    provider && isResponsesModel(model) && config.scope.additionalProviders.includes(provider),
  );
}

function configuredProvider(ctx: RuntimeContext, config: CodexConversionConfig): boolean {
  return configuredProviderModel(ctx.model, config);
}

function proxySupportsCodeMode(ctx: RuntimeContext, config: CodexConversionConfig): boolean {
  if (
    !config.openai.proxyResponsesLite ||
    !configuredProvider(ctx, config) ||
    !isOpenAIResponsesContext(ctx)
  )
    return false;
  const modelId = ctx.model?.id;
  if (!modelId) return false;
  const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  return /^gpt-5\.6(?:-(?:luna|terra|sol))?$/.test(id.toLowerCase());
}

function codeModeTransport(
  ctx: RuntimeContext,
  config: CodexConversionConfig,
): "responses" | "responses-lite" {
  return isCodexTransportContext(ctx) || proxySupportsCodeMode(ctx, config)
    ? "responses-lite"
    : "responses";
}

function hasExtras(config: CodexConversionConfig): boolean {
  const tools = config.tools;
  return (
    tools.applyPatchOnly || tools.viewImageOnly || tools.webRunOnly || tools.imageGenerationOnly
  );
}

export function usesCodexProviderFallback(config: CodexConversionConfig): boolean {
  return config.scope.allProviders !== "off";
}

function extraToolNames(
  ctx: RuntimeContext,
  config: CodexConversionConfig,
  codexBacked: boolean,
  legacyWebRun: boolean,
): string[] {
  const names: string[] = [];
  if (config.tools.applyPatchOnly) names.push(APPLY_PATCH_TOOL_NAME);
  if (
    config.tools.viewImageOnly &&
    (supportsViewImageInputs(ctx.model) || config.tools.viewImageFallback)
  )
    names.push(VIEW_IMAGE_TOOL_NAME);
  if (
    legacyWebRun &&
    config.tools.webRunOnly &&
    (supportsNativeWebSearch(ctx.model) || codexBacked)
  )
    names.push(WEB_SEARCH_TOOL_NAME);
  if (config.tools.imageGenerationOnly && (supportsNativeImageGeneration(ctx.model) || codexBacked))
    names.push(IMAGE_GENERATION_TOOL_NAME);
  return names;
}

function normalToolNames(
  ctx: RuntimeContext,
  config: CodexConversionConfig,
  codexBacked: boolean,
  legacyWebRun: boolean,
): string[] {
  const names = [...CORE_ADAPTER_TOOL_NAMES];
  if (legacyWebRun && config.tools.webRun && (supportsNativeWebSearch(ctx.model) || codexBacked))
    names.push(WEB_SEARCH_TOOL_NAME);
  if (config.tools.imageGeneration && (supportsNativeImageGeneration(ctx.model) || codexBacked))
    names.push(IMAGE_GENERATION_TOOL_NAME);
  if (supportsViewImageInputs(ctx.model) || config.tools.viewImageFallback)
    names.push(VIEW_IMAGE_TOOL_NAME);
  return names;
}

/**
 * The model- and config-only exits of a runtime plan, shared by
 * {@link resolveCodexRuntimePlan} and {@link resolveNativeCompactionEligibility}
 * so the two can never disagree on native compaction.
 */
interface PlanGate {
  readonly isConfigured: boolean;
  readonly codexTransport: boolean;
  readonly effectiveOpenAICodex: boolean;
  /** The extras plan applies (no native compaction). */
  readonly extras: boolean;
  /** Not voice-only, the canonical alias endpoint is trusted, and the adapter is in scope. */
  readonly active: boolean;
}

function resolvePlanGate(
  model: PlanModel,
  config: CodexConversionConfig,
  canonicalAliasEndpointTrusted: boolean | undefined,
): PlanGate {
  const isConfigured = configuredProviderModel(model, config);
  const codexTransport = isCodexTransportModel(model);
  const extras =
    hasExtras(config) &&
    (config.scope.allProviders === "extras" ||
      (config.voiceFeaturesOnly && config.scope.allProviders === "on") ||
      (config.scope.allProviders === "off" && (isConfigured || isCodexLikeModel(model))));
  const canonicalAliasTrusted =
    !isCanonicalCodexAliasModel(model) || canonicalAliasEndpointTrusted !== false;
  const active =
    !config.voiceFeaturesOnly &&
    canonicalAliasTrusted &&
    (config.scope.allProviders === "on" || isConfigured || isCodexLikeModel(model));
  return {
    isConfigured,
    codexTransport,
    effectiveOpenAICodex: codexTransport || isConfigured,
    extras,
    active,
  };
}

/**
 * Whether Codex compacts natively for `model`: exactly
 * `resolveCodexRuntimePlan(...).nativeCompaction`, without building tool
 * lists. Published to the compaction host as the ownership predicate.
 */
export function resolveNativeCompactionEligibility(
  model: PlanModel,
  config: CodexConversionConfig,
  options: { canonicalAliasEndpointTrusted?: boolean | undefined } = {},
): boolean {
  const gate = resolvePlanGate(model, config, options.canonicalAliasEndpointTrusted);
  return (
    !gate.extras &&
    gate.active &&
    config.compaction.responsesCompaction &&
    gate.effectiveOpenAICodex
  );
}

/** {@link resolveNativeCompactionEligibility} with the adapter state's canonical-alias trust. */
export function resolveNativeCompactionEligibilityForState(
  model: PlanModel,
  state: Pick<AdapterState, "config" | "canonicalAliasEndpoint">,
): boolean {
  return resolveNativeCompactionEligibility(model, state.config, {
    canonicalAliasEndpointTrusted: canonicalAliasTrustFor(model, state),
  });
}

/** Undefined for a model that is not a canonical alias (trusted by default). */
function canonicalAliasTrustFor(
  model: PlanModel,
  state: Pick<AdapterState, "canonicalAliasEndpoint">,
): boolean | undefined {
  if (!model || !isCanonicalCodexAliasModel(model)) return undefined;
  const endpoint = state.canonicalAliasEndpoint;
  return endpoint?.modelKey === canonicalCodexAliasModelKey(model) && endpoint.trusted;
}

export function resolveCodexRuntimePlan(
  ctx: RuntimeContext,
  config: CodexConversionConfig,
  executionMode?: ExecutionMode,
  options: {
    canonicalAliasEndpointTrusted?: boolean | undefined;
    canonicalSearch?: boolean | undefined;
  } = {},
): CodexRuntimePlan {
  const gate = resolvePlanGate(ctx.model, config, options.canonicalAliasEndpointTrusted);
  const { isConfigured, codexTransport, effectiveOpenAICodex } = gate;
  const ownedToolNames = [
    ...SHELL_ADAPTER_TOOL_NAMES,
    ...NOTEBOOK_MODE_TOOL_NAMES,
    APPLY_PATCH_TOOL_NAME,
    VIEW_IMAGE_TOOL_NAME,
    ...(config.tools.webRun ? [WEB_SEARCH_TOOL_NAME] : []),
    ...(config.tools.imageGeneration ? [IMAGE_GENERATION_TOOL_NAME] : []),
  ];
  const base = {
    ownedToolNames,
    configuredProvider: isConfigured,
    codexTransport,
    effectiveOpenAICodex,
    nativeCompaction: false,
  };
  const codexBacked = usesCodexProviderFallback(config) || isConfigured;
  if (gate.extras) {
    return {
      ...base,
      kind: "extras",
      toolNames: extraToolNames(ctx, config, codexBacked, options.canonicalSearch !== true),
      prompt: undefined,
      transport: "responses",
    };
  }
  if (!gate.active)
    return { ...base, kind: "inactive", toolNames: [], prompt: undefined, transport: undefined };
  const nativeCompaction = config.compaction.responsesCompaction && effectiveOpenAICodex;
  const configuredExecutionMode = executionMode ?? config.executionMode;
  const requestedCodeMode =
    configuredExecutionMode === "code" || configuredExecutionMode === "notebook"
      ? configuredExecutionMode
      : configuredExecutionMode === "normal"
        ? undefined
        : undefined;
  if (requestedCodeMode) {
    const transport = codeModeTransport(ctx, config);
    if (requestedCodeMode === "notebook") {
      return {
        ...base,
        kind: "notebook",
        toolNames: [...NOTEBOOK_MODE_TOOL_NAMES],
        prompt: "notebook",
        transport,
        nativeCompaction,
      };
    }
    return {
      ...base,
      kind: "code",
      toolNames: [...CODE_MODE_TOOL_NAMES],
      prompt: "code",
      transport,
      nativeCompaction,
    };
  }
  return {
    ...base,
    kind: "normal",
    toolNames: normalToolNames(ctx, config, codexBacked, options.canonicalSearch !== true),
    prompt: "normal",
    transport: "responses",
    nativeCompaction,
  };
}

export function resolveCodexRuntimePlanForState(
  ctx: RuntimeContext,
  state: Pick<
    AdapterState,
    "canonicalSearch" | "config" | "canonicalAliasEndpoint" | "executionMode"
  >,
): CodexRuntimePlan {
  const trusted = canonicalAliasTrustFor(ctx.model, state);
  if (trusted === undefined)
    return resolveCodexRuntimePlan(ctx, state.config, state.executionMode, {
      canonicalSearch: state.canonicalSearch,
    });
  return resolveCodexRuntimePlan(ctx, state.config, state.executionMode, {
    canonicalAliasEndpointTrusted: trusted,
    canonicalSearch: state.canonicalSearch,
  });
}

export function isAdapterRuntime(
  plan: CodexRuntimePlan,
): plan is NormalRuntimePlan | CodeRuntimePlan | NotebookRuntimePlan {
  return plan.kind === "normal" || plan.kind === "code" || plan.kind === "notebook";
}

export function isCodeModeRuntime(
  plan: CodexRuntimePlan,
): plan is CodeRuntimePlan | NotebookRuntimePlan {
  return plan.kind === "code" || plan.kind === "notebook";
}

export const ALL_CODEX_ADAPTER_TOOL_NAMES = ALL_ADAPTER_TOOL_NAMES;
