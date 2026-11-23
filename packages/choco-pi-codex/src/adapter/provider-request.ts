import { arr, compile, obj, str, unknown } from "@earendil-works/pi-schema";
import { isString } from "@choco-pi/code-mode/value-guards";
import { isJsonObject } from "@choco-pi/code-mode/runtime-values";
import type { JsonObject, BoundaryValue } from "@choco-pi/code-mode/runtime-values";

const responsesLiteCompatibleBodyValidator = compile(
  obj({ model: str(), input: arr(unknown()) }, { open: true }),
);
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

export { CodexRequestRefusedError } from "./compaction/compaction.ts";
import {
  applyResponsesLiteRequest,
  RESPONSES_LITE_HEADER,
  supportsResponsesLiteModel,
  type ResponsesLiteCompatibleBody,
} from "../providers/openai-codex/responses-lite.ts";
import {
  codexDecisionOmitsServiceTier,
  codexServiceTierForDecision,
  snapshotCodexFastModeDecision,
  type CodexFastModeDecision,
} from "../providers/openai-codex/fast-mode-decision.ts";
import { withoutCodexAccessPrograms } from "../providers/openai-codex/daybreak-decision.ts";
import { isOpenAISubscriptionSignInModel } from "./openai-sign-in.ts";

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
  const model = ctx.model;
  if (!model) return undefined;
  const fastModeDecision = snapshotCodexFastModeDecision(
    ctx.sessionManager.getSessionId(),
    model,
    state.config.openai.fast === true,
    ctx.modelRegistry,
  );
  return {
    plan,
    responsesLite: isCodeModeRuntime(plan) && supportsResponsesLiteModel(model),
    fastModeDecision,
    configuredPayload: applyCodexRequestOptions(
      applyVoiceSystemPrompt(payload, state.voiceSystemPromptOverride),
      state.config,
      {
        serviceTier: false,
        verbosity: true,
      },
    ),
  };
}

function applyAuthoritativeServiceTier(
  payload: BoundaryValue,
  decision: CodexFastModeDecision,
): BoundaryValue {
  if (!isRecord(payload)) return payload;
  const serviceTier = codexServiceTierForDecision(decision);
  if (serviceTier) return { ...payload, service_tier: serviceTier };
  if (!codexDecisionOmitsServiceTier(decision)) return payload;
  const { service_tier: _omitted, ...standard } = payload;
  return standard;
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

export function codexNativeReplayApplies(ctx: ExtensionContext, state: AdapterState): boolean {
  if (state.config.voiceFeaturesOnly || ctx.model === undefined) return false;
  const plan = resolveCodexRuntimePlanForState(ctx, state);
  return (
    isAdapterRuntime(plan) &&
    (plan.effectiveOpenAICodex || isResponsesContext(ctx)) &&
    plan.nativeCompaction &&
    hasCanonicalAliasEndpoint(ctx, state)
  );
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

function withoutAccessPrograms(
  original: BoundaryValue,
  rewritten: BoundaryValue | undefined,
): BoundaryValue | undefined {
  const payload = rewritten ?? original;
  if (!isRecord(payload) || !Object.hasOwn(payload, "access_programs")) return rewritten;
  return withoutCodexAccessPrograms(payload);
}

function withoutSubscriptionSignInServiceTier(
  original: BoundaryValue,
  rewritten: BoundaryValue | undefined,
): BoundaryValue | undefined {
  const payload = rewritten ?? original;
  if (!isRecord(payload) || !Object.hasOwn(payload, "service_tier")) return rewritten;
  const { service_tier: _serviceTier, ...rest } = payload;
  return rest;
}

export async function rewriteCodexProviderRequest(
  payload: BoundaryValue,
  ctx: ExtensionContext,
  state: AdapterState,
  pi?: Pick<ExtensionAPI, "appendEntry">,
): Promise<BoundaryValue | undefined> {
  const subscriptionSignIn = isOpenAISubscriptionSignInModel(ctx.model, ctx.modelRegistry);
  const rewritten = withoutAccessPrograms(
    payload,
    await rewriteCodexProviderRequestBody(payload, ctx, state, pi),
  );
  return subscriptionSignIn ? withoutSubscriptionSignInServiceTier(payload, rewritten) : rewritten;
}

async function rewriteCodexProviderRequestBody(
  payload: BoundaryValue,
  ctx: ExtensionContext,
  state: AdapterState,
  pi: Pick<ExtensionAPI, "appendEntry"> | undefined,
): Promise<BoundaryValue | undefined> {
  const prepared = prepareCodexProviderRequest(payload, ctx, state);
  if (!prepared) return undefined;
  if (!hasCanonicalAliasEndpoint(ctx, state)) return undefined;
  const { plan, responsesLite, fastModeDecision, configuredPayload } = prepared;
  let rewrittenPayload = configuredPayload;
  if (plan.nativeCompaction || state.pendingPiCompactionNativeWindow) {
    const piCompactionPayload = await injectPendingNativeWindowIntoPiCompactionRequest(
      configuredPayload,
      ctx,
      state,
    );
    rewrittenPayload =
      piCompactionPayload ??
      (await rewriteCodexCompactedProviderRequest(configuredPayload, ctx, state, pi)) ??
      configuredPayload;
  }
  const finalPayload = applyAuthoritativeServiceTier(
    applyCodexRuntimePayload(rewrittenPayload, responsesLite),
    fastModeDecision,
  );
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
  const rewritten = prepared
    ? applyAuthoritativeServiceTier(
        applyCodexRuntimePayload(prepared.configuredPayload, prepared.responsesLite),
        prepared.fastModeDecision,
      )
    : undefined;
  return withoutAccessPrograms(payload, rewritten);
}

function isCodeModeCompatibleBody(value: BoundaryValue): value is ResponsesLiteCompatibleBody {
  return responsesLiteCompatibleBodyValidator.check(value);
}

function isRecord(value: BoundaryValue): value is JsonObject {
  return isJsonObject(value);
}

function providerSystemPrompt(payload: JsonObject): string | undefined {
  if (isString(payload["instructions"])) return payload["instructions"];
  if (!Array.isArray(payload["input"])) return undefined;
  for (const item of payload["input"]) {
    if (!isRecord(item) || item["role"] !== "developer" || !Array.isArray(item["content"]))
      continue;
    const text = item["content"]
      .filter((part) => isRecord(part) && part["type"] === "input_text")
      .map((part) => (isRecord(part) ? part["text"] : undefined))
      .filter((part): part is string => isString(part))
      .join("\n");
    if (text !== "") return text;
  }
  return undefined;
}
