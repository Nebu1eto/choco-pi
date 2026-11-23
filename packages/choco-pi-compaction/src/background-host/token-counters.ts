/**
 * Provider prompt token counters for background compaction admission.
 *
 * Selected by the owner model's provider. Anthropic's free
 * `messages/count_tokens` endpoint is counted here (API-key auth only); every
 * other provider is counted by the counter its package registered through
 * {@link registerCompactionTokenCounter} (the Synthetic and Google Antigravity
 * provider packages do on activation), and a provider without one is
 * uncounted, so admission keeps its estimate. A registered counter may name an
 * opt-in environment variable that must be `1` when the compaction counter is
 * created. A counter never throws: every failure resolves to undefined plus a
 * short `count-tokens: <code>` diagnostic.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compile, obj } from "@earendil-works/pi-schema";

import { finiteInt } from "../guards.ts";
import { authModeOf, normalizeBaseUrl } from "../anthropic/capability.ts";
import type { TokenCounter } from "../background/contract.ts";
import {
  type CompactionTokenCounter,
  type CompactionTokenCountOutcome,
  type CompactionTokenCountRequest,
  isTokenCountOutcome,
  registeredOptInEnvs,
  registeredTokenCounter,
} from "./token-counter-registry.ts";

/** Upper bound on one count request; an 800k-char Synthetic body took ~4 s. */
export const COUNT_TOKENS_TIMEOUT_MS = 10_000;
/** How long a deterministic failure (5xx, malformed, auth) suppresses requests for one model. */
export const COUNT_TOKENS_NEGATIVE_TTL_MS = 600_000;

const ANTHROPIC_PROVIDER = "anthropic";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
const isCountTokensResponse = compile(obj({ input_tokens: finiteInt(0) }, { open: true })).check;

type CountInput = Parameters<TokenCounter["countTokens"]>[0];
/** The registry slice a counter reads: request auth for the owner model. */
export type CountRegistry = Pick<ExtensionContext["modelRegistry"], "getApiKeyAndHeaders">;
type CountFailure = Extract<CompactionTokenCountOutcome, { ok: false }>;

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
  /**
   * Opt-in decisions by environment variable name (a registered counter's
   * `optInEnv`). A variable not listed is `1` or not when the counter is
   * created, or, for a counter registered later, when it is first used.
   */
  readonly optIn?: ReadonlyMap<string, boolean>;
}

