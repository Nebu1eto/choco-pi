import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { DEFAULT_SYNTHETIC_API_BASE_URL, syntheticUtilityApiUrl } from "./utility-api.ts";
import { authHeaders, combineWithTimeout, isTimeoutReason, parseErrorMessage } from "./utils.ts";

export const DEFAULT_COUNT_TOKENS_TIMEOUT_MS = 3000;
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_ERROR_MESSAGE_CHARS = 500;

export const CountTokensResponseSchema = Type.Object({
  input_tokens: Type.Integer({ minimum: 0 }),
});

export type CountTokensResponse = Static<typeof CountTokensResponseSchema>;

export type CountTokensErrorCode =
  | "auth"
  | "quota"
  | "rate-limit"
  | "timeout"
  | "aborted"
  | "malformed"
  | "http"
  | "network";

export type CountTokensResult =
  | { ok: true; inputTokens: number }
  | { ok: false; code: CountTokensErrorCode; status?: number; message: string };

export interface CountSyntheticTokensOptions {
  apiKey: string;
  /** Synthetic model ID, e.g. `hf:zai-org/GLM-5.3`. */
  model: string;
  system: string;
  promptText: string;
  /**
   * Synthetic API root, OpenAI-compatible base (`.../openai/v1`), Anthropic-compatible
   * base (`.../anthropic/v1`), or a utility-API proxy root. Defaults to the Synthetic API.
   */
  baseUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const COMPAT_SUFFIX = /\/(?:openai|anthropic)(?:\/v1)?$/;

/**
 * Map any accepted Synthetic base URL to its Anthropic-compatible base on the same origin
 * and path prefix. Throws on an invalid URL or non-http(s) protocol (programmer error).
 */
export function resolveSyntheticAnthropicBaseUrl(baseUrl?: string): string {
  const raw = baseUrl?.trim() || DEFAULT_SYNTHETIC_API_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`countSyntheticTokens: invalid baseUrl ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("countSyntheticTokens: baseUrl must use http or https");
  }
  const root = `${url.origin}${url.pathname}`.replace(/\/+$/, "").replace(COMPAT_SUFFIX, "");
  return `${root}/anthropic/v1`;
}

function truncate(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_CHARS
    ? `${message.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
    : message;
}

function errorCodeForStatus(status: number): CountTokensErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate-limit";
  return "http";
}

/**
 * Count input tokens for a single-user-message summarization prompt via Synthetic's
 * Anthropic-compatible `POST /messages/count_tokens`. Provider, network, timeout, and
 * abort failures resolve to `{ ok: false }`; only missing apiKey/model or an invalid
 * baseUrl/timeoutMs throw.
 */
export async function countSyntheticTokens(
  options: CountSyntheticTokensOptions,
): Promise<CountTokensResult> {
  const { apiKey, model, system, promptText } = options;
  if (!apiKey?.trim()) {
    throw new TypeError("countSyntheticTokens: apiKey is required");
  }
  if (!model?.trim()) {
    throw new TypeError("countSyntheticTokens: model is required");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_COUNT_TOKENS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("countSyntheticTokens: timeoutMs must be a positive finite number");
  }
  const url = syntheticUtilityApiUrl(
    resolveSyntheticAnthropicBaseUrl(options.baseUrl),
    "/messages/count_tokens",
  );
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const callerSignal = options.signal;

  if (callerSignal?.aborted) {
    return { ok: false, code: "aborted", message: "Request cancelled" };
  }

  const signal = combineWithTimeout(callerSignal, timeoutMs);
  const failure = (networkMessage: string): CountTokensResult => {
    if (callerSignal?.aborted) {
      return { ok: false, code: "aborted", message: "Request cancelled" };
    }
    if (signal.aborted && isTimeoutReason(signal.reason)) {
      return { ok: false, code: "timeout", message: `Request timed out after ${timeoutMs}ms` };
    }
    return { ok: false, code: "network", message: truncate(networkMessage) };
  };

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        "x-api-key": apiKey,
        ...authHeaders(apiKey),
      },
      body: JSON.stringify({
        model,
        system,
        messages: [{ role: "user", content: [{ type: "text", text: promptText }] }],
      }),
      signal,
    });
  } catch (err: unknown) {
    return failure(err instanceof Error ? err.message : "Network request failed");
  }

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    if (callerSignal?.aborted || signal.aborted) return failure("Request aborted");
    return {
      ok: false,
      code: errorCodeForStatus(response.status),
      status: response.status,
      message: truncate(message || `HTTP ${response.status}`),
    };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err: unknown) {
    return failure(err instanceof Error ? err.message : "Failed to read response body");
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      ok: false,
      code: "malformed",
      status: response.status,
      message: "Synthetic count_tokens returned non-JSON body",
    };
  }
  if (!Value.Check(CountTokensResponseSchema, data)) {
    return {
      ok: false,
      code: "malformed",
      status: response.status,
      message: "Synthetic count_tokens response is missing a non-negative integer input_tokens",
    };
  }
  return { ok: true, inputTokens: data.input_tokens };
}
