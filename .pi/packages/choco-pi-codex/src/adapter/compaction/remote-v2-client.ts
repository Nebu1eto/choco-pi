import { conditionalProperties, JsonObjectSchema } from "../runtime-values.ts";
import type { JsonObject, BoundaryValue } from "../runtime-values.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  SimpleStreamOptions,
  Transport,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { NativeCompactionRuntime } from "./compaction-runtime.ts";
import { cloneCodexCompactionJson } from "./details-store.ts";
import type { NativeCompactionRequestOptions, ResponsesInputItem } from "./serializer.ts";
import {
  resolveNativeCompactionInputBudget,
  shrinkNativeCompactionRequestForEndpoint,
} from "./request-shrink.ts";
import {
  canonicalCompactionOutput,
  normalizeRemoteCompactionV2PromptInput,
} from "./remote-v2-history.ts";
import { withRemoteCompactionV2Feature } from "../../providers/openai-responses/compaction-v2-feature.ts";
import {
  isResponsesBody,
  type OpenAICodexStreamOptions,
  type ResponsesBody,
  type ServiceTier,
} from "../../providers/openai-codex/types.ts";
import { sleep } from "../../providers/openai-codex/sse.ts";
import { isWebSocketSseFallbackActive } from "../../providers/openai-codex/websocket.ts";
import {
  canonicalCompactionPromptInput,
  canonicalCompactionRequestBody,
} from "../../providers/openai-codex/session-continuity.ts";
import {
  extractAccountId,
  resolveCodexWebSocketUrl,
} from "../../providers/openai-codex/headers.ts";
import type { CodexCompactionDiagnostic } from "./diagnostics.ts";

const MAX_STREAM_RETRIES = 2;
const TerminalCompactionResponseSchema = Type.Object({
  type: Type.Literal("response.completed"),
  response: Type.Object({
    id: Type.String({ minLength: 1 }),
    status: Type.Literal("completed"),
    output: Type.Array(JsonObjectSchema),
    usage: Type.Object({
      input_tokens: Type.Integer({ minimum: 0 }),
      output_tokens: Type.Integer({ minimum: 0 }),
    }),
  }),
});
type V2Stream = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AsyncIterable<AssistantMessageEvent>;

/**
 * What happened to `/compact <focus>`: forwarded in the request, or dropped
 * after the server rejected the focus item (one retry without it). Absent when
 * the caller passed no focus.
 */
export type RemoteCompactionV2Focus = "forwarded" | "ignored";

export type RemoteCompactionV2Result =
  | {
      ok: true;
      compaction: JsonObject;
      responseId: string;
      createdAt: string;
      usage?: RemoteCompactionV2Usage | undefined;
      focus?: RemoteCompactionV2Focus | undefined;
    }
  | {
      ok: false;
      reason:
        | "aborted"
        | "unavailable"
        | "stream-error"
        | "invalid-output"
        | "oversized"
        | "unsupported"
        | "context-overflow";
      errorMessage: string;
      status?: number | undefined;
      retryAfterMs?: number | undefined;
      focus?: RemoteCompactionV2Focus | undefined;
    };

export type RemoteCompactionV2Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  diagnostic?: CodexCompactionDiagnostic | undefined;
};

export type ExecuteRemoteCompactionV2Options = {
  runtime: NativeCompactionRuntime;
  modelRegistry: ModelRegistry;
  context: TranscriptContext;
  promptInput: readonly ResponsesInputItem[];
  requestOptions: NativeCompactionRequestOptions;
  tokensBefore: number;
  sessionId: string;
  signal?: AbortSignal | undefined;
  transport?: Transport | undefined;
  retryDelayMs?: number | undefined;
  promptInputSource?: "canonical" | "reconstructed" | undefined;
  compactionDiagnostic?: CodexCompactionDiagnostic | undefined;
  /** Detached canonical settings: never look up a foreground lane after an await. */
  frozenRequestBody?: ResponsesBody | undefined;
  maxRetries?: number | undefined;
  maxOutputTokens?: number | undefined;
  maxResultBytes?: number | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  /**
   * `/compact <focus>`. When non-blank it is sent as one developer message
   * ("Compaction focus from the user: ...") right before the
   * `compaction_trigger` item; it is part of this request only, never of the
   * prompt input the retained window is built from.
   */
  customInstructions?: string | undefined;
};

