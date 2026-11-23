import {
  registerSearchAdapter,
  SearchError,
  type SearchAdapter,
  type SearchAdapterContext,
  type SearchAdapterResponse,
  type SearchAvailability,
  type SearchErrorKind,
  type SearchErrorOptions,
  type SearchScope,
} from "../../../choco-pi-web-search/index.ts";
import { parseAntigravityApiKey } from "../auth/oauth.ts";
import { hasAntigravitySignIn, type AntigravitySignInRegistry } from "../auth/sign-in.ts";
import { getActiveCatalog } from "../catalog/group.ts";
import { postV1Internal, type FetchLike } from "../client/http.ts";
import { PROVIDER_ID, SIGN_IN_HINT } from "../config.ts";
import { AntigravityError, type AntigravityErrorKind } from "../errors.ts";
import {
  buildGoogleSearchTool,
  buildGroundingRequest,
  searchQueries,
  selectWebSearchModel,
} from "./request.ts";
import { groundingResponseValidator, isGroundingFailure, normalizeGrounding } from "./response.ts";

export const GOOGLE_SEARCH_ADAPTER_ID = "google-antigravity.grounding";
export const GOOGLE_SEARCH_TRANSPORT = "v1internal-generate-content";
export const GOOGLE_SEARCH_TIMEOUT_MS = 50_000;
const DEFAULT_RESULT_LIMIT = 20;

