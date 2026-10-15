/**
 * Provider prompt token counters for background compaction admission.
 *
 * Selected by the owner model's provider: Synthetic and Anthropic expose a
 * free `messages/count_tokens` endpoint; every other provider is uncounted
 * and admission keeps its estimate. A counter never throws: every failure
 * resolves to undefined plus a short `count-tokens: <code>` diagnostic.
 */
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  type CountTokensErrorCode,
  type CountTokensResult,
  countSyntheticTokens,
} from "../../../choco-pi-provider-synthetic/src/client/count-tokens.ts";
import { authModeOf, normalizeBaseUrl } from "../anthropic/capability.ts";
import type { TokenCounter } from "../background/contract.ts";

/** Upper bound on one count request; an 800k-char Synthetic body took ~4 s. */
export const COUNT_TOKENS_TIMEOUT_MS = 10_000;
/** How long a deterministic failure (5xx, malformed, auth) suppresses requests for one model. */
export const COUNT_TOKENS_NEGATIVE_TTL_MS = 600_000;

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
const CountTokensResponseSchema = Type.Object({ input_tokens: Type.Integer({ minimum: 0 }) });

type CountInput = Parameters<TokenCounter["countTokens"]>[0];
/** The registry slice a counter reads: request auth for the owner model. */
export type CountRegistry = Pick<ExtensionContext["modelRegistry"], "getApiKeyAndHeaders">;
type CountFailure = Extract<CountTokensResult, { ok: false }>;

/** Negative results keyed by `provider|baseUrl|model`; shareable across counters. */
export type CountTokensNegativeCache = Map<
  string,
  { readonly expiresAt: number; readonly detail: string }
>;

export interface ProviderTokenCounterOptions {
  readonly registry: CountRegistry;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly cache?: CountTokensNegativeCache;
}

interface CountContext {
  readonly registry: CountRegistry;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs: number;
}

/** One count attempt: a token figure, or a diagnostic and whether it is worth caching. */
type CountOutcome =
  | { readonly tokens: number }
  | { readonly detail: string; readonly cache: boolean }
  | { readonly skipped: true };

function failureDetail(failure: Pick<CountFailure, "code" | "status">): string {
  return failure.status === undefined
    ? `count-tokens: ${failure.code}`
    : `count-tokens: ${failure.code} ${failure.status}`;
}

/** Deterministic failures repeat on retry; transient ones (timeout, network, 429) do not. */
function cacheable(failure: Pick<CountFailure, "code" | "status">): boolean {
  if (failure.code === "malformed" || failure.code === "auth") return true;
  return failure.code === "http" && failure.status !== undefined && failure.status >= 500;
}

function fromResult(result: CountTokensResult): CountOutcome {
  if (result.ok) return { tokens: result.inputTokens };
  return { detail: failureDetail(result), cache: cacheable(result) };
}

function errorCodeForStatus(status: number): CountTokensErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate-limit";
  return "http";
}

/** Registry headers (null drops a header) under the count request's own fixed headers. */
function anthropicHeaders(auth: AnthropicAuth): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (value !== null) headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  headers.set("anthropic-version", ANTHROPIC_VERSION);
  headers.set("x-api-key", auth.apiKey);
  return headers;
}

/**
 * `{base}/v1/messages/count_tokens`, tolerating a base that already ends in
 * `/v1`; undefined for an unparsable or non-http(s) base URL.
 */
function anthropicCountUrl(baseUrl: string): string | undefined {
  const raw = baseUrl.trim() || ANTHROPIC_DEFAULT_BASE_URL;
  const url = URL.parse(raw);
  if (url === null) return undefined;
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const root = normalizeBaseUrl(`${url.origin}${url.pathname}`).replace(/\/v1$/u, "");
  return `${root}/v1/messages/count_tokens`;
}

function timedSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function transportFailure(caller: AbortSignal, combined: AbortSignal): CountOutcome {
  if (caller.aborted) return { detail: "count-tokens: aborted", cache: false };
  if (combined.aborted) return { detail: "count-tokens: timeout", cache: false };
  return { detail: "count-tokens: network", cache: false };
}

async function countSynthetic(
  context: CountContext,
  input: CountInput,
  apiKey: string,
  baseUrl: string,
): Promise<CountOutcome> {
  return fromResult(
    await countSyntheticTokens({
      apiKey,
      model: input.model.id,
      system: input.system,
      promptText: input.promptText,
      baseUrl,
      fetch: context.fetch,
      signal: input.signal,
      timeoutMs: context.timeoutMs,
    }),
  );
}

