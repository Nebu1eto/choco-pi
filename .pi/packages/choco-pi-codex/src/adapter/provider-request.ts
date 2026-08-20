import { JsonObjectSchema } from "./runtime-values.ts";
import type { JsonObject, BoundaryValue } from "./runtime-values.ts";
import { Type } from "typebox";

const ResponsesLiteCompatibleBodySchema = Type.Object({
  model: Type.String(),
  input: Type.Array(Type.Unknown()),
});
import { Value } from "typebox/value";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import {
  canonicalCodexAliasModelKey,
  isCanonicalCodexAliasModel,
  isCanonicalCodexBaseUrl,
  isResponsesContext,
} from "./prompt/codex-model.ts";
import { applyCodexRequestOptions } from "./request-options.ts";
import type { AdapterState } from "./activation/state.ts";
import {
  isAdapterRuntime,
  isCodeModeRuntime,
  resolveCodexRuntimePlanForState,
} from "./activation/runtime-plan.ts";
import {
  injectPendingNativeWindowIntoPiCompactionRequest,
  rewriteCodexCompactedProviderRequest,
} from "./compaction/compaction.ts";
import {
  applyResponsesLiteRequest,
  RESPONSES_LITE_HEADER,
  type ResponsesLiteCompatibleBody,
} from "../providers/openai-codex/responses-lite.ts";

function prepareCodexProviderRequest(
  payload: BoundaryValue,
  ctx: ExtensionContext,
  state: AdapterState,
) {
  if (state.config.voiceFeaturesOnly) return undefined;
  const plan = resolveCodexRuntimePlanForState(ctx, state);
  if (!isAdapterRuntime(plan) || (!plan.effectiveOpenAICodex && !isResponsesContext(ctx))) {
    return undefined;
  }
  return {
    plan,
    configuredPayload: applyCodexRequestOptions(
      applyVoiceSystemPrompt(payload, state.voiceSystemPromptOverride),
      state.config,
      {
        serviceTier: plan.effectiveOpenAICodex,
        verbosity: true,
      },
    ),
  };
}

function applyVoiceSystemPrompt(
  payload: BoundaryValue,
  systemPrompt: string | undefined,
): BoundaryValue {
  if (!systemPrompt || !isRecord(payload)) return payload;
  return { ...payload, instructions: systemPrompt };
}

function applyCodexRuntimePayload(payload: BoundaryValue, codeMode: boolean): BoundaryValue {
  return codeMode && isCodeModeCompatibleBody(payload)
    ? applyResponsesLiteRequest(payload)
    : payload;
}

export async function prepareCanonicalAliasEndpoint(
  ctx: ExtensionContext,
  state: AdapterState,
): Promise<boolean> {
  const model = ctx.model;
  if (!model || !isCanonicalCodexAliasModel(model)) {
    state.canonicalAliasEndpoint = undefined;
    return true;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  const trusted = auth.ok && isCanonicalCodexBaseUrl(auth.baseUrl ?? model.baseUrl);
  state.canonicalAliasEndpoint = { modelKey: canonicalCodexAliasModelKey(model), trusted };
  return trusted;
}

function hasCanonicalAliasEndpoint(ctx: ExtensionContext, state: AdapterState): boolean {
  const model = ctx.model;
  if (!model || !isCanonicalCodexAliasModel(model)) return true;
  const endpoint = state.canonicalAliasEndpoint;
  return endpoint?.modelKey === canonicalCodexAliasModelKey(model) && endpoint.trusted;
}

export function rewriteCodexProviderHeaders(
  headers: ProviderHeaders,
  ctx: ExtensionContext,
  state: AdapterState,
): void {
  if (state.config.voiceFeaturesOnly) return;
  if (
    isCanonicalCodexAliasModel(ctx.model) &&
    isCodeModeRuntime(resolveCodexRuntimePlanForState(ctx, state)) &&
    hasCanonicalAliasEndpoint(ctx, state)
  ) {
    headers[RESPONSES_LITE_HEADER] = "true";
  }
}

export function captureActiveProviderSystemPrompt(
  payload: BoundaryValue,
  state: AdapterState,
): void {
  if (!isRecord(payload)) return;
  const instructions = providerSystemPrompt(payload);
  if (instructions !== undefined) state.activeProviderSystemPrompt = instructions;
}

export async function rewriteCodexProviderRequest(
  payload: BoundaryValue,
  ctx: ExtensionContext,
  state: AdapterState,
): Promise<BoundaryValue | undefined> {
  const prepared = prepareCodexProviderRequest(payload, ctx, state);
  if (!prepared) return undefined;
  if (!hasCanonicalAliasEndpoint(ctx, state)) return undefined;
  const { plan, configuredPayload } = prepared;
  let rewrittenPayload = configuredPayload;
  if (plan.nativeCompaction || state.pendingPiCompactionNativeWindow) {
    const piCompactionPayload = await injectPendingNativeWindowIntoPiCompactionRequest(
      configuredPayload,
      ctx,
      state,
    );
    rewrittenPayload =
      piCompactionPayload ??
      (await rewriteCodexCompactedProviderRequest(configuredPayload, ctx, state)) ??
      configuredPayload;
  }
  const finalPayload = applyCodexRuntimePayload(rewrittenPayload, isCodeModeRuntime(plan));
  // Stock Responses providers and configured Code Mode overlays have no
  // post-serialization callback. Keep native replay on the instructions that
  // reached this final hook boundary; the custom Codex provider captures again
  // after its transport-specific transforms.
  if (state.pendingActiveProviderPromptCapture)
    captureActiveProviderSystemPrompt(finalPayload, state);
  return finalPayload;
}

export function rewriteCodexPrewarmProviderRequest(
  payload: BoundaryValue,
  ctx: ExtensionContext,
  state: AdapterState,
): BoundaryValue | undefined {
  const prepared = prepareCodexProviderRequest(payload, ctx, state);
  return prepared
    ? applyCodexRuntimePayload(prepared.configuredPayload, isCodeModeRuntime(prepared.plan))
    : undefined;
}

function isCodeModeCompatibleBody(value: BoundaryValue): value is ResponsesLiteCompatibleBody {
  return Value.Check(ResponsesLiteCompatibleBodySchema, value);
}

function isRecord(value: BoundaryValue): value is JsonObject {
  return Value.Check(JsonObjectSchema, value);
}

function providerSystemPrompt(payload: JsonObject): string | undefined {
  if (Value.Check(Type.String(), payload["instructions"])) return payload["instructions"];
  if (!Array.isArray(payload["input"])) return undefined;
  for (const item of payload["input"]) {
    if (!isRecord(item) || item["role"] !== "developer" || !Array.isArray(item["content"]))
      continue;
    const text = item["content"]
      .filter((part) => isRecord(part) && part["type"] === "input_text")
      .map((part) => (isRecord(part) ? part["text"] : undefined))
      .filter((part): part is string => Value.Check(Type.String(), part))
      .join("\n");
    if (text !== "") return text;
  }
  return undefined;
}
