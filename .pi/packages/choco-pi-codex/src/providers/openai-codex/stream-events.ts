import { processResponsesStream } from "../openai-responses/shared.ts";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";
import {
  CODEX_RESPONSE_STATUSES,
  DEFAULT_MAX_RETRY_DELAY_MS,
  DEFAULT_OVERLOAD_INITIAL_RETRY_DELAY_MS,
  DEFAULT_OVERLOAD_RECOVERY_BUDGET_MS,
  DEFAULT_OVERLOAD_RETRY_DELAY_MS,
  DEFAULT_RATE_LIMIT_RECOVERY_BUDGET_MS,
} from "./constants.ts";
import { isRetryableStreamStatus, isTerminalRateLimitError } from "./errors.ts";
import { applyServiceTierPricing, resolveCodexServiceTier } from "./usage.ts";
import type { CodexStreamEvent, OpenAICodexStreamOptions } from "./types.ts";

const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";
const OVERLOAD_CODEX_ERROR_CODES = new Set(["server_is_overloaded", "slow_down"]);
const RETRYABLE_CODEX_ERROR_CODES = new Set([
  WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE,
  PREVIOUS_RESPONSE_NOT_FOUND_CODE,
  "rate_limit_exceeded",
  "server_is_overloaded",
  "slow_down",
]);
const FATAL_CODEX_ERROR_CODES = new Set([
  "bio_policy",
  "context_length_exceeded",
  "cyber_policy",
  "insufficient_quota",
  "invalid_prompt",
  "invalid_request",
  "invalid_request_error",
  "usage_not_included",
  "usage_limit_reached",
]);

const EventRecordType = Type.Record(Type.String(), Type.Unknown());
type EventRecord = Static<typeof EventRecordType>;
const EventRecordSchema = Type.Unsafe<EventRecord>({ type: "object" });
const StringSchema = Type.String();
const NumberSchema = Type.Number();
const BooleanSchema = Type.Boolean();

interface CodexApiErrorOptions {
  code?: string | undefined;
  payload?: CodexStreamEvent | undefined;
  retryable?: boolean | undefined;
  retryDelayMs?: number | undefined;
  status?: number | undefined;
}

class CodexApiError extends Error {
  readonly code?: string | undefined;
  readonly payload?: CodexStreamEvent | undefined;
  readonly retryable: boolean;
  readonly retryDelayMs?: number | undefined;
  readonly status?: number | undefined;

  constructor(message: string, options?: CodexApiErrorOptions) {
    super(message);
    this.name = "CodexApiError";
    this.code = options?.code;
    this.payload = options?.payload;
    this.retryable = options?.retryable ?? false;
    this.retryDelayMs = options?.retryDelayMs;
    this.status = options?.status;
  }
}

class CodexRetryableStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexRetryableStreamError";
  }
}

export class CodexProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodexProtocolError";
  }
}

export function isRetryableCodexStreamError<T>(error: T): boolean {
  if (error instanceof CodexApiError) return error.retryable;
  return !(error instanceof CodexProtocolError);
}

export function isCodexApiError<T>(error: T): boolean {
  return error instanceof CodexApiError;
}

export function codexStreamRetryDelay<T>(error: T): number | undefined {
  return error instanceof CodexApiError ? error.retryDelayMs : undefined;
}

export function createCodexHttpError(
  message: string,
  code: string | undefined,
  status: number,
): Error {
  const options: CodexApiErrorOptions = {
    status,
    retryable: !(code && FATAL_CODEX_ERROR_CODES.has(code)) && isRetryableStreamStatus(status),
  };
  if (code) options.code = code;
  return new CodexApiError(message, options);
}

export function isCodexOverloadError<T>(error: T): boolean {
  return (
    error instanceof CodexApiError && !!error.code && OVERLOAD_CODEX_ERROR_CODES.has(error.code)
  );
}

export function isCodexRateLimitError<T>(error: T): boolean {
  return error instanceof CodexApiError && error.code === "rate_limit_exceeded";
}