/** Largest focus forwarded, in code points (the Anthropic `instructions` cap). */
export const COMPACTION_FOCUS_MAX_CODE_POINTS = 16_384;
const COMPACTION_FOCUS_PREFIX = "Compaction focus from the user: ";

/** The developer message that carries `/compact <focus>`; undefined for a blank focus. */
export function compactionFocusItem(
  customInstructions: string | undefined,
): ResponsesInputItem | undefined {
  const focus = customInstructions?.trim();
  if (!focus) return undefined;
  return {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: `${COMPACTION_FOCUS_PREFIX}${focus}` }],
  };
}

function resolveStream(options: ExecuteRemoteCompactionV2Options): V2Stream | undefined {
  if (options.runtime.codexTransport) {
    // The Codex API implementation is registered once under the stock
    // provider. The runtime model and credentials retain the alias scope.
    const registration = options.modelRegistry.getRegisteredProviderConfig("openai-codex");
    return registration?.api === "openai-codex-responses" && registration.streamSimple
      ? registration.streamSimple
      : undefined;
  }
  const configuredRegistration = options.modelRegistry.getRegisteredProviderConfig(
    options.runtime.provider,
  );
  return options.runtime.api === "openai-responses" &&
    configuredRegistration?.api === "openai-responses" &&
    configuredRegistration.streamSimple
    ? configuredRegistration.streamSimple
    : undefined;
}

function isAborted(signal: AbortSignal | undefined, message: string): boolean {
  return signal?.aborted === true || /request was aborted|\baborted\b/i.test(message);
}

function shouldRetry(result: Extract<RemoteCompactionV2Result, { ok: false }>): boolean {
  if (result.status === 429) return false;
  return !/\b(?:401|403)\b|unauthori[sz]ed|forbidden|usage limit|quota|not included|invalid request|context window|unsupported parameter/i.test(
    result.errorMessage,
  );
}

function compactionUsage(
  message: AssistantMessage,
  diagnostic: CodexCompactionDiagnostic,
): RemoteCompactionV2Usage | undefined {
  const inputTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
  const cachedInputTokens = message.usage.cacheRead;
  const cacheWriteInputTokens = message.usage.cacheWrite;
  const outputTokens = message.usage.output;
  if (
    ![inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  )
    return undefined;
  if (inputTokens + outputTokens === 0) return undefined;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    diagnostic: structuredClone(diagnostic),
  };
}

function diagnosticTransport(transport: Transport | undefined): "websocket" | "sse" {
  return transport === "websocket" || transport === "websocket-cached" ? "websocket" : "sse";
}

function canonicalSessionIdentity(
  options: ExecuteRemoteCompactionV2Options,
): { url: string; accountId: string } | undefined {
  if (
    options.promptInputSource === "reconstructed" ||
    !options.runtime.codexTransport ||
    !options.runtime.apiKey
  )
    return undefined;
  return {
    url: resolveCodexWebSocketUrl(options.runtime.baseUrl),
    accountId: extractAccountId(options.runtime.apiKey),
  };
}

function withCurrentCompactionControls(
  canonicalBody: ResponsesBody,
  currentBody: ResponsesBody,
  requestOptions: NativeCompactionRequestOptions,
): ResponsesBody {
  const {
    // Stored canonical history never carries Daybreak authority; the provider finalizer
    // writes the current request's frozen decision after this payload hook.
    access_programs: _canonicalAccessPrograms,
    client_metadata: _canonicalMetadata,
    reasoning: canonicalReasoning,
    service_tier: _canonicalServiceTier,
    temperature: _canonicalTemperature,
    text: _canonicalText,
    ...historyBody
  } = canonicalBody;
  const currentReasoning = requestOptions.reasoning ?? currentBody.reasoning;
  const parsedCurrentReasoning = Value.Check(JsonObjectSchema, currentReasoning)
    ? currentReasoning
    : {};
  const reasoningContext = canonicalReasoning?.context;
  return {
    ...historyBody,
    text: structuredClone(currentBody.text),
    ...conditionalProperties(Boolean(reasoningContext || currentReasoning), {
      reasoning: {
        ...conditionalProperties(Boolean(reasoningContext), { context: reasoningContext }),
        ...structuredClone(parsedCurrentReasoning),
      },
    }),
    ...conditionalProperties(Boolean(currentBody.service_tier !== undefined), {
      service_tier: currentBody.service_tier,
    }),
    ...conditionalProperties(Boolean(currentBody.temperature !== undefined), {
      temperature: currentBody.temperature,
    }),
    ...conditionalProperties(Boolean(currentBody.client_metadata), {
      client_metadata: structuredClone(currentBody.client_metadata),
    }),
  };
}

