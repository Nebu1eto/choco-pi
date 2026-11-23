import { setTimeout as delay } from "node:timers/promises";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, hasApi } from "@earendil-works/pi-ai";
import { parseAntigravityApiKey } from "../auth/oauth.ts";
import { antigravityHeaders, v1InternalUrl } from "../client/http.ts";
import type { FetchLike } from "../client/http.ts";
import { DEFAULT_ANTIGRAVITY_ENDPOINT, PROVIDER_ID, SIGN_IN_HINT } from "../config.ts";
import {
  AntigravityError,
  antigravityErrorFromHttp,
  antigravityMalformedResponse,
  antigravityNetworkError,
  formatAntigravityErrorMessage,
} from "../errors.ts";
import { ResponseAccumulator, zeroUsage } from "./accumulator.ts";
import { parseJsonBody, parseStreamChunk } from "./chunks.ts";
import {
  ENV_SYSTEM_PROMPT_PLACEMENT,
  buildAntigravityRequest,
  systemPromptPlacement,
} from "./request.ts";
import type { GoogleModel } from "./request.ts";
import { SseParser } from "./sse.ts";

export const DEFAULT_HEADER_TIMEOUT_MS = 90_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_TRANSPORT_RETRIES = 1;
export const MAX_TRANSPORT_RETRIES = 2;
export const MAX_TRANSPORT_RETRY_DELAY_MS = 5_000;
const BASE_RETRY_DELAY_MS = 1_000;
const RESERVED_HEADERS = new Set(["authorization", "content-type", "user-agent", "host"]);

export interface AntigravityStreamDeps {
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  headerTimeoutMs?: number;
  idleTimeoutMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
}

function abortError(): Error {
  return new DOMException("Request was aborted", "AbortError");
}

const defaultSleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  delay(ms, undefined, { signal });

function emptyMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: PROVIDER_ID,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function requestHeaders(token: string, ...sources: (ProviderHeaders | undefined)[]): Headers {
  const headers = new Headers(antigravityHeaders(token));
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
  }
  return headers;
}

function headerRecord(headers: Headers) {
  return Object.fromEntries(headers.entries());
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      reader.cancel().catch(() => undefined);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      cancel();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      cancel();
      reject(antigravityNetworkError(`stream stalled: no data for ${idleTimeoutMs}ms`));
    }, idleTimeoutMs);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().finally(cleanup).then(resolve, reject);
  });
}

function retryDelayFor(
  error: AntigravityError,
  attempt: number,
  maxRetries: number,
  maxDelayMs: number,
): number | undefined {
  if (!error.retryable || attempt >= maxRetries) return undefined;
  const wait = error.retryAfterMs ?? BASE_RETRY_DELAY_MS * 2 ** attempt;
  return wait <= maxDelayMs ? wait : undefined;
}

interface AttemptContext {
  url: string;
  body: string;
  headers: Headers;
  fetch: FetchLike;
  model: GoogleModel;
  options: SimpleStreamOptions | undefined;
  accumulator: ResponseAccumulator;
  headerTimeoutMs: number;
  idleTimeoutMs: number;
  now: () => number;
}

async function readBodyText(
  response: Response,
  signal: AbortSignal,
  outer: AbortSignal | undefined,
  idleTimeoutMs: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await readChunk(reader, signal, idleTimeoutMs);
      } catch (cause) {
        if (outer?.aborted) throw abortError();
        if (cause instanceof AntigravityError) throw cause;
        throw antigravityNetworkError("response body could not be read", cause);
      }
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function attemptOnce(run: AttemptContext): Promise<void> {
  const outer = run.options?.signal;
  const controller = new AbortController();
  const forward = () => controller.abort(outer?.reason);
  if (outer?.aborted) throw abortError();
  outer?.addEventListener("abort", forward, { once: true });
  let headerTimedOut = false;
  let finished = false;
  let response: Response | undefined;
  const headerTimer = setTimeout(() => {
    headerTimedOut = true;
    controller.abort();
  }, run.headerTimeoutMs);
  try {
    try {
      response = await run.fetch(run.url, {
        method: "POST",
        headers: run.headers,
        body: run.body,
        signal: controller.signal,
      });
    } catch (cause) {
      if (outer?.aborted) throw abortError();
      if (headerTimedOut) {
        throw antigravityNetworkError(`no response within ${run.headerTimeoutMs}ms`, cause);
      }
      throw antigravityNetworkError(cause instanceof Error ? cause.message : "fetch failed", cause);
    } finally {
      clearTimeout(headerTimer);
    }
    await run.options?.onResponse?.(
      { status: response.status, headers: headerRecord(response.headers) },
      run.model,
    );
    if (outer?.aborted) throw abortError();
    if (!response.ok) {
      const text = await readBodyText(response, controller.signal, outer, run.idleTimeoutMs);
      if (outer?.aborted) throw abortError();
      finished = true;
      throw antigravityErrorFromHttp(
        response.status,
        text,
        response.headers.get("retry-after"),
        run.now(),
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/event-stream/iu.test(contentType)) {
      const text = await readBodyText(response, controller.signal, outer, run.idleTimeoutMs);
      if (outer?.aborted) throw abortError();
      finished = true;
      for (const chunk of parseJsonBody(text)) {
        await run.options?.onProviderStreamEvent?.(chunk, run.model);
        run.accumulator.apply(chunk);
      }
      return;
    }
    if (!response.body) throw antigravityMalformedResponse("event stream has no body");
    run.accumulator.start();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const handle = async (data: string) => {
      if (data.trim() === "" || data.trim() === "[DONE]") return;
      const chunk = parseStreamChunk(data);
      await run.options?.onProviderStreamEvent?.(chunk, run.model);
      run.accumulator.apply(chunk);
    };
    try {
      for (;;) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await readChunk(reader, controller.signal, run.idleTimeoutMs);
        } catch (cause) {
          if (outer?.aborted) throw abortError();
          if (cause instanceof AntigravityError) throw cause;
          throw antigravityNetworkError("event stream interrupted", cause);
        }
        if (result.done) break;
        for (const event of parser.push(decoder.decode(result.value, { stream: true }))) {
          await handle(event.data);
        }
      }
      for (const event of [...parser.push(decoder.decode()), ...parser.end()]) {
        await handle(event.data);
      }
      finished = true;
    } finally {
      if (!finished) reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } finally {
    clearTimeout(headerTimer);
    outer?.removeEventListener("abort", forward);
    if (!finished) {
      if (response?.body && !response.body.locked) response.body.cancel().catch(() => undefined);
      controller.abort();
    }
  }
}

