import {
  appendAssistantMessageDiagnostic,
  createAssistantMessageDiagnostic,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  getDeclaredTools,
  type Model,
  type TranscriptContext,
  type Transport,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { conditionalProperties } from "../../adapter/runtime-values.ts";
import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import { createGrammarToolInputProperties } from "../constrained-sampling.ts";
import {
  DEFAULT_MAX_RETRY_DELAY_MS,
  DEFAULT_SSE_HEADER_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_RETRIES,
  INITIAL_STREAM_RETRY_DELAY_MS,
  MAX_SSE_REQUEST_RETRIES,
  MAX_STREAM_MAX_RETRIES,
} from "./constants.ts";
import {
  attachCodexUsageLimitDetails,
  createErrorMessage,
  isRetryableRequestStatus,
  isRetryableStreamStatus,
  NonRetryableProviderError,
  parseErrorResponse,
  resolveCodexUsageLimitDetails,
} from "./errors.ts";
import {
  buildSSEHeaders,
  buildWebSocketHeaders,
  createCodexRequestId,
  extractAccountId,
  headersToRecord,
  resolveCodexRequestRouting,
  resolveCodexUrl,
  resolveCodexWebSocketUrl,
} from "./headers.ts";
import { codexDiagnosticsFailure, noThrowCodexDiagnosticsSink } from "./diagnostic-failure.ts";
import { supportsResponsesLiteModel } from "./responses-lite-model.ts";
import { applyResponsesLiteWebSocketMetadata } from "./responses-lite.ts";
import { recordUsageLimitSignal } from "./usage-limit-signal.ts";
import {
  combineAbortSignals,
  compressRequestBodyZstd,
  createSSEHeaderTimeout,
  normalizeTimeoutMs,
  parseSSE,
  sleep,
} from "./sse.ts";
import {
  assertSuccessfulCodexOutput,
  CodexProtocolError,
  codexOverloadRetryDelay,
  codexRateLimitRetryDelay,
  codexStreamRetryDelay,
  createCodexHttpError,
  isCodexApiError,
  isCodexOverloadError,
  isCodexRateLimitError,
  isRetryableCodexStreamError,
  processCodexResponsesStream,
} from "./stream-events.ts";
import {
  CODEX_TURN_STATE_HEADER,
  createCodexTurnState,
  type CodexTurnState,
  withCodexTurnState,
  withCodexTurnStateHeader,
} from "./turn-state.ts";
import type {
  CanonicalHistoryDecision,
  CodexDiagnosticsEvent,
  CodexDiagnosticsLane,
  CodexDiagnosticsSink,
  OpenAICodexStreamOptions,
  ProviderOutputItem,
  ResponsesBody,
} from "./types.ts";
import { createInitialAssistantMessage } from "./types.ts";
import { finalizeUsage } from "./usage.ts";
import {
  isWebSocketSseFallbackActive,
  recordWebSocketSseFallback,
  validateWebSocketTimeoutOptions,
} from "./websocket.ts";
import {
  isPermanentWebSocketError,
  isWebSocketForbiddenError,
  isWebSocketMessageTooBigError,
  isWebSocketUnauthorizedError,
  isWebSocketUpgradeRequiredError,
} from "./websocket-connection.ts";
import { processWebSocketStream } from "./websocket-stream.ts";
import { invalidateCodexDaybreakEntitlement } from "./daybreak-decision.ts";
import { withRemoteCompactionV2Feature } from "../openai-responses/compaction-v2-feature.ts";
import {
  captureCanonicalSessionToken,
  recordCanonicalSessionResponse,
  validateCanonicalSessionRequest,
} from "./session-continuity.ts";

const CompactionTriggerSchema = Type.Object({ type: Type.Literal("compaction_trigger") });
const StringRequestBodySchema = Type.String();

export type CodexProviderRuntimeConfig = Pick<CodexConversionConfig, "openai" | "executionMode"> &
  Partial<Pick<CodexConversionConfig, "compaction">>;

export interface CodexTransportRecoveryDependencies {
  getConfig?: () => CodexProviderRuntimeConfig | undefined;
  useResponsesLite?: (model: Model<Api>) => boolean;
  turnState?: CodexTurnState | undefined;
  onPreparedPayload?: ((payload: ResponsesBody) => void) | undefined;
  onStreamSettled?: () => void | undefined;
  getDiagnostics?: (() => CodexDiagnosticsSink | undefined) | undefined;
  processWebSocketStream?: typeof processWebSocketStream;
  prepareRequestBody: <TApi extends Api>(
    model: Model<TApi>,
    context: TranscriptContext,
    options: OpenAICodexStreamOptions | undefined,
    responsesLite: boolean,
  ) => Promise<ResponsesBody>;
}

function diagnosticsLane(body: ResponsesBody): Exclude<CodexDiagnosticsLane, "prewarm"> {
  return body.input.some((item) => Check(CompactionTriggerSchema, item))
    ? "compaction"
    : "response";
}

function recordUsage(
  record: CodexDiagnosticsSink | undefined,
  lane: Exclude<CodexDiagnosticsLane, "prewarm">,
  transport: "websocket" | "sse",
  output: AssistantMessage,
): void {
  record?.({
    type: "usage",
    lane,
    transport,
    inputTokens: output.usage.input,
    cachedInputTokens: output.usage.cacheRead,
    cacheWriteInputTokens: output.usage.cacheWrite,
    outputTokens: output.usage.output,
  });
}

function codexStreamRetryDelayMs(retryCount: number): number {
  const base = INITIAL_STREAM_RETRY_DELAY_MS * 2 ** Math.max(0, retryCount - 1);
  return Math.min(DEFAULT_MAX_RETRY_DELAY_MS, base * (0.9 + Math.random() * 0.2));
}

function codexStreamMaxRetries(options: OpenAICodexStreamOptions | undefined): number {
  const configured = options?.maxRetries;
  if (configured === undefined) return DEFAULT_STREAM_MAX_RETRIES;
  if (!Number.isFinite(configured) || configured < 0) {
    throw new Error(`Invalid maxRetries: ${String(configured)}`);
  }
  return Math.min(Math.floor(configured), MAX_STREAM_MAX_RETRIES);
}

function rateLimitRecoveryBudgetError<T>(error: T): NonRetryableProviderError {
  const requestedDelayMs = codexStreamRetryDelay(error);
  const detail =
    requestedDelayMs === undefined
      ? ""
      : ` Provider requested a wait of ${Math.ceil(requestedDelayMs / 1000)} seconds.`;
  return new NonRetryableProviderError(
    `Codex throttling exceeded the three-minute automatic recovery window.${detail}`,
  );
}

export function getEffectiveCodexTransport(
  transport: Transport | undefined,
  config: Pick<CodexConversionConfig["openai"], "forceCachedWebSockets"> | undefined,
  sessionId?: string | undefined,
): Transport {
  const configuredTransport = transport ?? "auto";
  const preferredTransport =
    config?.forceCachedWebSockets !== false && configuredTransport === "websocket"
      ? "websocket-cached"
      : configuredTransport;
  return preferredTransport !== "sse" && isWebSocketSseFallbackActive(sessionId)
    ? "sse"
    : preferredTransport;
}

async function openCodexSSE<TApi extends Api>(
  model: Model<TApi>,
  body: string | Uint8Array,
  baseHeaders: Headers,
  options: OpenAICodexStreamOptions | undefined,
  turnState: CodexTurnState | undefined,
): Promise<Response> {
  const requestBody = snapshotCodexSSEBody(body);
  const requestFetch = options?.fetch ?? fetch;
  // The SDK always passes maxRetries; only the isolated background lane narrows the request budget.
  const requestRetries =
    options?.backgroundCompactionLane === true && options.maxRetries !== undefined
      ? Math.min(MAX_SSE_REQUEST_RETRIES, codexStreamMaxRetries(options))
      : MAX_SSE_REQUEST_RETRIES;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= requestRetries; attempt++) {
    if (options?.signal?.aborted) throw new Error("Request was aborted");
    let response: Response;
    try {
      const headerTimeout = createSSEHeaderTimeout(DEFAULT_SSE_HEADER_TIMEOUT_MS);
      const combinedSignal = combineAbortSignals([options?.signal, headerTimeout.signal]);
      try {
        response = await requestFetch(resolveCodexUrl(model.baseUrl), {
          method: "POST",
          headers: withCodexTurnStateHeader(baseHeaders, turnState),
          body: requestBody,
          signal: combinedSignal.signal,
        });
      } catch (error) {
        const timeoutError = headerTimeout.error();
        throw timeoutError && !options?.signal?.aborted ? timeoutError : error;
      } finally {
        combinedSignal.cleanup();
        headerTimeout.clear();
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.message === "Request was aborted")
      ) {
        throw new Error("Request was aborted");
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < requestRetries) {
        await sleep(codexStreamRetryDelayMs(attempt + 1), options?.signal);
        continue;
      }
      throw lastError;
    }

    if (options?.signal?.aborted) throw new Error("Request was aborted");
    if (response.ok) turnState?.capture(response.headers.get(CODEX_TURN_STATE_HEADER));
    await options?.onResponse?.(
      { status: response.status, headers: headersToRecord(response.headers) },
      model,
    );
    if (options?.signal?.aborted) throw new Error("Request was aborted");
    if (response.ok) return response;

    const errorText = await response.text();
    if (options?.signal?.aborted) throw new Error("Request was aborted");
    const info = await parseErrorResponse(
      new Response(errorText, { status: response.status, statusText: response.statusText }),
    );
    if (options?.signal?.aborted) throw new Error("Request was aborted");
    const message = info.friendlyMessage || info.message;
    if (info.code === "server_is_overloaded" || info.code === "slow_down") {
      throw createCodexHttpError(message, info.code, response.status);
    }
    const requestRetryable = isRetryableRequestStatus(response.status);
    if (requestRetryable && attempt < requestRetries) {
      await sleep(codexStreamRetryDelayMs(attempt + 1), options?.signal);
      continue;
    }
    if (info.code)
      throw attachCodexUsageLimitDetails(
        createCodexHttpError(message, info.code, response.status),
        info.usageLimit,
      );
    throw attachCodexUsageLimitDetails(
      isRetryableStreamStatus(response.status)
        ? new Error(message)
        : new NonRetryableProviderError(message),
      info.usageLimit,
    );
  }
  throw lastError ?? new Error("Failed after retries");
}