type RemoteCompactionV2Failure = Extract<RemoteCompactionV2Result, { ok: false }>;
type AttemptResponse = Parameters<NonNullable<SimpleStreamOptions["onResponse"]>>[0];
type AssistantErrorEvent = Extract<AssistantMessageEvent, { type: "error" }>;
type ProviderPayload = Parameters<NonNullable<SimpleStreamOptions["onPayload"]>>[0];

/** Base delay for the exponential backoff between non-Codex attempts. */
const DEFAULT_RETRY_DELAY_MS = 500;
const MS_PER_SECOND = 1000;

/** What the stream callbacks observed during one attempt. */
interface AttemptObservations {
  readonly outputItems: BoundaryValue[];
  outputBytes: number;
  oversized: boolean;
  responseStatus: number | undefined;
  retryAfterMs: number | undefined;
  sawTerminal: boolean;
  malformedTerminal: boolean;
  terminalResponseId: string | undefined;
  terminalCompaction: JsonObject | undefined;
  expectedBackgroundPayload: ReturnType<typeof cloneCodexCompactionJson>;
  payloadUnsupported: boolean;
  /** The reduced attempt could not shrink the input, so nothing was sent. */
  irreducible: boolean;
}
function createAttemptObservations(): AttemptObservations {
  return {
    outputItems: [],
    outputBytes: 0,
    oversized: false,
    responseStatus: undefined,
    retryAfterMs: undefined,
    sawTerminal: false,
    malformedTerminal: false,
    terminalResponseId: undefined,
    terminalCompaction: undefined,
    expectedBackgroundPayload: undefined,
    payloadUnsupported: false,
    irreducible: false,
  };
}

/**
 * How hard an attempt shrinks its input. The first attempt shrinks only when the
 * host's estimate exceeds the window budget; after the provider reports a context
 * overflow the single retry shrinks by the local estimate to a smaller budget.
 * One record is shared by every attempt of a single compaction, so the reduced
 * retry can tell whether it would only resend the input already rejected.
 */
interface AttemptShrink {
  reduced: boolean;
  /** Serialized input of the last attempt that reached the provider. */
  sentInput: string | undefined;
  /** Input index of the focus item in the last prepared request, when one was appended. */
  focusIndex: number | undefined;
}
/** Share of the window budget the reduced retry targets. */
const REDUCED_BUDGET_PERCENT = 75;

function attemptBudget(options: ExecuteRemoteCompactionV2Options): number | undefined {
  return resolveNativeCompactionInputBudget({
    codexTransport: options.runtime.codexTransport,
    model: options.runtime.model,
    contextWindow: options.runtime.currentModel.contextWindow,
  });
}

/** Provider rejections of an input larger than the model's context window. */
export function isContextOverflowMessage(message: string): boolean {
  return /context_length_exceeded|exceeds? the context window|maximum context length/i.test(
    message,
  );
}