export function codexOverloadRetryDelay<T>(
  error: T,
  retryCount: number,
  waitedMs: number,
): number | undefined {
  if (!isCodexOverloadError(error)) return undefined;
  const remainingMs = Math.max(0, DEFAULT_OVERLOAD_RECOVERY_BUDGET_MS - waitedMs);
  if (remainingMs === 0) return undefined;
  const defaultDelayMs =
    retryCount === 0 ? DEFAULT_OVERLOAD_INITIAL_RETRY_DELAY_MS : DEFAULT_OVERLOAD_RETRY_DELAY_MS;
  const requestedDelayMs = Math.max(defaultDelayMs, codexStreamRetryDelay(error) ?? 0);
  return Math.min(DEFAULT_MAX_RETRY_DELAY_MS, remainingMs, requestedDelayMs);
}

export function codexRateLimitRetryDelay<T>(
  error: T,
  fallbackDelayMs: number,
  waitedMs: number,
): number | undefined {
  if (!isCodexRateLimitError(error)) return undefined;
  const requestedDelayMs = codexStreamRetryDelay(error) ?? fallbackDelayMs;
  const remainingMs = Math.max(0, DEFAULT_RATE_LIMIT_RECOVERY_BUDGET_MS - waitedMs);
  return requestedDelayMs <= remainingMs ? requestedDelayMs : undefined;
}

export function assertSuccessfulCodexOutput(
  output: AssistantMessage,
): asserts output is AssistantMessage & { stopReason: "stop" | "length" | "toolUse" } {
  if (output.stopReason === "pending") {
    throw new CodexRetryableStreamError("Responses stream ended with a pending result");
  }
  if (output.stopReason === "aborted" || output.stopReason === "error") {
    throw new CodexProtocolError(
      output.errorMessage || "Responses stream ended without a successful result",
    );
  }
}

export function assertSuccessfulCodexStatus(
  status: string | undefined,
): asserts status is "completed" {
  if (status === "completed") return;
  if (!status || status === "queued" || status === "in_progress") {
    throw new CodexRetryableStreamError("Responses stream ended with a pending result");
  }
  if (status === "failed" || status === "cancelled") {
    throw new CodexProtocolError("Responses stream ended without a successful result");
  }
  throw new CodexProtocolError(`Unhandled Codex response status: ${status}`);
}

function isRecord<T>(value: T): value is Extract<T, object> & EventRecord {
  return Check(EventRecordSchema, value);
}

function recordStatus(record: EventRecord | undefined): number | undefined {
  const status = record?.["status"] ?? record?.["status_code"] ?? record?.["statusCode"];
  const parsed = Check(StringSchema, status) && /^\d+$/.test(status) ? Number(status) : status;
  return Check(NumberSchema, parsed) && Number.isInteger(parsed) ? parsed : undefined;
}

function eventStatus(event: CodexStreamEvent): number | undefined {
  const eventError = isRecord(event["error"]) ? event["error"] : undefined;
  const response = isRecord(event.response) ? event.response : undefined;
  const responseError = isRecord(response?.["error"]) ? response["error"] : undefined;
  return (
    recordStatus(event) ??
    recordStatus(eventError) ??
    recordStatus(responseError) ??
    recordStatus(response)
  );
}

function isRetryableCodexApiFailure(
  code: string | undefined,
  message: string | undefined,
  status: number | undefined,
  defaultRetryable: boolean,
): boolean {
  if (code === "rate_limit_exceeded" && isTerminalRateLimitError(`${code} ${message ?? ""}`))
    return false;
  if (code && RETRYABLE_CODEX_ERROR_CODES.has(code)) return true;
  if (code && FATAL_CODEX_ERROR_CODES.has(code)) return false;
  if (status !== undefined) return isRetryableStreamStatus(status);
  return defaultRetryable;
}

function codexApiRetryDelayMs(
  code: string | undefined,
  message: string | undefined,
): number | undefined {
  if (
    !code ||
    (code !== "rate_limit_exceeded" && !OVERLOAD_CODEX_ERROR_CODES.has(code)) ||
    !message
  )
    return undefined;
  const match = /try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)/i.exec(message);
  if (!match?.[1] || !match[2]) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  const delayMs = match[2].toLowerCase() === "ms" ? value : value * 1000;
  return Number.isFinite(delayMs) ? delayMs : undefined;
}

interface CodexEventError {
  code?: string | undefined;
  message?: string | undefined;
}

