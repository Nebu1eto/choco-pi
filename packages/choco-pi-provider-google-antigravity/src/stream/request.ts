import type { Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import {
  convertMessages,
  convertTools,
  resolveGoogleFunctionCallingMode,
  supportsGoogleStrictToolSampling,
} from "@earendil-works/pi-ai/api/google-shared";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode";
import { bool, compile, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { CATALOG_LEVELS, resolveRuntimeModel } from "../catalog/group.ts";
import type {
  AntigravityThinkingConfig,
  RequestedThinkingLevel,
  RuntimeModelResolution,
} from "../catalog/group.ts";
import { conversationIdentity } from "./identity.ts";
import type { ConversationIdentity } from "./identity.ts";

export type GoogleModel = Model<"google-generative-ai">;
type GeminiContent = ReturnType<typeof convertMessages>[number];
type GeminiTools = NonNullable<ReturnType<typeof convertTools>>;
type FunctionCallingMode = NonNullable<ReturnType<typeof resolveGoogleFunctionCallingMode>>;

/** Where the Pi system prompt travels. agy sends it as systemInstruction (the capture). */
export const SYSTEM_PROMPT_PLACEMENTS = ["system_instruction", "first_user_turn"] as const;
export type SystemPromptPlacement = (typeof SYSTEM_PROMPT_PLACEMENTS)[number];
/** Environment switch for the unverified first-user-turn placement (see docs/transport.md). */
export const ENV_SYSTEM_PROMPT_PLACEMENT = "CHOCO_PI_ANTIGRAVITY_SYSTEM_PROMPT_PLACEMENT";
const isPlacement = compile(oneOf(SYSTEM_PROMPT_PLACEMENTS)).check;

/** Resolves the placement switch; anything but "first_user_turn" keeps the captured default. */
export function systemPromptPlacement(value: string | undefined): SystemPromptPlacement {
  const normalized = value?.trim().toLowerCase();
  return isPlacement(normalized) ? normalized : "system_instruction";
}

/**
 * request.labels as agy sends them: string values only, and only values this client actually
 * has (no fabricated execution ids).
 */
export interface AntigravityLabels {
  cascade_id: string;
  last_step_index: string;
  model_enum?: string;
  request_id: string;
  root_cascade_id: string;
  trajectory_id: string;
  used_claude: "true" | "false";
  used_claude_conservative: "true" | "false";
  used_non_gemini_model: "true" | "false";
}

/** v1internal GenerateContentRequest as agy fills it (S/proxylog2 014). */
export interface AntigravityGenerateRequest {
  contents: GeminiContent[];
  systemInstruction?: { role: "user"; parts: { text: string }[] };
  /** Gemini: parametersJsonSchema (pi-ai). Claude and GPT-OSS: OpenAPI-subset parameters. */
  tools?: GeminiTools;
  toolConfig?: { functionCallingConfig: { mode: FunctionCallingMode } };
  labels: AntigravityLabels;
  /** agy sends no sampling parameters (temperature, topP, topK) for any model. */
  generationConfig: {
    maxOutputTokens: number;
    thinkingConfig?: AntigravityThinkingConfig;
  };
  sessionId: string;
}

/** The streamGenerateContent envelope. Key order follows the capture. */
export interface AntigravityStreamEnvelope {
  project: string;
  requestId: string;
  request: AntigravityGenerateRequest;
  model: string;
  userAgent: "antigravity";
  requestType: "agent";
}

// Pi routes both stream() (GoogleOptions: thinking, toolChoice "any") and streamSimple()
// (reasoning) through the provider-level streamSimple, so the GoogleOptions members are read
// through a schema instead of the declared SimpleStreamOptions type.
const GoogleStreamOptionsSchema = obj(
  {
    thinking: opt(
      obj({ enabled: bool(), level: opt(str()), budgetTokens: opt(num()) }, { open: true }),
    ),
    toolChoice: opt(str()),
  },
  { open: true },
);
const isGoogleStreamOptions = compile(GoogleStreamOptionsSchema).check;
const isCatalogLevel = compile(oneOf(CATALOG_LEVELS)).check;
const isToolChoice = compile(oneOf(["auto", "none", "any"])).check;

/**
 * The Pi thinking level a request asks for. undefined means "not requested": the lowest
 * advertised variant without thought summaries, as Pi's Gemini adapter disables thinking.
 */
export function requestedThinkingLevel(
  model: GoogleModel,
  options: SimpleStreamOptions | undefined,
): RequestedThinkingLevel | undefined {
  if (options?.reasoning !== undefined) {
    return model.reasoning ? clampThinkingLevel(model, options.reasoning) : "off";
  }
  const thinking = isGoogleStreamOptions(options) ? options.thinking : undefined;
  if (thinking === undefined) return undefined;
  if (!thinking.enabled || !model.reasoning) return "off";
  const level = thinking.level?.toLowerCase();
  // A bare budget has no level equivalent; it asks for thinking, so the top level is used.
  return clampThinkingLevel(model, isCatalogLevel(level) ? level : "high");
}

function requestedToolChoice(options: SimpleStreamOptions | undefined): string | undefined {
  const choice = isGoogleStreamOptions(options) ? options.toolChoice : undefined;
  return isToolChoice(choice) ? choice : undefined;
}

function usageFlags(context: TranscriptContext, family: RuntimeModelResolution["family"]) {
  const models = context.messages.flatMap((message) =>
    message.role === "assistant" ? [message.model] : [],
  );
  const usedClaude = family === "claude" || models.some((id) => id.startsWith("claude"));
  const usedNonGemini = family !== "gemini" || models.some((id) => !id.startsWith("gemini"));
  return { usedClaude, usedNonGemini };
}

function placeInFirstUserTurn(contents: GeminiContent[], prompt: string): GeminiContent[] {
  const [first, ...rest] = contents;
  if (first?.role === "user") {
    return [{ ...first, parts: [{ text: prompt }, ...(first.parts ?? [])] }, ...rest];
  }
  return [{ role: "user", parts: [{ text: prompt }] }, ...contents];
}

export interface BuildRequestInput {
  model: GoogleModel;
  context: TranscriptContext;
  options: SimpleStreamOptions | undefined;
  projectId: string;
  /** Unix ms for the requestId timestamp segment. */
  now: number;
  placement: SystemPromptPlacement;
}

export interface BuiltRequest {
  envelope: AntigravityStreamEnvelope;
  resolution: RuntimeModelResolution;
  identity: ConversationIdentity;
}

/**
 * Builds the streamGenerateContent envelope. contents and tools come from pi-ai's Gemini
 * converters unchanged (no prompt rewriting); the runtime model id, thinkingConfig and output
 * cap come from the catalog; ids derive from Pi's session id.
 */
export function buildAntigravityRequest(input: BuildRequestInput): BuiltRequest {
  const { model, context, options } = input;
  const resolution = resolveRuntimeModel(model.id, requestedThinkingLevel(model, options));
  const identity = conversationIdentity(options?.sessionId);
  const gemini = resolution.family === "gemini";
  const strict = gemini && supportsGoogleStrictToolSampling(model.id);

  let contents = convertMessages(model, context);
  const systemPrompt = sanitizeSurrogates(getCurrentSystemPrompt(context.messages));
  const placeFirst = input.placement === "first_user_turn" && systemPrompt !== "";
  if (placeFirst) contents = placeInFirstUserTurn(contents, systemPrompt);

  const currentTools = getCurrentTools(context.messages);
  // Every family gets JSON Schema (parametersJsonSchema). Live probes against the service
  // (docs/transport.md): Claude rejects any anyOf sent through the OpenAPI "parameters" field after
  // Google translates it, while parametersJsonSchema passed all 102 choco-pi tool schemas for
  // Claude and GPT-OSS.
  const tools = convertTools(currentTools, false, strict);
  const mode =
    currentTools.length > 0
      ? resolveGoogleFunctionCallingMode(currentTools, requestedToolChoice(options), strict)
      : undefined;

  const stepIndex = context.messages.filter((message) => message.role === "assistant").length;
  const flags = usageFlags(context, resolution.family);
  const labels: AntigravityLabels = {
    cascade_id: identity.conversationId,
    last_step_index: String(stepIndex),
    request_id: `${identity.trajectoryId}-${stepIndex}`,
    root_cascade_id: identity.conversationId,
    trajectory_id: identity.trajectoryId,
    used_claude: flags.usedClaude ? "true" : "false",
    used_claude_conservative: flags.usedClaude ? "true" : "false",
    used_non_gemini_model: flags.usedNonGemini ? "true" : "false",
  };
  if (resolution.modelEnum !== undefined) labels.model_enum = resolution.modelEnum;

  const requestedMax =
    options?.maxTokens !== undefined && options.maxTokens > 0
      ? Math.min(options.maxTokens, resolution.maxOutputTokens)
      : resolution.maxOutputTokens;
  const generationConfig: AntigravityGenerateRequest["generationConfig"] = {
    maxOutputTokens: Math.max(1, clampMaxTokensToContext(model, context, requestedMax)),
  };
  // options.temperature is not forwarded: agy never sends sampling parameters, and Google says
  // Gemini 4 ignores them and rejects out-of-range values with HTTP 400.
  if (resolution.thinkingConfig) generationConfig.thinkingConfig = resolution.thinkingConfig;

  // The capture's key set; JSON key order carries no meaning on this API.
  const request: AntigravityGenerateRequest = {
    contents,
    labels,
    generationConfig,
    sessionId: identity.sessionId,
  };
  if (systemPrompt !== "" && !placeFirst) {
    request.systemInstruction = { role: "user", parts: [{ text: systemPrompt }] };
  }
  if (tools) request.tools = tools;
  if (mode !== undefined) request.toolConfig = { functionCallingConfig: { mode } };

  return {
    envelope: {
      project: input.projectId,
      requestId: `agent/${identity.conversationId}/${input.now}/${identity.trajectoryId}/${stepIndex + 1}`,
      request,
      model: resolution.runtimeId,
      userAgent: "antigravity",
      requestType: "agent",
    },
    resolution,
    identity,
  };
}