interface AnthropicAuth {
  readonly apiKey: string;
  readonly headers: ProviderHeaders | undefined;
}

async function countAnthropic(
  context: CountContext,
  input: CountInput,
  auth: AnthropicAuth,
  baseUrl: string,
): Promise<CountOutcome> {
  const url = anthropicCountUrl(baseUrl);
  if (url === undefined) return { detail: "count-tokens: invalid-base-url", cache: true };
  const signal = timedSignal(input.signal, context.timeoutMs);
  let response: Response;
  try {
    response = await context.fetch(url, {
      method: "POST",
      headers: anthropicHeaders(auth),
      body: JSON.stringify({
        model: input.model.id,
        system: input.system,
        messages: [{ role: "user", content: [{ type: "text", text: input.promptText }] }],
      }),
      signal,
    });
  } catch {
    return transportFailure(input.signal, signal);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const failure = { code: errorCodeForStatus(response.status), status: response.status };
    return { detail: failureDetail(failure), cache: cacheable(failure) };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return transportFailure(input.signal, signal);
  }
  return parseAnthropicCount(text, response.status);
}

function parseAnthropicCount(text: string, status: number): CountOutcome {
  const malformed = { detail: failureDetail({ code: "malformed", status }), cache: true };
  let data: ReturnType<typeof JSON.parse>;
  try {
    data = JSON.parse(text);
  } catch {
    return malformed;
  }
  return Value.Check(CountTokensResponseSchema, data) ? { tokens: data.input_tokens } : malformed;
}

async function countFor(context: CountContext, input: CountInput): Promise<CountOutcome> {
  const provider = input.model.provider;
  if (provider !== "synthetic" && provider !== "anthropic") return { skipped: true };
  const auth = await context.registry.getApiKeyAndHeaders(input.model);
  if (!auth.ok) return { detail: "count-tokens: auth-unresolved", cache: false };
  const apiKey = auth.apiKey?.trim() ?? "";
  if (apiKey.length === 0) return { detail: "count-tokens: no-api-key", cache: false };
  const baseUrl = auth.baseUrl ?? input.model.baseUrl;
  if (provider === "synthetic") return countSynthetic(context, input, apiKey, baseUrl);
  // Bearer/OAuth tokens are not accepted as `x-api-key`; leave them uncounted.
  if (authModeOf(apiKey) !== "api-key") return { skipped: true };
  return countAnthropic(context, input, { apiKey, headers: auth.headers }, baseUrl);
}

function cacheKey(model: Model<Api>): string {
  return [model.provider, normalizeBaseUrl(model.baseUrl), model.id].join("|");
}

/**
 * Counter for Synthetic and Anthropic owner models; undefined for every other
 * provider, without network. Deterministic failures are remembered per
 * `provider|baseUrl|model` for {@link COUNT_TOKENS_NEGATIVE_TTL_MS}.
 */
export function createProviderTokenCounter(options: ProviderTokenCounterOptions): TokenCounter {
  const now = options.now ?? Date.now;
  const cache: CountTokensNegativeCache = options.cache ?? new Map();
  const context: CountContext = {
    registry: options.registry,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? COUNT_TOKENS_TIMEOUT_MS,
  };
  return {
    async countTokens(input) {
      const report = (detail: string): void => {
        try {
          input.onDiagnostic?.(detail);
        } catch {
          // A diagnostic sink never decides admission.
        }
      };
      if (input.signal.aborted) return undefined;
      const key = cacheKey(input.model);
      const cached = cache.get(key);
      if (cached !== undefined) {
        if (cached.expiresAt > now()) {
          report(`${cached.detail} (cached)`);
          return undefined;
        }
        cache.delete(key);
      }
      let outcome: CountOutcome;
      try {
        outcome = await countFor(context, input);
      } catch {
        // Invalid base URL or a registry failure: a configuration problem, not transient.
        outcome = { detail: "count-tokens: error", cache: true };
      }
      if ("tokens" in outcome) return outcome.tokens;
      if ("skipped" in outcome) return undefined;
      if (outcome.cache && !input.signal.aborted) {
        cache.set(key, { expiresAt: now() + COUNT_TOKENS_NEGATIVE_TTL_MS, detail: outcome.detail });
      }
      report(outcome.detail);
      return undefined;
    },
  };
}