function extractCodexEventError(event: CodexStreamEvent): CodexEventError {
  const nested = isRecord(event["error"]) ? event["error"] : undefined;
  const code =
    event.code ??
    (Check(StringSchema, nested?.["code"])
      ? nested["code"]
      : Check(StringSchema, nested?.["type"])
        ? nested["type"]
        : undefined);
  const message =
    event.message ?? (Check(StringSchema, nested?.["message"]) ? nested["message"] : undefined);
  return { code, message };
}

export async function* mapCodexEvents(
  events: AsyncIterable<CodexStreamEvent>,
  output?: AssistantMessage,
): AsyncIterable<CodexStreamEvent> {
  let sawTerminalResponse = false;
  for await (const event of events) {
    const type = event.type;
    if (!type) continue;

    if (type === "error") {
      const { code, message } = extractCodexEventError(event);
      const status = eventStatus(event);
      const retryDelayMs = codexApiRetryDelayMs(code, message);
      const options: CodexApiErrorOptions = {
        code,
        payload: event,
        retryable: isRetryableCodexApiFailure(code, message, status, true),
      };
      if (retryDelayMs !== undefined) options.retryDelayMs = retryDelayMs;
      if (status !== undefined) options.status = status;
      throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, options);
    }

    if (type === "response.failed") {
      const error = isRecord(event.response?.error) ? event.response.error : undefined;
      const code = Check(StringSchema, error?.["code"])
        ? error["code"]
        : Check(StringSchema, error?.["type"])
          ? error["type"]
          : undefined;
      const message = Check(StringSchema, error?.["message"]) ? error["message"] : undefined;
      const status = eventStatus(event);
      const retryDelayMs = codexApiRetryDelayMs(code, message);
      const options: CodexApiErrorOptions = {
        code,
        payload: event,
        retryable: isRetryableCodexApiFailure(code, message, status, true),
      };
      if (retryDelayMs !== undefined) options.retryDelayMs = retryDelayMs;
      if (status !== undefined) options.status = status;
      throw new CodexApiError(message || "Codex response failed", options);
    }

    if (
      type === "response.done" ||
      type === "response.completed" ||
      type === "response.incomplete"
    ) {
      sawTerminalResponse = true;
      const response = event.response;
      if (output && Check(BooleanSchema, response?.["end_turn"])) {
        output.endTurn = response["end_turn"];
      }
      yield {
        ...event,
        type: "response.completed",
        response: response
          ? { ...response, status: normalizeCodexStatus(response.status) }
          : response,
      };
      return;
    }

    yield event;
  }

  if (!sawTerminalResponse) {
    throw new Error("Stream closed before response.completed");
  }
}

function normalizeCodexStatus(status: string | undefined): string | undefined {
  if (status === undefined) return undefined;
  return CODEX_RESPONSE_STATUSES.has(status) ? status : undefined;
}

function responseStreamOptions<TApi extends Api>(
  options: OpenAICodexStreamOptions | undefined,
  model: Model<TApi>,
): Parameters<typeof processResponsesStream>[4] {
  const streamOptions: Parameters<typeof processResponsesStream>[4] = {
    serviceTier: options?.serviceTier,
    resolveServiceTier: resolveCodexServiceTier,
    applyServiceTierPricing: (usage, serviceTier) =>
      applyServiceTierPricing(usage, serviceTier, model),
  };
  if (options?.grammarToolInputProperties) {
    streamOptions.grammarToolInputProperties = options.grammarToolInputProperties;
  }
  if (options?.onOutputItemDone) streamOptions.onOutputItemDone = options.onOutputItemDone;
  return streamOptions;
}

export async function processMappedCodexResponsesStream<TApi extends Api>(
  events: AsyncIterable<CodexStreamEvent>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<TApi>,
  options: OpenAICodexStreamOptions | undefined,
): Promise<void> {
  await processResponsesStream(
    // SAFETY: mapCodexEvents validates the discriminator and normalizes Codex terminal events to
    // the Responses event names consumed by processResponsesStream before this adapter runs.
    events as AsyncIterable<never>,
    output,
    stream,
    model,
    responseStreamOptions(options, model),
  );
}

export async function processCodexResponsesStream<TApi extends Api>(
  events: AsyncIterable<CodexStreamEvent>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<TApi>,
  options: OpenAICodexStreamOptions | undefined,
): Promise<void> {
  await processMappedCodexResponsesStream(
    mapCodexEvents(events, output),
    output,
    stream,
    model,
    options,
  );
}