/** Canonical continuation history, when this attempt may use it instead of reconstruction. */
interface CanonicalAttemptSource {
  readonly input: readonly BoundaryValue[] | undefined;
  readonly body: ResponsesBody | undefined;
}
function resolveCanonicalSource(options: ExecuteRemoteCompactionV2Options): CanonicalAttemptSource {
  const identity = options.frozenRequestBody ? undefined : canonicalSessionIdentity(options);
  let input: readonly BoundaryValue[] | undefined;
  if (options.promptInputSource === "canonical") input = options.promptInput;
  else if (options.promptInputSource === undefined && identity)
    input = canonicalCompactionPromptInput(options.sessionId, options.runtime.model, identity);
  const body =
    options.promptInputSource !== "reconstructed" && identity
      ? canonicalCompactionRequestBody(options.sessionId, options.runtime.model, identity)
      : undefined;
  return { input, body };
}

function attemptDiagnostic(options: ExecuteRemoteCompactionV2Options): CodexCompactionDiagnostic {
  const diagnostic = options.compactionDiagnostic ?? {
    inputSource: options.promptInputSource ?? "reconstructed",
    canonicalReplay: "not_applicable" as const,
    checkpointReused: false,
  };
  if (!options.runtime.codexTransport)
    diagnostic.transport = diagnosticTransport(options.transport);
  return diagnostic;
}

function recordOutputItem(
  observed: AttemptObservations,
  maxResultBytes: number | undefined,
  item: BoundaryValue,
): void {
  observed.outputBytes += Buffer.byteLength(JSON.stringify(item), "utf8");
  if (observed.outputBytes > (maxResultBytes ?? Infinity)) observed.oversized = true;
  if (observed.oversized) throw new Error("Responses compaction v2 result exceeds budget");
  observed.outputItems.push(item);
}

/** Retry-After as delta seconds or an HTTP date; undefined when unparseable. */
function parseRetryAfterMs(retryAfter: string): number | undefined {
  const seconds = Number(retryAfter);
  const delay = Number.isFinite(seconds)
    ? seconds * MS_PER_SECOND
    : Date.parse(retryAfter) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}
function recordResponse(observed: AttemptObservations, response: AttemptResponse): void {
  observed.responseStatus = response.status;
  const retryAfter = response.headers["retry-after"];
  if (retryAfter === undefined) return;
  const delay = parseRetryAfterMs(retryAfter);
  if (delay !== undefined) observed.retryAfterMs = delay;
}

async function prepareAttemptPayload(
  options: ExecuteRemoteCompactionV2Options,
  canonical: CanonicalAttemptSource,
  diagnostic: CodexCompactionDiagnostic,
  observed: AttemptObservations,
  shrink: AttemptShrink,
  payload: ProviderPayload,
) {
  if (!isResponsesBody(payload)) throw new Error("Invalid Responses compaction request body");
  let requestBody = payload;
  if (options.frozenRequestBody) requestBody = structuredClone(options.frozenRequestBody);
  else if (canonical.body)
    requestBody = withCurrentCompactionControls(canonical.body, payload, options.requestOptions);
  const promptInput = normalizeRemoteCompactionV2PromptInput(
    canonical.input ?? options.promptInput,
  );
  const budgetTokens = attemptBudget(options);
  const request = await shrinkNativeCompactionRequestForEndpoint(
    {
      model: requestBody.model,
      input: promptInput,
      ...conditionalProperties(Boolean(Value.Check(Type.String(), requestBody.instructions)), {
        instructions: requestBody.instructions,
      }),
      ...conditionalProperties(Boolean(requestBody.tools), { tools: requestBody.tools }),
    },
    {
      budgetTokens:
        shrink.reduced && budgetTokens !== undefined
          ? Math.floor((budgetTokens * REDUCED_BUDGET_PERCENT) / 100)
          : budgetTokens,
      tokensBefore: options.tokensBefore,
      force: shrink.reduced,
    },
  );
  const sentInput = JSON.stringify(request.request.input);
  if (
    shrink.reduced &&
    ((request.rewrittenOutputs === 0 && request.droppedItems === 0) ||
      sentInput === shrink.sentInput)
  ) {
    // Resending the identical input would fail the same way.
    observed.irreducible = true;
    throw new Error("Responses compaction v2 input cannot be reduced below the context window");
  }
  shrink.sentInput = sentInput;
  diagnostic.rewrittenToolOutputs = request.rewrittenOutputs;
  const focusItem = compactionFocusItem(options.customInstructions);
  shrink.focusIndex = focusItem === undefined ? undefined : request.request.input.length;
  const preparedBody = {
    ...requestBody,
    input: [
      ...request.request.input,
      ...(focusItem === undefined ? [] : [focusItem]),
      { type: "compaction_trigger" },
    ],
    ...conditionalProperties(Boolean(!canonical.body && options.requestOptions.reasoning), {
      reasoning: structuredClone(options.requestOptions.reasoning),
    }),
  };
  if (options.frozenRequestBody)
    observed.expectedBackgroundPayload = cloneCodexCompactionJson(preparedBody);
  return preparedBody;
}