export function snapshotCodexSSEBody(body: string | Uint8Array): string | Uint8Array<ArrayBuffer> {
  if (Check(StringRequestBodySchema, body)) return body;
  const snapshot = new Uint8Array(body.byteLength);
  snapshot.set(body);
  return snapshot;
}

type ResponseLane = Exclude<CodexDiagnosticsLane, "prewarm">;
type DiagnosticTransport = "websocket" | "sse";

/** Per-stream settings resolved synchronously when the stream is created. */
interface TransportSetup<TApi extends Api> {
  readonly model: Model<TApi>;
  readonly context: TranscriptContext;
  readonly options: OpenAICodexStreamOptions | undefined;
  readonly deps: CodexTransportRecoveryDependencies;
  readonly backgroundLane: boolean;
  readonly turnState: CodexTurnState | undefined;
  readonly responsesLite: boolean;
  readonly preferredTransport: Transport;
  readonly effectiveTransport: Transport;
  readonly effectiveOptions: OpenAICodexStreamOptions;
  readonly daybreakBaseUrl: string;
  readonly stream: AssistantMessageEventStream;
}

/** Mutable state of one running stream across WebSocket and SSE attempts. */
interface TransportRun<TApi extends Api> extends TransportSetup<TApi> {
  output: AssistantMessage;
  readonly diagnostics: CodexDiagnosticsSink | undefined;
  lane: ResponseLane;
  diagnosticsFailureRecorded: boolean;
  usageLimitAccountId: string | undefined;
  streamStarted: boolean;
}

