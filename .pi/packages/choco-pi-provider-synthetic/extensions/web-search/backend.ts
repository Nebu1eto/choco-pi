import { SyntheticClient, SyntheticSearchClientError } from "../../src/client/synthetic-client.ts";
import type { SyntheticUtilityApiConfig } from "../../src/client/types.ts";
import { resolveSyntheticClientOptions } from "../../src/client/utility-api.ts";
import { detectBillingMode } from "../../src/utils/quotas.ts";

export const SYNTHETIC_SEARCH_ADAPTER_ID = "synthetic.search" as const;
export const SYNTHETIC_SEARCH_PROVIDER_FAMILY = "synthetic" as const;

export interface SyntheticSearchBackendConfig extends SyntheticUtilityApiConfig {
  eligibilityRevision?: number;
  webSearch: boolean;
}

export type SyntheticSearchEntitlement = "subscription" | "pay-as-you-go";

export type SyntheticSearchFailureKind =
  | "aborted"
  | "stale"
  | "disabled"
  | "unconfigured"
  | "ineligible"
  | "auth"
  | "quota"
  | "network"
  | "request";

export interface SyntheticSearchFailure {
  kind: SyntheticSearchFailureKind;
  message: string;
  retryable: boolean;
}

export type SyntheticSearchAvailability =
  | { status: "disabled"; reason: string }
  | { status: "unconfigured"; reason: string }
  | { status: "ineligible"; reason: string }
  | { status: "error"; error: SyntheticSearchFailure }
  | { status: "available" };

export interface SyntheticNormalizedSearchResult {
  title: string;
  url: string;
  text: string;
  published: string;
}

export type SyntheticSearchExecution =
  | {
      ok: true;
      backend: {
        adapterId: typeof SYNTHETIC_SEARCH_ADAPTER_ID;
        providerFamily: typeof SYNTHETIC_SEARCH_PROVIDER_FAMILY;
        transport: "synthetic-v2-search";
      };
      results: SyntheticNormalizedSearchResult[];
    }
  | { ok: false; error: SyntheticSearchFailure };

interface SyntheticSearchClient {
  quotas(options: { signal?: AbortSignal }): ReturnType<SyntheticClient["quotas"]>;
  search(query: string, options: { signal?: AbortSignal }): ReturnType<SyntheticClient["search"]>;
}

export interface SyntheticSearchBackendDependencies {
  loadConfig: () => Promise<SyntheticSearchBackendConfig>;
  getApiKey: () => Promise<string | undefined>;
  createClient?: (options: {
    apiKey?: string;
    proxyUrl?: string;
    requiresAuth?: boolean;
  }) => SyntheticSearchClient;
}

export interface SyntheticSearchBackend {
  readonly adapterId: typeof SYNTHETIC_SEARCH_ADAPTER_ID;
  readonly providerFamily: typeof SYNTHETIC_SEARCH_PROVIDER_FAMILY;
  resolveAvailability(signal?: AbortSignal): Promise<SyntheticSearchAvailability>;
  search(query: string, signal?: AbortSignal): Promise<SyntheticSearchExecution>;
  invalidate(): void;
}

interface ResolvedConnection {
  cacheKey: EligibilityCacheKey;
  client: SyntheticSearchClient;
}

interface EligibilityCacheKey {
  apiKey: string | undefined;
  eligibilityRevision: number | undefined;
  proxyUrl: string | undefined;
  requiresAuth: boolean | undefined;
}

interface EligibilityCacheEntry {
  key: EligibilityCacheKey;
  availability: Extract<SyntheticSearchAvailability, { status: "available" | "ineligible" }>;
}

const ABORTED_FAILURE: SyntheticSearchFailure = {
  kind: "aborted",
  message: "Synthetic web search was cancelled.",
  retryable: false,
};

const STALE_FAILURE: SyntheticSearchFailure = {
  kind: "stale",
  message: "Synthetic web search belongs to an inactive session.",
  retryable: false,
};