/** The provider-finalized body must equal the frozen hook's payload, or the lane sends nothing. */
function matchesFrozenPayload(
  signal: AbortSignal | undefined,
  observed: AttemptObservations,
  body: ResponsesBody,
): boolean {
  const actual = cloneCodexCompactionJson(body);
  const matches =
    !signal?.aborted &&
    observed.expectedBackgroundPayload !== undefined &&
    actual !== undefined &&
    Value.Equal(actual, observed.expectedBackgroundPayload);
  if (!matches) observed.payloadUnsupported = true;
  return matches;
}

function isNativeCompactionItem(item: JsonObject): boolean {
  return item["type"] === "compaction" || item["type"] === "compaction_summary";
}
function observeTerminalEvent<T>(observed: AttemptObservations, event: T): void {
  if (!Value.Check(Type.Object({ type: Type.Literal("response.completed") }), event)) return;
  if (observed.sawTerminal) observed.malformedTerminal = true;
  observed.sawTerminal = true;
  if (!Value.Check(TerminalCompactionResponseSchema, event)) {
    observed.malformedTerminal = true;
    return;
  }
  const nativeItems = event.response.output.filter(isNativeCompactionItem);
  const compaction =
    nativeItems.length === 1 ? canonicalCompactionOutput(nativeItems[0]) : undefined;
  if (!compaction) {
    observed.malformedTerminal = true;
    return;
  }
  observed.terminalCompaction = compaction;
  observed.terminalResponseId = event.response.id;
}

function isSupportedServiceTier(value: string | undefined): value is NonNullable<ServiceTier> {
  return (
    value === "auto" ||
    value === "default" ||
    value === "flex" ||
    value === "priority" ||
    value === "scale"
  );
}

function buildAttemptStreamOptions(
  options: ExecuteRemoteCompactionV2Options,
  canonical: CanonicalAttemptSource,
  diagnostic: CodexCompactionDiagnostic,
  observed: AttemptObservations,
  shrink: AttemptShrink,
): OpenAICodexStreamOptions {
  const serviceTier = Value.Check(Type.String(), options.requestOptions.service_tier)
    ? options.requestOptions.service_tier
    : undefined;
  const textVerbosity = options.requestOptions.text?.verbosity;
  const streamOptions: OpenAICodexStreamOptions = {
    ...conditionalProperties(Boolean(options.runtime.apiKey), { apiKey: options.runtime.apiKey }),
    headers: withRemoteCompactionV2Feature(options.runtime.headers),
    sessionId: options.sessionId,
    ...conditionalProperties(Boolean(options.signal), { signal: options.signal }),
    ...conditionalProperties(Boolean(options.transport), { transport: options.transport }),
    ...conditionalProperties(Boolean(options.runtime.codexTransport), {
      canonicalCompaction: true,
      backgroundCompactionLane: Boolean(options.frozenRequestBody),
    }),
    compactionDiagnostics: diagnostic,
    maxRetries: options.maxRetries ?? (options.runtime.codexTransport ? MAX_STREAM_RETRIES : 0),
    ...conditionalProperties(Boolean(options.fetch), { fetch: options.fetch }),
    ...conditionalProperties(Boolean(textVerbosity), { textVerbosity }),
    onOutputItemDone: (item) => recordOutputItem(observed, options.maxResultBytes, item),
    onResponse: (response) => recordResponse(observed, response),
    onPayload: (payload) =>
      prepareAttemptPayload(options, canonical, diagnostic, observed, shrink, payload),
  };
  if (isSupportedServiceTier(serviceTier)) streamOptions.serviceTier = serviceTier;
  if (options.frozenRequestBody) {
    streamOptions.validateBackgroundCompactionPayload = (body) =>
      matchesFrozenPayload(options.signal, observed, body);
    streamOptions.onProviderStreamEvent = <T>(event: T) => observeTerminalEvent(observed, event);
  }
  return streamOptions;
}