/** The fully prepared request shared by every attempt. */
interface PreparedTransportRequest {
  readonly apiKey: string;
  readonly accountId: string;
  readonly canonicalSessionToken: ReturnType<typeof captureCanonicalSessionToken>;
  readonly reconstructedBody: ResponsesBody;
  readonly body: ResponsesBody;
  readonly canonicalHistory: CanonicalHistoryDecision | undefined;
  readonly baseSseHeaders: Headers;
  readonly websocketHeaders: ReturnType<typeof buildWebSocketHeaders>;
  readonly bodyJson: string;
  readonly websocketBody: ResponsesBody;
  readonly sseBody: string | Uint8Array;
  readonly streamMaxRetries: number;
}

/** Overload and rate-limit waits accumulate across both transports. */
interface RetryBudget {
  overloadRetryCount: number;
  overloadWaitedMs: number;
  rateLimitWaitedMs: number;
}
interface RetryPlan {
  readonly overload: boolean;
  readonly rateLimit: boolean;
  readonly delayMs: number | undefined;
}

function resolveTransportSetup<TApi extends Api>(
  model: Model<TApi>,
  context: TranscriptContext,
  options: OpenAICodexStreamOptions | undefined,
  deps: CodexTransportRecoveryDependencies,
): TransportSetup<TApi> {
  const backgroundLane = options?.backgroundCompactionLane === true;
  const runtimeConfig = backgroundLane ? undefined : deps.getConfig?.();
  const turnState = backgroundLane ? createCodexTurnState() : deps.turnState;
  let responsesLite = false;
  if (!backgroundLane)
    responsesLite =
      deps.useResponsesLite?.(model) ??
      ((runtimeConfig?.executionMode === "code" || runtimeConfig?.executionMode === "notebook") &&
        supportsResponsesLiteModel(model.id));
  const grammarToolInputProperties = createGrammarToolInputProperties(
    getDeclaredTools(context.messages),
    responsesLite,
  );
  const preferredTransport = getEffectiveCodexTransport(options?.transport, runtimeConfig?.openai);
  const effectiveTransport = getEffectiveCodexTransport(
    options?.transport,
    runtimeConfig?.openai,
    options?.sessionId,
  );
  const effectiveOptions: OpenAICodexStreamOptions = options
    ? { ...options, transport: effectiveTransport, grammarToolInputProperties }
    : { transport: effectiveTransport, grammarToolInputProperties };
  effectiveOptions.midTurnSteering =
    !backgroundLane && runtimeConfig?.openai.midTurnSteering === true;
  effectiveOptions.asyncCodeMode =
    !backgroundLane &&
    runtimeConfig?.executionMode === "code" &&
    runtimeConfig.openai.asyncCodeMode === true;
  if (options && runtimeConfig?.compaction?.responsesCompaction) {
    effectiveOptions.headers = withRemoteCompactionV2Feature(options.headers);
  }
  const stream = createAssistantMessageEventStream();
  return {
    model,
    context,
    options,
    deps,
    backgroundLane,
    turnState,
    responsesLite,
    preferredTransport,
    effectiveTransport,
    effectiveOptions,
    daybreakBaseUrl: model.baseUrl,
    stream,
  };
}