interface CountContext {
  readonly registry: CountRegistry;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs: number;
  readonly optedIn: (env: string) => boolean;
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

function fromOutcome(outcome: CompactionTokenCountOutcome): CountOutcome {
  if ("skipped" in outcome) return { skipped: true };
  if (outcome.ok) return { tokens: outcome.inputTokens };
  return { detail: failureDetail(outcome), cache: outcome.cache ?? cacheable(outcome) };
}

function errorCodeForStatus(status: number): string {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate-limit";
  return "http";
}

/** Registry headers (null drops a header) under the count request's own fixed headers. */
function anthropicHeaders(request: CompactionTokenCountRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (value !== null) headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  headers.set("anthropic-version", ANTHROPIC_VERSION);
  headers.set("x-api-key", request.apiKey);
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

function transportFailure(caller: AbortSignal, combined: AbortSignal): CompactionTokenCountOutcome {
  if (caller.aborted) return { ok: false, code: "aborted", cache: false };
  if (combined.aborted) return { ok: false, code: "timeout", cache: false };
  return { ok: false, code: "network", cache: false };
}

function parseAnthropicCount(text: string, status: number): CompactionTokenCountOutcome {
  const malformed = { ok: false, code: "malformed", status, cache: true } as const;
  let data: ReturnType<typeof JSON.parse>;
  try {
    data = JSON.parse(text);
  } catch {
    return malformed;
  }
  return isCountTokensResponse(data) ? { ok: true, inputTokens: data.input_tokens } : malformed;
}

/** Anthropic `messages/count_tokens`; Bearer/OAuth tokens are not accepted as `x-api-key`. */
const anthropicTokenCounter: CompactionTokenCounter = {
  async countTokens(request) {
    if (authModeOf(request.apiKey) !== "api-key") return { skipped: true };
    const url = anthropicCountUrl(request.baseUrl);
    if (url === undefined) return { ok: false, code: "invalid-base-url", cache: true };
    const signal = timedSignal(request.signal, request.timeoutMs);
    let response: Response;
    try {
      response = await request.fetch(url, {
        method: "POST",
        headers: anthropicHeaders(request),
        body: JSON.stringify({
          model: request.model.id,
          system: request.system,
          messages: [{ role: "user", content: [{ type: "text", text: request.promptText }] }],
        }),
        signal,
      });
    } catch {
      return transportFailure(request.signal, signal);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, code: errorCodeForStatus(response.status), status: response.status };
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      return transportFailure(request.signal, signal);
    }
    return parseAnthropicCount(text, response.status);
  },
};

/** The counter for a provider: Anthropic is built in; others come from the registry. */
function counterFor(provider: string): CompactionTokenCounter | undefined {
  return provider === ANTHROPIC_PROVIDER ? anthropicTokenCounter : registeredTokenCounter(provider);
}

async function countFor(context: CountContext, input: CountInput): Promise<CountOutcome> {
  const counter = counterFor(input.model.provider);
  if (counter === undefined) return { skipped: true };
  if (counter.optInEnv !== undefined && !context.optedIn(counter.optInEnv)) {
    return { skipped: true };
  }
  const auth = await context.registry.getApiKeyAndHeaders(input.model);
  if (!auth.ok) return { detail: "count-tokens: auth-unresolved", cache: false };
  const apiKey = auth.apiKey?.trim() ?? "";
  if (apiKey.length === 0) return { detail: "count-tokens: no-api-key", cache: false };
  const outcome = await counter.countTokens({
    model: input.model,
    system: input.system,
    promptText: input.promptText,
    signal: input.signal,
    apiKey,
    headers: auth.headers,
    baseUrl: auth.baseUrl ?? input.model.baseUrl,
    fetch: context.fetch,
    timeoutMs: context.timeoutMs,
  });
  // A registered counter is another package's code; an unreadable answer is a defect there.
  if (!isTokenCountOutcome(outcome)) return { detail: "count-tokens: error", cache: true };
  return fromOutcome(outcome);
}

function cacheKey(model: Model<Api>): string {
  return [model.provider, normalizeBaseUrl(model.baseUrl), model.id].join("|");
}

/**
 * Opt-in decisions: `options.optIn` first, then each variable as it was when
 * the counter was created (or first needed, for a counter registered later).
 */
function optInReader(options: ProviderTokenCounterOptions): (env: string) => boolean {
  const snapshot = new Map<string, boolean>();
  const read = (env: string): boolean => {
    const given = options.optIn?.get(env);
    if (given !== undefined) return given;
    let value = snapshot.get(env);
    if (value === undefined) {
      value = process.env[env] === "1";
      snapshot.set(env, value);
    }
    return value;
  };
  for (const env of registeredOptInEnvs()) read(env);
  return read;
}

/**
 * Counter for Anthropic owner models and every provider with a registered
 * counter; undefined for every other provider, without network. Deterministic
 * failures are remembered per `provider|baseUrl|model` for
 * {@link COUNT_TOKENS_NEGATIVE_TTL_MS}.
 */
export function createProviderTokenCounter(options: ProviderTokenCounterOptions): TokenCounter {
  const now = options.now ?? Date.now;
  const cache: CountTokensNegativeCache = options.cache ?? new Map();
  const context: CountContext = {
    registry: options.registry,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? COUNT_TOKENS_TIMEOUT_MS,
    optedIn: optInReader(options),
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