function oversizedFailure(): RemoteCompactionV2Failure {
  return {
    ok: false,
    reason: "oversized",
    errorMessage: "Responses compaction v2 result exceeds budget",
  };
}
function streamErrorFailure(
  options: ExecuteRemoteCompactionV2Options,
  observed: AttemptObservations,
  event: AssistantErrorEvent,
): RemoteCompactionV2Failure {
  if (observed.payloadUnsupported)
    return {
      ok: false,
      reason: "unsupported",
      errorMessage: "Background native request settings drifted",
    };
  if (observed.oversized) return oversizedFailure();
  const message = event.error?.errorMessage || "Responses compaction v2 stream failed";
  const { responseStatus, retryAfterMs } = observed;
  if (
    observed.irreducible ||
    (!isAborted(options.signal, message) && isContextOverflowMessage(message))
  )
    return {
      ok: false,
      reason: "context-overflow",
      errorMessage: message,
      ...conditionalProperties(Boolean(responseStatus !== undefined), { status: responseStatus }),
    };
  return {
    ok: false,
    reason: isAborted(options.signal, message) ? "aborted" : "stream-error",
    errorMessage: message,
    ...conditionalProperties(Boolean(responseStatus !== undefined), { status: responseStatus }),
    ...conditionalProperties(Boolean(retryAfterMs !== undefined), { retryAfterMs }),
  };
}

interface AttemptCompletion {
  readonly completed: AssistantMessage | undefined;
  readonly completedNormally: boolean;
}
async function consumeAttemptStream(
  streamSimple: V2Stream,
  options: ExecuteRemoteCompactionV2Options,
  streamOptions: OpenAICodexStreamOptions,
  observed: AttemptObservations,
): Promise<AttemptCompletion | RemoteCompactionV2Failure> {
  let completed: AssistantMessage | undefined;
  let completedNormally = false;
  for await (const event of streamSimple(
    options.runtime.currentModel,
    options.context,
    streamOptions,
  )) {
    if (event.type === "done") {
      completed = event.message;
      completedNormally = event.reason === "stop" && event.message?.stopReason === "stop";
    }
    if (event.type === "error") return streamErrorFailure(options, observed, event);
  }
  return { completed, completedNormally };
}

/** Frozen-body lanes also require the terminal response to echo exactly the streamed item. */
function matchesFrozenTerminal(
  observed: AttemptObservations,
  completed: AssistantMessage,
  compaction: JsonObject,
): boolean {
  const compactionItems = observed.outputItems.filter(
    (item) => Value.Check(JsonObjectSchema, item) && isNativeCompactionItem(item),
  );
  return (
    compactionItems.length === 1 &&
    observed.sawTerminal &&
    !observed.malformedTerminal &&
    observed.terminalResponseId === completed.responseId &&
    Value.Equal(observed.terminalCompaction, compaction)
  );
}

function finalizeAttempt(
  options: ExecuteRemoteCompactionV2Options,
  observed: AttemptObservations,
  diagnostic: CodexCompactionDiagnostic,
  { completed, completedNormally }: AttemptCompletion,
): RemoteCompactionV2Result {
  if (
    observed.oversized ||
    (completed && completed.usage.output > (options.maxOutputTokens ?? Infinity))
  )
    return oversizedFailure();
  if (!completed?.responseId || !completedNormally) {
    return {
      ok: false,
      reason: "stream-error",
      errorMessage: "Responses compaction v2 stream did not complete normally",
    };
  }
  const { outputItems } = observed;
  const compactions = outputItems
    .map(canonicalCompactionOutput)
    .filter((item) => item !== undefined);
  const compaction = compactions[0];
  if (
    !compaction ||
    compactions.length !== 1 ||
    (options.frozenRequestBody && !matchesFrozenTerminal(observed, completed, compaction))
  ) {
    return {
      ok: false,
      reason: "invalid-output",
      errorMessage: `Responses compaction v2 expected exactly one compaction output item, got ${compactions.length} from ${outputItems.length} output items`,
    };
  }
  return {
    ok: true,
    compaction,
    responseId: completed.responseId,
    createdAt: new Date().toISOString(),
    usage: compactionUsage(completed, diagnostic),
  };
}