function recordTransportFailure<T, TApi extends Api>(
  run: TransportRun<TApi>,
  transport: DiagnosticTransport,
  error: T,
): void {
  if (!run.diagnostics) return;
  run.diagnosticsFailureRecorded = true;
  run.diagnostics({
    type: "failure",
    lane: run.lane,
    transport,
    failure: codexDiagnosticsFailure(error),
  });
}

function pushStreamStart<TApi extends Api>(run: TransportRun<TApi>): void {
  if (run.streamStarted) return;
  run.streamStarted = true;
  run.stream.push({ type: "start", partial: run.output });
}

async function prepareTransportRequest<TApi extends Api>(
  run: TransportRun<TApi>,
): Promise<PreparedTransportRequest> {
  const { model, effectiveOptions, backgroundLane, responsesLite } = run;
  const apiKey = effectiveOptions?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const accountId = extractAccountId(apiKey);
  run.usageLimitAccountId = accountId;
  const canonicalSessionToken = captureCanonicalSessionToken(effectiveOptions?.sessionId);
  const reconstructedBody = await run.deps.prepareRequestBody(
    model,
    run.context,
    effectiveOptions,
    responsesLite,
  );
  effectiveOptions.signal?.throwIfAborted();
  const body = reconstructedBody;
  const canonicalHistory: CanonicalHistoryDecision | undefined =
    effectiveOptions?.canonicalCompaction
      ? "compaction"
      : validateCanonicalSessionRequest(
          effectiveOptions?.sessionId,
          resolveCodexWebSocketUrl(model.baseUrl),
          accountId,
          body,
        );
  run.lane = diagnosticsLane(body);
  if (!backgroundLane) run.deps.onPreparedPayload?.(body);
  effectiveOptions.signal?.throwIfAborted();
  if (backgroundLane && !effectiveOptions.validateBackgroundCompactionPayload?.(body))
    throw new Error("Unsupported background compaction payload drift");
  const websocketRequestId = effectiveOptions?.sessionId || createCodexRequestId();
  const routing = resolveCodexRequestRouting({
    model: body.model,
    serviceTier: body.service_tier === null ? undefined : body.service_tier,
  });
  const turnMetadata = {
    requestKind: "turn" as const,
    model: body.model,
    reasoningEffort: body.reasoning?.effort ?? undefined,
  };
  const baseSseHeaders = buildSSEHeaders(
    model.headers,
    effectiveOptions?.headers,
    accountId,
    apiKey,
    effectiveOptions?.sessionId,
    responsesLite,
    routing.originator,
    routing.routingHint,
    turnMetadata,
  );
  const websocketHeaders = buildWebSocketHeaders(
    model.headers,
    effectiveOptions?.headers,
    accountId,
    apiKey,
    websocketRequestId,
    routing.originator,
    routing.routingHint,
    turnMetadata,
  );
  const bodyJson = JSON.stringify(body);
  const websocketBody = responsesLite ? applyResponsesLiteWebSocketMetadata(body) : body;
  const compressedBody = compressRequestBodyZstd(bodyJson);
  if (compressedBody) baseSseHeaders.set("content-encoding", "zstd");
  const sseBody = compressedBody ?? bodyJson;
  return {
    apiKey,
    accountId,
    canonicalSessionToken,
    reconstructedBody,
    body,
    canonicalHistory,
    baseSseHeaders,
    websocketHeaders,
    bodyJson,
    websocketBody,
    sseBody,
    streamMaxRetries: codexStreamMaxRetries(effectiveOptions),
  };
}