export interface GoogleSearchRegistry extends AntigravitySignInRegistry {
  getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

export interface GoogleSearchAdapterOptions {
  fetch?: FetchLike | undefined;
  endpoints?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
  now?: (() => number) | undefined;
  getModelIds?: (() => readonly string[]) | undefined;
  getRegistry?: ((context: SearchAdapterContext) => GoogleSearchRegistry | undefined) | undefined;
}

function errorOptions(extra: SearchErrorOptions = {}): SearchErrorOptions {
  return {
    family: "google",
    adapterId: GOOGLE_SEARCH_ADAPTER_ID,
    transport: GOOGLE_SEARCH_TRANSPORT,
    billing: "subscription",
    ...extra,
  };
}

function searchError(
  kind: SearchErrorKind,
  message: string,
  extra: SearchErrorOptions = {},
): SearchError {
  return new SearchError(kind, message, errorOptions(extra));
}

interface MappedKind {
  kind: SearchErrorKind;
  retryable: boolean;
}

const ERROR_KIND_MAP = {
  quota_exhausted: { kind: "quota", retryable: false },
  credits_exhausted: { kind: "quota", retryable: false },
  rate_limited: { kind: "quota", retryable: true },
  capacity: { kind: "transient", retryable: true },
  server: { kind: "transient", retryable: true },
  network: { kind: "network", retryable: true },
  auth: { kind: "auth", retryable: false },
  permission: { kind: "entitlement", retryable: false },
  validation_required: { kind: "entitlement", retryable: false },
  unsupported_client: { kind: "entitlement", retryable: false },
  model_unavailable: { kind: "entitlement", retryable: false },
  invalid_request: { kind: "invalid-request", retryable: false },
  context_overflow: { kind: "invalid-request", retryable: false },
  malformed_response: { kind: "invalid-response", retryable: true },
} as const satisfies Record<AntigravityErrorKind, MappedKind>;

export function searchErrorFromAntigravity(error: AntigravityError): SearchError {
  const mapped: MappedKind = ERROR_KIND_MAP[error.kind];
  const extra: SearchErrorOptions = { retryable: mapped.retryable, cause: error };
  if (error.status !== undefined) extra.status = error.status;
  return searchError(mapped.kind, error.message, extra);
}

function isCurrent(context: SearchAdapterContext, generation: number): boolean {
  return context.session.active && context.session.generation === generation;
}

function assertCurrent(context: SearchAdapterContext, generation: number): void {
  if (!isCurrent(context, generation)) {
    throw searchError(
      "stale-context",
      "Google search session changed while the request was running",
    );
  }
  if (context.signal.aborted) throw searchError("cancelled", "Google search was cancelled");
}

function defaultRegistry(context: SearchAdapterContext): GoogleSearchRegistry | undefined {
  return context.context?.modelRegistry;
}

function unavailable(reason: string): SearchAvailability {
  return {
    status: "unavailable",
    reason,
    transport: GOOGLE_SEARCH_TRANSPORT,
    billing: "subscription",
  };
}

async function resolveCredential(
  registry: GoogleSearchRegistry,
  context: SearchAdapterContext,
  generation: number,
): Promise<{ token: string; projectId: string }> {
  let apiKey: string | undefined;
  try {
    apiKey = await registry.getApiKeyForProvider(PROVIDER_ID);
  } catch (cause) {
    assertCurrent(context, generation);
    throw searchError(
      "auth",
      `Google Antigravity credentials could not be resolved; ${SIGN_IN_HINT}`,
      {
        cause,
      },
    );
  }
  assertCurrent(context, generation);
  if (!apiKey) {
    throw searchError("auth", `Google Antigravity is not signed in; ${SIGN_IN_HINT}`);
  }
  try {
    return parseAntigravityApiKey(apiKey);
  } catch (cause) {
    if (cause instanceof AntigravityError) throw searchErrorFromAntigravity(cause);
    throw searchError("auth", `Google Antigravity credential is malformed; ${SIGN_IN_HINT}`);
  }
}

export function createGoogleSearchAdapter(options: GoogleSearchAdapterOptions = {}): SearchAdapter {
  const timeoutMs = options.timeoutMs ?? GOOGLE_SEARCH_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const getModelIds = options.getModelIds ?? (() => getActiveCatalog().webSearchModelIds);
  const getRegistry = options.getRegistry ?? defaultRegistry;

  function registryFor(context: SearchAdapterContext): GoogleSearchRegistry | undefined {
    try {
      return getRegistry(context);
    } catch (cause) {
      throw searchError("config", "Pi model registry is unavailable for Google search", { cause });
    }
  }

  return {
    id: GOOGLE_SEARCH_ADAPTER_ID,
    family: "google",
    transport: GOOGLE_SEARCH_TRANSPORT,
    billing: "subscription",
    explicitOnly: true,
    capabilities: {
      actions: ["search"],
      constraints: {
        numResults: true,
        domainFilter: true,
        domainExclusions: true,
        recencyFilter: true,
        recencyDays: true,
      },
    },
    availability(context): SearchAvailability {
      assertCurrent(context, context.generation);
      const registry = registryFor(context);
      if (!registry)
        return unavailable("Google search requires a Pi host context with a model registry");
      let configured: boolean;
      try {
        configured = registry.getProviderAuthStatus(PROVIDER_ID).configured;
      } catch {
        return unavailable("Google Antigravity sign-in status could not be read");
      }
      if (!configured) return unavailable(`Google Antigravity is not signed in; ${SIGN_IN_HINT}`);
      if (!hasAntigravitySignIn(registry)) {
        return unavailable(
          `Google is not signed in with Google Antigravity OAuth and a Gemini API key is not used; ${SIGN_IN_HINT}`,
        );
      }
      return { status: "available", transport: GOOGLE_SEARCH_TRANSPORT, billing: "subscription" };
    },
    async execute(request, context): Promise<SearchAdapterResponse> {
      const generation = context.generation;
      assertCurrent(context, generation);
      const queries = searchQueries(request);
      if (queries.length === 0)
        throw searchError("invalid-request", "Google search requires a query");
      const registry = registryFor(context);
      if (!registry) {
        throw searchError(
          "config",
          "Google search requires a Pi host context with a model registry",
        );
      }
      const credential = await resolveCredential(registry, context, generation);
      const startedAt = now();
      const model = selectWebSearchModel(getModelIds());
      const body = buildGroundingRequest({
        projectId: credential.projectId,
        model,
        queries,
        tool: buildGoogleSearchTool(request, startedAt),
        now: startedAt,
      });
      let raw;
      try {
        raw = await postV1Internal("generateContent", body, {
          token: credential.token,
          validator: groundingResponseValidator,
          signal: context.signal,
          timeoutMs,
          fetch: options.fetch,
          endpoints: options.endpoints,
        });
      } catch (cause) {
        assertCurrent(context, generation);
        if (cause instanceof AntigravityError) throw searchErrorFromAntigravity(cause);
        throw searchError("invalid-response", "Google search failed unexpectedly", {
          cause,
          retryable: true,
        });
      }
      assertCurrent(context, generation);
      const normalized = normalizeGrounding(raw);
      if (isGroundingFailure(normalized)) {
        const message =
          normalized.kind === "blocked"
            ? `Google search was blocked (${normalized.reason})`
            : `Google search returned no answer or sources${normalized.finishReason ? ` (finish reason ${normalized.finishReason})` : ""}`;
        throw searchError("invalid-response", message, { retryable: normalized.kind === "empty" });
      }
      const warnings: string[] = [];
      if (normalized.ungrounded) {
        warnings.push(
          "Google returned an answer without grounding metadata; it may not reflect a web search.",
        );
      }
      if (normalized.finishReason === "MAX_TOKENS") {
        warnings.push("Google search answer hit the output limit and may be truncated.");
      }
      const limit = request.numResults ?? DEFAULT_RESULT_LIMIT;
      if (normalized.results.length > limit) {
        warnings.push(`Google returned ${normalized.results.length} sources; limited to ${limit}.`);
      }
      const response: SearchAdapterResponse = {
        answer: normalized.answer,
        results: normalized.results.slice(0, limit),
        native: {
          backend: GOOGLE_SEARCH_ADAPTER_ID,
          providerFamily: "google",
          model,
          webSearchQueries: normalized.webSearchQueries,
          citations: normalized.citations.map((citation) => ({
            text: citation.text,
            sources: [...citation.sources],
          })),
        },
      };
      if (warnings.length > 0) response.warnings = warnings;
      return response;
    },
  };
}

export interface GoogleSearchRegistrationGate {
  sync(registry: AntigravitySignInRegistry | undefined): boolean;
  dispose(): void;
}

export function createGoogleSearchRegistrationGate(
  scope: SearchScope,
  options: GoogleSearchAdapterOptions = {},
): GoogleSearchRegistrationGate {
  let unregister: (() => void) | undefined;
  const dispose = () => {
    unregister?.();
    unregister = undefined;
  };
  return {
    sync(registry) {
      if (!hasAntigravitySignIn(registry)) {
        dispose();
        return false;
      }
      unregister ??= registerSearchAdapter(scope, createGoogleSearchAdapter(options));
      return true;
    },
    dispose,
  };
}