async function runAttempt(
  options: ExecuteRemoteCompactionV2Options,
  streamSimple: V2Stream,
  shrink: AttemptShrink,
): Promise<RemoteCompactionV2Result> {
  const observed = createAttemptObservations();
  const diagnostic = attemptDiagnostic(options);
  const canonical = resolveCanonicalSource(options);
  const streamOptions = buildAttemptStreamOptions(options, canonical, diagnostic, observed, shrink);
  const completion = await consumeAttemptStream(streamSimple, options, streamOptions, observed);
  if ("ok" in completion) return completion;
  return finalizeAttempt(options, observed, diagnostic, completion);
}

/** Failures another attempt cannot fix. */
function isFinalFailure(result: RemoteCompactionV2Failure): boolean {
  return (
    result.reason === "aborted" ||
    result.reason === "unavailable" ||
    result.reason === "invalid-output" ||
    result.reason === "oversized" ||
    result.reason === "unsupported" ||
    result.reason === "context-overflow" ||
    !shouldRetry(result)
  );
}
/** False when the caller aborted during the backoff. */
async function backoff(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  try {
    await sleep(delayMs, signal);
    return true;
  } catch {
    return false;
  }
}
async function runAttemptsWithRetry(
  options: ExecuteRemoteCompactionV2Options,
  streamSimple: V2Stream,
  transport: Transport,
  shrink: AttemptShrink,
): Promise<RemoteCompactionV2Result> {
  const maxRetries = options.maxRetries ?? MAX_STREAM_RETRIES;
  const delayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  let lastFailure: RemoteCompactionV2Failure | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await runAttempt({ ...options, transport }, streamSimple, shrink);
    if (result.ok || isFinalFailure(result)) return result;
    lastFailure = result;
    if (attempt < maxRetries && !(await backoff(delayMs * 2 ** attempt, options.signal)))
      return { ok: false, reason: "aborted", errorMessage: "Request was aborted" };
  }
  return (
    lastFailure ?? {
      ok: false,
      reason: "stream-error",
      errorMessage: "Responses compaction v2 failed without a transport attempt",
    }
  );
}

/**
 * After a context overflow, one more attempt with the input shrunk by the local
 * estimate to a smaller budget; it sends nothing when the input cannot shrink
 * past what was already rejected. The retry counts against the caller's retry
 * budget, so a caller that disabled retries (the background lane) gets none.
 */
async function retryReducedAfterOverflow(
  options: ExecuteRemoteCompactionV2Options,
  streamSimple: V2Stream,
  transport: Transport,
  shrink: AttemptShrink,
  first: RemoteCompactionV2Result,
): Promise<RemoteCompactionV2Result> {
  if (
    first.ok ||
    first.reason !== "context-overflow" ||
    (options.maxRetries ?? MAX_STREAM_RETRIES) < 1 ||
    options.signal?.aborted === true ||
    attemptBudget(options) === undefined
  )
    return first;
  shrink.reduced = true;
  return runAttempt({ ...options, transport }, streamSimple, shrink);
}