function planRetry<T>(budget: RetryBudget, error: T, retryCount: number): RetryPlan {
  const overload = isCodexOverloadError(error);
  const rateLimit = isCodexRateLimitError(error);
  const fallbackDelayMs = codexStreamRetryDelayMs(retryCount);
  let delayMs: number | undefined;
  if (overload)
    delayMs = codexOverloadRetryDelay(error, budget.overloadRetryCount, budget.overloadWaitedMs);
  else if (rateLimit)
    delayMs = codexRateLimitRetryDelay(error, fallbackDelayMs, budget.rateLimitWaitedMs);
  else delayMs = codexStreamRetryDelay(error) ?? fallbackDelayMs;
  return { overload, rateLimit, delayMs };
}

async function waitBeforeRetry(
  budget: RetryBudget,
  plan: RetryPlan,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (plan.delayMs === undefined) return false;
  await sleep(plan.delayMs, signal);
  if (plan.overload) {
    budget.overloadRetryCount++;
    budget.overloadWaitedMs += plan.delayMs;
  }
  if (plan.rateLimit) budget.rateLimitWaitedMs += plan.delayMs;
  return true;
}

/** Records the retry diagnostic and waits; the caller then starts the next attempt. */
async function retryAfterFailure<T, TApi extends Api>(
  run: TransportRun<TApi>,
  budget: RetryBudget,
  failure: {
    readonly transport: DiagnosticTransport;
    readonly attempt: number;
    readonly error: T;
    readonly plan: RetryPlan;
  },
): Promise<void> {
  const retryEvent: Extract<CodexDiagnosticsEvent, { type: "retry" }> = {
    type: "retry",
    lane: run.lane,
    transport: failure.transport,
    attempt: failure.attempt + 2,
    failure: codexDiagnosticsFailure(failure.error),
  };
  if (failure.plan.delayMs !== undefined) retryEvent.delayMs = failure.plan.delayMs;
  run.diagnostics?.(retryEvent);
  await waitBeforeRetry(budget, failure.plan, run.effectiveOptions?.signal);
}

function requestByteLength(bodyJson: string): number {
  return new TextEncoder().encode(bodyJson).byteLength;
}

async function runWebSocketAttempt<TApi extends Api>(
  run: TransportRun<TApi>,
  request: PreparedTransportRequest,
  attempt: number,
  started: { value: boolean },
): Promise<void> {
  const { model, effectiveOptions, turnState, diagnostics } = run;
  await (run.deps.processWebSocketStream ?? processWebSocketStream)(
    resolveCodexWebSocketUrl(model.baseUrl),
    withCodexTurnState(request.websocketBody, turnState),
    request.websocketHeaders,
    run.output,
    run.stream,
    model,
    request.accountId,
    () => {
      started.value = true;
      pushStreamStart(run);
    },
    effectiveOptions,
    turnState,
    diagnostics ? { lane: run.lane, attempt: attempt + 1, record: diagnostics } : undefined,
    {
      reconstructedRequestBody: request.reconstructedBody,
      token: request.canonicalSessionToken,
      decision: request.canonicalHistory,
    },
  );
  if (effectiveOptions?.signal?.aborted) throw new Error("Request was aborted");
  finalizeUsage(run.output);
  assertSuccessfulCodexOutput(run.output);
  recordUsage(diagnostics, run.lane, "websocket", run.output);
  run.stream.push({ type: "done", reason: run.output.stopReason, message: run.output });
  run.stream.end();
}