function isAbortError(error: Error): boolean {
  return error.name === "AbortError";
}

function quotaFailure(
  kind: "cancelled" | "timeout" | "config" | "http" | "network",
  status: number | undefined,
): SyntheticSearchFailure {
  if (kind === "cancelled") return ABORTED_FAILURE;
  if (kind === "timeout" || kind === "network") {
    return {
      kind: "network",
      message: "Synthetic subscription eligibility could not be reached.",
      retryable: true,
    };
  }
  if (status === 401 || status === 403 || kind === "config") {
    return {
      kind: "auth",
      message: "Synthetic credentials were rejected.",
      retryable: false,
    };
  }
  if (status === 402 || status === 429) {
    return {
      kind: "quota",
      message: "Synthetic quota prevents web search.",
      retryable: status === 429,
    };
  }
  return {
    kind: "request",
    message: "Synthetic subscription eligibility could not be established.",
    retryable: true,
  };
}

export function createSyntheticSearchBackend(
  dependencies: SyntheticSearchBackendDependencies,
): SyntheticSearchBackend {
  let generation = 0;
  let controller = new AbortController();
  let eligibilityCache: EligibilityCacheEntry | undefined;

  function isCurrent(owner: number): boolean {
    return owner === generation;
  }

  function failureForSignal(
    owner: number,
    signal: AbortSignal,
  ): SyntheticSearchFailure | undefined {
    if (!isCurrent(owner)) return STALE_FAILURE;
    if (signal.aborted) return ABORTED_FAILURE;
    return undefined;
  }

  function requestSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  }

  function cacheKeysEqual(left: EligibilityCacheKey, right: EligibilityCacheKey): boolean {
    return (
      left.apiKey === right.apiKey &&
      left.eligibilityRevision === right.eligibilityRevision &&
      left.proxyUrl === right.proxyUrl &&
      left.requiresAuth === right.requiresAuth
    );
  }

  async function resolveConnection(
    owner: number,
    signal: AbortSignal,
  ): Promise<ResolvedConnection | SyntheticSearchAvailability | SyntheticSearchFailure> {
    if (signal.aborted) return ABORTED_FAILURE;

    const loadConfig = dependencies.loadConfig;
    let config: SyntheticSearchBackendConfig;
    try {
      config = await loadConfig();
    } catch {
      const interrupted = failureForSignal(owner, signal);
      return (
        interrupted ?? {
          kind: "request",
          message: "Synthetic web search configuration could not be loaded.",
          retryable: true,
        }
      );
    }
    const interruptedAfterConfig = failureForSignal(owner, signal);
    if (interruptedAfterConfig) return interruptedAfterConfig;
    if (!config.webSearch) {
      return {
        status: "disabled",
        reason: "Synthetic web search is disabled by configuration.",
      };
    }

    const getApiKey = dependencies.getApiKey;
    let options: Awaited<ReturnType<typeof resolveSyntheticClientOptions>>;
    try {
      options = await resolveSyntheticClientOptions(config, getApiKey);
    } catch {
      const interrupted = failureForSignal(owner, signal);
      return (
        interrupted ?? {
          kind: "auth",
          message: "Synthetic credentials could not be resolved.",
          retryable: true,
        }
      );
    }
    const interruptedAfterCredentials = failureForSignal(owner, signal);
    if (interruptedAfterCredentials) return interruptedAfterCredentials;
    if (!options) {
      return {
        status: "unconfigured",
        reason: "Synthetic web search requires Synthetic credentials or an unauthenticated proxy.",
      };
    }

    const createClient = dependencies.createClient ?? ((value) => new SyntheticClient(value));
    return {
      cacheKey: {
        apiKey: options.apiKey,
        eligibilityRevision: config.eligibilityRevision,
        proxyUrl: options.proxyUrl,
        requiresAuth: options.requiresAuth,
      },
      client: createClient(options),
    };
  }

  async function availabilityForConnection(
    connection: ResolvedConnection,
    owner: number,
    signal: AbortSignal,
  ): Promise<SyntheticSearchAvailability> {
    if (eligibilityCache && cacheKeysEqual(eligibilityCache.key, connection.cacheKey)) {
      return eligibilityCache.availability;
    }
    const quotaResult = await connection.client.quotas({ signal });
    const interruptedAfterQuota = failureForSignal(owner, signal);
    if (interruptedAfterQuota) {
      return { status: "error", error: interruptedAfterQuota };
    }
    if (!quotaResult.success) {
      return {
        status: "error",
        error: quotaFailure(quotaResult.error.kind, quotaResult.error.status),
      };
    }

    const entitlement: SyntheticSearchEntitlement = detectBillingMode(quotaResult.data.quotas);
    const availability: EligibilityCacheEntry["availability"] =
      entitlement === "subscription"
        ? { status: "available" }
        : {
            status: "ineligible",
            reason:
              "Synthetic web search requires an eligible subscription; PAYG is not auto-enabled.",
          };
    eligibilityCache = { key: connection.cacheKey, availability };
    return availability;
  }

  async function resolveAvailability(
    externalSignal?: AbortSignal,
  ): Promise<SyntheticSearchAvailability> {
    const owner = generation;
    const signal = requestSignal(externalSignal);
    const connection = await resolveConnection(owner, signal);
    if ("kind" in connection) {
      return { status: "error", error: connection };
    }
    if ("status" in connection) return connection;
    return availabilityForConnection(connection, owner, signal);
  }

  return {
    adapterId: SYNTHETIC_SEARCH_ADAPTER_ID,
    providerFamily: SYNTHETIC_SEARCH_PROVIDER_FAMILY,
    resolveAvailability,
    async search(query, externalSignal) {
      const owner = generation;
      const signal = requestSignal(externalSignal);
      if (signal.aborted) return { ok: false, error: ABORTED_FAILURE };

      const connection = await resolveConnection(owner, signal);
      if ("kind" in connection) return { ok: false, error: connection };
      if ("status" in connection) {
        if (connection.status === "error") {
          return { ok: false, error: connection.error };
        }
        if (connection.status === "available") {
          return {
            ok: false,
            error: {
              kind: "request",
              message: "Synthetic web search connection could not be established.",
              retryable: true,
            },
          };
        }
        return {
          ok: false,
          error: {
            kind: connection.status,
            message: connection.reason,
            retryable: false,
          },
        };
      }

      const availability = await availabilityForConnection(connection, owner, signal);
      if (availability.status === "error") {
        return { ok: false, error: availability.error };
      }
      if (availability.status !== "available") {
        return {
          ok: false,
          error: {
            kind: availability.status,
            message: availability.reason,
            retryable: false,
          },
        };
      }

      try {
        const response = await connection.client.search(query, { signal });
        const interruptedAfterSearch = failureForSignal(owner, signal);
        if (interruptedAfterSearch) return { ok: false, error: interruptedAfterSearch };
        return {
          ok: true,
          backend: {
            adapterId: SYNTHETIC_SEARCH_ADAPTER_ID,
            providerFamily: SYNTHETIC_SEARCH_PROVIDER_FAMILY,
            transport: "synthetic-v2-search",
          },
          results: response.results,
        };
      } catch (error: unknown) {
        if (!isCurrent(owner)) return { ok: false, error: STALE_FAILURE };
        if (signal.aborted || (error instanceof Error && isAbortError(error)))
          return { ok: false, error: ABORTED_FAILURE };
        if (error instanceof SyntheticSearchClientError) {
          return {
            ok: false,
            error: {
              kind: error.kind,
              message: error.message,
              retryable: error.retryable,
            },
          };
        }
        return {
          ok: false,
          error: {
            kind: "request",
            message: "Synthetic web search request failed.",
            retryable: true,
          },
        };
      }
    },
    invalidate() {
      generation++;
      controller.abort();
      controller = new AbortController();
      eligibilityCache = undefined;
    },
  };
}