export function streamGoogleAntigravityWith(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  deps: AntigravityStreamDeps,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output = emptyMessage(model);
  const signal = options?.signal;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const headerTimeoutMs = deps.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
  const idleTimeoutMs = deps.idleTimeoutMs ?? options?.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxRetries = Math.min(
    Math.max(0, options?.maxRetries ?? DEFAULT_TRANSPORT_RETRIES),
    MAX_TRANSPORT_RETRIES,
  );
  const maxDelayMs =
    options?.maxRetryDelayMs !== undefined && options.maxRetryDelayMs > 0
      ? Math.min(options.maxRetryDelayMs, MAX_TRANSPORT_RETRY_DELAY_MS)
      : MAX_TRANSPORT_RETRY_DELAY_MS;
  const placement = systemPromptPlacement(
    options?.env?.[ENV_SYSTEM_PROMPT_PLACEMENT] ??
      (deps.env ?? process.env)[ENV_SYSTEM_PROMPT_PLACEMENT],
  );
  const fetchImpl: FetchLike = options?.fetch ?? globalThis.fetch;
  let settled = false;
  const settle = (event: "done" | "error") => {
    if (settled) return;
    settled = true;
    if (
      event === "done" &&
      (output.stopReason === "stop" ||
        output.stopReason === "length" ||
        output.stopReason === "toolUse")
    ) {
      stream.push({ type: "done", reason: output.stopReason, message: output });
    } else {
      const reason = output.stopReason === "aborted" ? "aborted" : "error";
      output.stopReason = reason;
      stream.push({ type: "error", reason, error: output });
    }
    stream.end();
  };

  const run = async (): Promise<void> => {
    if (!hasApi(model, "google-generative-ai")) {
      throw new AntigravityError({
        kind: "invalid_request",
        detail: `model api ${model.api} is not served by the Google Antigravity transport`,
      });
    }
    if (!options?.apiKey) {
      throw new AntigravityError({
        kind: "auth",
        detail: `no Google Antigravity credential; ${SIGN_IN_HINT}`,
      });
    }
    const { token, projectId } = parseAntigravityApiKey(options.apiKey);
    const built = buildAntigravityRequest({
      model,
      context,
      options,
      projectId,
      now: now(),
      placement,
    });
    if (built.resolution.level !== undefined) output.providerThinkingLevel = built.resolution.level;
    const replacement = await options.onPayload?.(built.envelope, model);
    if (signal?.aborted) throw abortError();
    const body = JSON.stringify(replacement === undefined ? built.envelope : replacement) ?? "";
    if (body === "") {
      throw new AntigravityError({
        kind: "invalid_request",
        detail: "onPayload returned a value that does not serialize to JSON",
      });
    }
    const accumulator = new ResponseAccumulator(output, stream, model);
    const attempt: AttemptContext = {
      url: v1InternalUrl(
        model.baseUrl || DEFAULT_ANTIGRAVITY_ENDPOINT,
        "streamGenerateContent",
        "alt=sse",
      ),
      body,
      headers: requestHeaders(token, model.headers, options.headers),
      fetch: fetchImpl,
      model,
      options,
      accumulator,
      headerTimeoutMs,
      idleTimeoutMs,
      now,
    };
    for (let retry = 0; ; retry += 1) {
      try {
        await attemptOnce(attempt);
        break;
      } catch (error) {
        if (signal?.aborted || accumulator.emittedContent) throw error;
        if (!(error instanceof AntigravityError)) throw error;
        const wait = retryDelayFor(error, retry, maxRetries, maxDelayMs);
        if (wait === undefined) throw error;
        accumulator.resetAttempt();
        await sleep(wait, signal);
        if (signal?.aborted) throw abortError();
      }
    }
    accumulator.close();
    if (signal?.aborted) throw abortError();
    if (output.stopReason === "pending") {
      throw antigravityNetworkError("event stream ended before a finish reason");
    }
    if (output.stopReason === "error") {
      throw new AntigravityError({
        kind: "invalid_request",
        detail: `the model stopped with finish reason ${output.rawStopReason ?? "unknown"}`,
      });
    }
  };

  const settleRun = async (): Promise<void> => {
    try {
      await run();
    } catch (error) {
      output.stopReason = signal?.aborted ? "aborted" : "error";
      if (signal?.aborted) output.errorMessage = "Request was aborted";
      else if (error instanceof AntigravityError) output.errorMessage = error.message;
      else {
        output.errorMessage = formatAntigravityErrorMessage({
          kind: "malformed_response",
          detail: error instanceof Error ? error.message : "unexpected transport failure",
        });
      }
      settle("error");
      return;
    }
    settle("done");
  };
  void settleRun();
  return stream;
}

export function streamGoogleAntigravity(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return streamGoogleAntigravityWith(model, context, options, {});
}