function webSocketFallbackReason(
  upgradeRequired: boolean,
  messageTooBig: boolean,
  unauthorized: boolean,
): "upgrade_required" | "message_too_big" | "unauthorized" | "retry_budget_exhausted" {
  if (upgradeRequired) return "upgrade_required";
  if (messageTooBig) return "message_too_big";
  if (unauthorized) return "unauthorized";
  return "retry_budget_exhausted";
}

/** A terminal WebSocket failure that SSE fallback cannot recover. */
function terminalWebSocketError<T, TApi extends Api>(
  run: TransportRun<TApi>,
  error: T,
  websocketStarted: boolean,
): T | NonRetryableProviderError {
  recordTransportFailure(run, "websocket", error);
  if (websocketStarted && !(error instanceof CodexProtocolError) && !isCodexApiError(error)) {
    return new NonRetryableProviderError(
      "Codex stream ended after output began and cannot be continued from its incomplete response.",
    );
  }
  return error;
}

/** Retries in place, throws, or arms SSE fallback ("fallback"). */
async function handleWebSocketFailure<T, TApi extends Api>(
  run: TransportRun<TApi>,
  request: PreparedTransportRequest,
  budget: RetryBudget,
  failure: { readonly error: T; readonly attempt: number; readonly websocketStarted: boolean },
): Promise<"retry" | "fallback"> {
  const { error, attempt, websocketStarted } = failure;
  const { effectiveOptions } = run;
  const unauthorized = isWebSocketUnauthorizedError(error);
  if (unauthorized || isWebSocketForbiddenError(error))
    invalidateCodexDaybreakEntitlement(request.apiKey, run.daybreakBaseUrl);
  if (effectiveOptions?.signal?.aborted) throw error;
  const upgradeRequired = isWebSocketUpgradeRequiredError(error);
  const messageTooBig = isWebSocketMessageTooBigError(error);
  const retryableWebSocketError =
    (isCodexApiError(error) || !isPermanentWebSocketError(error)) &&
    isRetryableCodexStreamError(error);
  const plan = planRetry(budget, error, attempt + 1);
  const overloadBudgetExhausted = plan.overload && plan.delayMs === undefined;
  const rateLimitBudgetExhausted = plan.rateLimit && plan.delayMs === undefined;
  const immediateFallback = upgradeRequired || messageTooBig || unauthorized;
  const fallbackArmed =
    immediateFallback ||
    (retryableWebSocketError && (attempt >= request.streamMaxRetries || overloadBudgetExhausted));
  appendAssistantMessageDiagnostic(
    run.output,
    createAssistantMessageDiagnostic(
      retryableWebSocketError ? "provider_transport_failure" : "provider_stream_failure",
      error,
      {
        configuredTransport: run.preferredTransport,
        ...conditionalProperties(fallbackArmed, { fallbackTransport: "sse" as const }),
        eventsEmitted: websocketStarted,
        phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
        requestBytes: requestByteLength(request.bodyJson),
      },
    ),
  );
  if (
    !immediateFallback &&
    retryableWebSocketError &&
    attempt < request.streamMaxRetries &&
    !overloadBudgetExhausted &&
    !rateLimitBudgetExhausted
  ) {
    await retryAfterFailure(run, budget, { transport: "websocket", attempt, error, plan });
    return "retry";
  }
  if (rateLimitBudgetExhausted) {
    throw rateLimitRecoveryBudgetError(error);
  }
  if (!fallbackArmed) throw terminalWebSocketError(run, error, websocketStarted);
  // Pi supplies resolved request auth, not a force-refresh handle. Keep 401
  // fallback turn-local so refreshed auth can use WebSockets on the next turn.
  if (!unauthorized) recordWebSocketSseFallback(effectiveOptions?.sessionId);
  run.diagnostics?.({
    type: "fallback",
    lane: run.lane,
    from: "websocket",
    to: "sse",
    reason: webSocketFallbackReason(upgradeRequired, messageTooBig, unauthorized),
  });
  run.output = createInitialAssistantMessage(run.model);
  return "fallback";
}

