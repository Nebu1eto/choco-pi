import type { Validator } from "@earendil-works/pi-schema";
import { ANTIGRAVITY_ENDPOINTS, buildAntigravityUserAgent } from "../config.ts";
import {
  AntigravityError,
  antigravityErrorFromHttp,
  antigravityMalformedResponse,
  antigravityNetworkError,
  parseRpcErrorBody,
  antigravityErrorFromRpc,
} from "../errors.ts";

/** A JSON request body. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The subset of fetch this client uses; tests inject a fake. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_V1INTERNAL_TIMEOUT_MS = 15_000;

/** Status codes after which the next endpoint is tried instead of failing. */
const FALLBACK_STATUSES: ReadonlySet<number> = new Set([404, 500, 502, 503, 504]);

export interface PostV1InternalOptions<T> {
  token: string;
  /** Validates the decoded 2xx body; a mismatch becomes a malformed_response error. */
  validator: Validator<T>;
  signal?: AbortSignal | undefined;
  /** Per-endpoint attempt deadline. Defaults to 15 s. */
  timeoutMs?: number | undefined;
  fetch?: FetchLike | undefined;
  endpoints?: readonly string[] | undefined;
  userAgent?: string | undefined;
}

/** `<endpoint>/v1internal:<method>` plus an optional query string such as `alt=sse`. */
export function v1InternalUrl(endpoint: string, method: string, query?: string): string {
  const base = `${endpoint.replace(/\/+$/u, "")}/v1internal:${method}`;
  return query ? `${base}?${query}` : base;
}

/** The only headers agy sends on Cloud Code Assist requests (besides transport headers). */
export type AntigravityRequestHeaders = {
  Authorization: string;
  "Content-Type": "application/json";
  "User-Agent": string;
};

export function antigravityHeaders(token: string, userAgent?: string): AntigravityRequestHeaders {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": userAgent ?? buildAntigravityUserAgent(),
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

async function attempt<T>(
  url: string,
  body: string,
  options: PostV1InternalOptions<T>,
  timeoutMs: number,
): Promise<T> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: antigravityHeaders(options.token, options.userAgent),
      body,
      signal,
    });
    text = await response.text();
  } catch (cause) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    if (timeout.aborted) {
      throw antigravityNetworkError(`request timed out after ${timeoutMs}ms`, cause);
    }
    throw antigravityNetworkError(cause instanceof Error ? cause.message : "fetch failed", cause);
  }
  if (!response.ok) {
    throw antigravityErrorFromHttp(response.status, text, response.headers.get("retry-after"));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw antigravityMalformedResponse("response body is not JSON");
  }
  if (options.validator.check(value)) return value;
  const rpc = parseRpcErrorBody(text);
  if (rpc) throw antigravityErrorFromRpc(rpc, { httpStatus: rpc.code });
  throw antigravityMalformedResponse("response body does not match the expected schema");
}

/**
 * POST a v1internal method, walking the endpoints in order. A transport failure, timeout or
 * 404/5xx moves to the next endpoint; any other error is thrown at once. Caller aborts reject
 * with the abort reason. No body, token or Authorization value ever enters an error message.
 */
export async function postV1Internal<T>(
  method: string,
  body: JsonValue,
  options: PostV1InternalOptions<T>,
): Promise<T> {
  const endpoints = options.endpoints ?? ANTIGRAVITY_ENDPOINTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_V1INTERNAL_TIMEOUT_MS;
  const payload = JSON.stringify(body);
  let last: AntigravityError | undefined;
  for (const endpoint of endpoints) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    try {
      return await attempt(v1InternalUrl(endpoint, method), payload, options, timeoutMs);
    } catch (error) {
      if (!(error instanceof AntigravityError)) throw error;
      last = error;
      const fallback =
        error.kind === "network" ||
        (error.status !== undefined && FALLBACK_STATUSES.has(error.status));
      if (!fallback) throw error;
    }
  }
  throw last ?? antigravityNetworkError("no Cloud Code Assist endpoint configured");
}