const ProviderErrorBodySchema = Type.Object(
  {
    error: Type.Object(
      {
        param: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        message: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

/** The fields of a provider JSON error body the focus-rejection check reads. */
interface ProviderErrorFields {
  readonly param: string | undefined;
  readonly message: string | undefined;
}
const NO_PROVIDER_ERROR_FIELDS: ProviderErrorFields = { param: undefined, message: undefined };

/** `error.param` and `error.message` of a JSON error body embedded in the failure text, if any. */
function providerErrorFields(failureText: string): ProviderErrorFields {
  const start = failureText.indexOf("{");
  if (start < 0) return NO_PROVIDER_ERROR_FIELDS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(failureText.slice(start));
  } catch {
    return NO_PROVIDER_ERROR_FIELDS;
  }
  if (!Value.Check(ProviderErrorBodySchema, parsed)) return NO_PROVIDER_ERROR_FIELDS;
  const { param, message } = parsed.error;
  return { param: param ?? undefined, message };
}

/** HTTP statuses that may reject the request body (4xx other than auth and rate limit). */
function isRequestRejectionStatus(status: number | undefined): boolean {
  return (
    status === undefined ||
    (status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429)
  );
}

/**
 * Whether the server rejected the request because of the appended focus item:
 * a 4xx whose JSON `error.param` points at the item's input index, or whose
 * error text names the item index, the developer role or `compaction_trigger`.
 * The Codex transport surfaces only the parsed `error.message`, so the index
 * and role are matched in the text as well.
 */
export function rejectsCompactionFocus(
  result: RemoteCompactionV2Failure,
  focusIndex: number | undefined,
): boolean {
  if (focusIndex === undefined || result.reason !== "stream-error") return false;
  if (!isRequestRejectionStatus(result.status)) return false;
  const fields = providerErrorFields(result.errorMessage);
  const itemPath = `input[${focusIndex}]`;
  if (fields.param === itemPath || fields.param?.startsWith(`${itemPath}.`) === true) return true;
  const text = fields.message ?? result.errorMessage;
  return text.includes(itemPath) || /\bdeveloper\b|compaction_trigger/i.test(text);
}

async function runCompactionRequest(
  options: ExecuteRemoteCompactionV2Options,
  streamSimple: V2Stream,
  initialTransport: Transport,
  shrink: AttemptShrink,
): Promise<RemoteCompactionV2Result> {
  // Codex transports own their retries inside the provider stream.
  const first = options.runtime.codexTransport
    ? await runAttempt({ ...options, transport: initialTransport }, streamSimple, shrink)
    : await runAttemptsWithRetry(options, streamSimple, initialTransport, shrink);
  return retryReducedAfterOverflow(options, streamSimple, initialTransport, shrink, first);
}

function focusTooLong(customInstructions: string | undefined): boolean {
  const focus = customInstructions?.trim() ?? "";
  return [...focus].length > COMPACTION_FOCUS_MAX_CODE_POINTS;
}

export async function executeRemoteCompactionV2(
  options: ExecuteRemoteCompactionV2Options,
): Promise<RemoteCompactionV2Result> {
  const streamSimple = resolveStream(options);
  if (!streamSimple)
    return {
      ok: false,
      reason: "unavailable",
      errorMessage: "No compatible Responses stream is registered for this provider",
    };
  if (focusTooLong(options.customInstructions))
    return {
      ok: false,
      reason: "oversized",
      errorMessage: `Compaction focus exceeds ${COMPACTION_FOCUS_MAX_CODE_POINTS} code points`,
    };
  let initialTransport: Transport =
    options.transport ?? (options.runtime.codexTransport ? "websocket-cached" : "sse");
  if (options.runtime.codexTransport && isWebSocketSseFallbackActive(options.sessionId))
    initialTransport = "sse";
  const shrink: AttemptShrink = { reduced: false, sentInput: undefined, focusIndex: undefined };
  const result = await runCompactionRequest(options, streamSimple, initialTransport, shrink);
  if (compactionFocusItem(options.customInstructions) === undefined) return result;
  if (result.ok) return { ...result, focus: "forwarded" };
  // The background lane keeps its frozen request: a rejected focus is a real
  // failure there, and its coordinator falls back to a lane that honors it.
  if (
    options.frozenRequestBody !== undefined ||
    options.signal?.aborted === true ||
    !rejectsCompactionFocus(result, shrink.focusIndex)
  )
    return result;
  const retry = await runCompactionRequest(
    { ...options, customInstructions: undefined },
    streamSimple,
    initialTransport,
    { reduced: false, sentInput: undefined, focusIndex: undefined },
  );
  return { ...retry, focus: "ignored" };
}