/** True when a WebSocket attempt completed the stream; false when SSE fallback is armed. */
async function runWebSocketAttempts<TApi extends Api>(
  run: TransportRun<TApi>,
  request: PreparedTransportRequest,
  budget: RetryBudget,
): Promise<boolean> {
  validateWebSocketTimeoutOptions(run.effectiveOptions);
  for (let attempt = 0; attempt <= request.streamMaxRetries; attempt++) {
    // Event partials are authoritative snapshots; a fresh partial makes the
    // next content-start replace failed-attempt output without a second message start.
    if (attempt > 0) run.output = createInitialAssistantMessage(run.model);
    const started = { value: false };
    try {
      await runWebSocketAttempt(run, request, attempt, started);
      return true;
    } catch (error) {
      const failure = { error, attempt, websocketStarted: started.value };
      if ((await handleWebSocketFailure(run, request, budget, failure)) === "fallback")
        return false;
    }
  }
  return false;
}

function recordSseRequest<TApi extends Api>(
  run: TransportRun<TApi>,
  request: PreparedTransportRequest,
  attempt: number,
): void {
  const { effectiveOptions } = run;
  const { body } = request;
  if (effectiveOptions?.compactionDiagnostics) {
    Object.assign(effectiveOptions.compactionDiagnostics, {
      transport: "sse",
      continuation: undefined,
      previousResponseId: false,
      fullInputItems: body.input.length,
      sentInputItems: body.input.length,
    });
  }
  const requestEvent: Extract<CodexDiagnosticsEvent, { type: "request" }> = {
    type: "request",
    lane: run.lane,
    transport: "sse",
    attempt: attempt + 1,
    fullInputItems: body.input.length,
    sentInputItems: body.input.length,
    model: body.model,
  };
  if (request.canonicalHistory) requestEvent.canonicalHistory = request.canonicalHistory;
  if (effectiveOptions.compactionDiagnostics) {
    requestEvent.compaction = structuredClone(effectiveOptions.compactionDiagnostics);
  }
  run.diagnostics?.(requestEvent);
}

async function runSseAttempt<TApi extends Api>(
  run: TransportRun<TApi>,
  request: PreparedTransportRequest,
  attempt: number,
  sseIdleTimeoutMs: ReturnType<typeof normalizeTimeoutMs>,
): Promise<void> {
  const { model, effectiveOptions } = run;
  const responseItems: ProviderOutputItem[] = [];
  recordSseRequest(run, request, attempt);
  const response = await openCodexSSE(
    model,
    request.sseBody,
    request.baseSseHeaders,
    effectiveOptions,
    run.turnState,
  );
  if (!response.body) throw new Error("No response body");
  pushStreamStart(run);
  await processCodexResponsesStream(
    parseSSE(response, effectiveOptions?.signal, sseIdleTimeoutMs),
    run.output,
    run.stream,
    model,
    { ...effectiveOptions, onOutputItemDone: (item) => responseItems.push(item) },
  );
  finalizeUsage(run.output);
  if (effectiveOptions?.signal?.aborted) throw new Error("Request was aborted");
  assertSuccessfulCodexOutput(run.output);
  recordUsage(run.diagnostics, run.lane, "sse", run.output);
  for (const item of responseItems) effectiveOptions?.onOutputItemDone?.(item);
  recordCanonicalSessionResponse({
    sessionId: effectiveOptions?.sessionId,
    url: resolveCodexWebSocketUrl(model.baseUrl),
    accountId: request.accountId,
    requestBody: request.body,
    reconstructedRequestBody: request.reconstructedBody,
    responseItems,
    token: request.canonicalSessionToken,
  });
  run.stream.push({ type: "done", reason: run.output.stopReason, message: run.output });
  run.stream.end();
}

/** Retries in place (after waiting) or throws the terminal error. */
async function handleSseFailure<T, TApi extends Api>(
  run: TransportRun<TApi>,
  request: PreparedTransportRequest,
  budget: RetryBudget,
  failure: { readonly error: T; readonly attempt: number },
): Promise<void> {
  const { error, attempt } = failure;
  if (run.effectiveOptions?.signal?.aborted) throw error;
  const retryable =
    !(error instanceof NonRetryableProviderError) && isRetryableCodexStreamError(error);
  const plan = planRetry(budget, error, attempt + 1);
  const overloadBudgetExhausted = plan.overload && plan.delayMs === undefined;
  const rateLimitBudgetExhausted = plan.rateLimit && plan.delayMs === undefined;
  const eventsEmitted = run.output.content.length > 0;
  appendAssistantMessageDiagnostic(
    run.output,
    createAssistantMessageDiagnostic(
      retryable ? "provider_transport_failure" : "provider_stream_failure",
      error,
      {
        configuredTransport: run.preferredTransport,
        eventsEmitted,
        phase: eventsEmitted ? "after_message_stream_start" : "before_message_stream_start",
        requestBytes: requestByteLength(request.bodyJson),
      },
    ),
  );
  if (
    retryable &&
    attempt < request.streamMaxRetries &&
    !overloadBudgetExhausted &&
    !rateLimitBudgetExhausted
  ) {
    await retryAfterFailure(run, budget, { transport: "sse", attempt, error, plan });
    return;
  }
  if (rateLimitBudgetExhausted) {
    throw rateLimitRecoveryBudgetError(error);
  }
  recordTransportFailure(run, "sse", error);
  if (retryable)
    throw new NonRetryableProviderError(
      "Codex stream retry budget was exhausted before a response completed.",
    );
  throw error;
}

async function runSseAttempts<TApi extends Api>(
  run: TransportRun<TApi>,
  request: PreparedTransportRequest,
  budget: RetryBudget,
): Promise<void> {
  const sseIdleTimeoutMs = normalizeTimeoutMs(
    run.effectiveOptions?.timeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    "timeoutMs",
  );
  for (let attempt = 0; attempt <= request.streamMaxRetries; attempt++) {
    if (attempt > 0) run.output = createInitialAssistantMessage(run.model);
    try {
      await runSseAttempt(run, request, attempt, sseIdleTimeoutMs);
      return;
    } catch (error) {
      await handleSseFailure(run, request, budget, { error, attempt });
    }
  }
}

function emitTransportError<T, TApi extends Api>(run: TransportRun<TApi>, error: T): void {
  if (!run.diagnosticsFailureRecorded)
    recordTransportFailure(run, run.effectiveTransport === "sse" ? "sse" : "websocket", error);
  const { effectiveOptions } = run;
  const aborted = !!effectiveOptions?.signal?.aborted;
  const errorMessage = createErrorMessage(run.output, error, aborted);
  const sessionId = effectiveOptions.sessionId;
  const usageLimit = aborted || !sessionId ? undefined : resolveCodexUsageLimitDetails(error);
  // Record before emitting so the extension's message_end handler can drain it.
  if (sessionId && usageLimit)
    recordUsageLimitSignal(sessionId, { ...usageLimit, accountId: run.usageLimitAccountId });
  run.stream.push({
    type: "error",
    reason: aborted ? "aborted" : "error",
    error: errorMessage,
  });
  run.stream.end();
}

async function runCodexTransport<TApi extends Api>(setup: TransportSetup<TApi>): Promise<void> {
  const run: TransportRun<TApi> = {
    ...setup,
    output: createInitialAssistantMessage(setup.model),
    diagnostics: noThrowCodexDiagnosticsSink(setup.deps.getDiagnostics?.()),
    lane: "response",
    diagnosticsFailureRecorded: false,
    usageLimitAccountId: undefined,
    streamStarted: false,
  };
  try {
    const request = await prepareTransportRequest(run);
    const budget: RetryBudget = {
      overloadRetryCount: 0,
      overloadWaitedMs: 0,
      rateLimitWaitedMs: 0,
    };
    const transport = run.effectiveOptions.transport ?? "auto";
    if (transport !== "sse" && (await runWebSocketAttempts(run, request, budget))) return;
    await runSseAttempts(run, request, budget);
  } catch (error) {
    emitTransportError(run, error);
  } finally {
    run.deps.onStreamSettled?.();
  }
}

export function createCodexTransportStream<TApi extends Api>(
  model: Model<TApi>,
  context: TranscriptContext,
  options: OpenAICodexStreamOptions | undefined,
  deps: CodexTransportRecoveryDependencies,
): AssistantMessageEventStream {
  const setup = resolveTransportSetup(model, context, options, deps);
  void runCodexTransport(setup);
  return setup.stream;
}
