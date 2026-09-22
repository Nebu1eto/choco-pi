import { Value } from "typebox/value";
import { QuotasResponseSchema, type QuotasResult } from "../types/quotas.ts";
import {
  type SyntheticClientOptions,
  type SyntheticClientRequestOptions,
  type SyntheticModelsResponse,
  SyntheticModelsResponseSchema,
  type SyntheticSearchResponse,
  SyntheticSearchResponseSchema,
} from "./types.ts";
import {
  DEFAULT_SYNTHETIC_API_BASE_URL,
  resolveSyntheticUtilityApiBaseUrl,
  syntheticUtilityApiUrl,
} from "./utility-api.ts";
import { authHeaders, combineWithTimeout, isTimeoutReason, parseErrorMessage } from "./utils.ts";

export type SyntheticSearchClientErrorKind = "auth" | "quota" | "network" | "request";

export class SyntheticSearchClientError extends Error {
  readonly kind: SyntheticSearchClientErrorKind;
  readonly retryable: boolean;

  constructor(kind: SyntheticSearchClientErrorKind, message: string, retryable: boolean) {
    super(message);
    this.name = "SyntheticSearchClientError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

export class SyntheticClient {
  private readonly apiKey: string | undefined;
  private readonly proxyUrl: string | undefined;
  private readonly requiresAuth: boolean;

  constructor(options: SyntheticClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.proxyUrl = options.proxyUrl;
    this.requiresAuth = options.requiresAuth ?? true;
  }

  private resolveBaseUrl(): string {
    return resolveSyntheticUtilityApiBaseUrl(this.proxyUrl);
  }

  async quotas(options: SyntheticClientRequestOptions = {}): Promise<QuotasResult> {
    if (this.requiresAuth && !this.apiKey) {
      return {
        success: false,
        error: { message: "No API key provided", kind: "config" },
      };
    }

    let baseUrl: string;
    try {
      baseUrl = this.resolveBaseUrl();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Invalid proxy URL";
      return { success: false, error: { message, kind: "config" } };
    }

    const signal = combineWithTimeout(options.signal);

    try {
      const response = await fetch(syntheticUtilityApiUrl(baseUrl, "/v2/quotas"), {
        headers: authHeaders(this.apiKey),
        signal,
      });

      if (!response.ok) {
        return {
          success: false,
          error: {
            message: await parseErrorMessage(response),
            kind: "http",
            status: response.status,
          },
        };
      }

      const data = await response.json();
      if (!Value.Check(QuotasResponseSchema, data)) {
        throw new Error("Synthetic quotas API returned an invalid response");
      }
      return { success: true, data: { quotas: data } };
    } catch (err: unknown) {
      const isAbort = signal.aborted || (err instanceof DOMException && err.name === "AbortError");
      if (isAbort) {
        if (isTimeoutReason(signal.reason)) {
          return {
            success: false,
            error: { message: "Request timed out", kind: "timeout" },
          };
        }
        return {
          success: false,
          error: { message: "Request cancelled", kind: "cancelled" },
        };
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return { success: false, error: { message, kind: "network" } };
    }
  }

  async search(
    query: string,
    options: SyntheticClientRequestOptions = {},
  ): Promise<SyntheticSearchResponse> {
    if (this.requiresAuth && !this.apiKey) {
      throw new SyntheticSearchClientError("auth", "Synthetic credentials are missing.", false);
    }

    let response: Response;
    try {
      response = await fetch(syntheticUtilityApiUrl(this.resolveBaseUrl(), "/v2/search"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(this.apiKey),
        },
        body: JSON.stringify({ query }),
        signal: options.signal,
      });
    } catch (error: unknown) {
      if (
        options.signal?.aborted ||
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw error;
      }
      throw new SyntheticSearchClientError(
        "network",
        "Synthetic web search could not be reached.",
        true,
      );
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new SyntheticSearchClientError("auth", "Synthetic credentials were rejected.", false);
      }
      if (response.status === 402 || response.status === 429) {
        throw new SyntheticSearchClientError(
          "quota",
          "Synthetic quota prevents web search.",
          response.status === 429,
        );
      }
      throw new SyntheticSearchClientError(
        "request",
        "Synthetic web search request failed.",
        response.status >= 500,
      );
    }

    try {
      const data = await response.json();
      if (!Value.Check(SyntheticSearchResponseSchema, data)) {
        throw new Error("Synthetic search API returned an invalid response");
      }
      return data;
    } catch {
      throw new SyntheticSearchClientError(
        "request",
        "Synthetic web search returned an invalid response.",
        false,
      );
    }
  }

  async models(options: SyntheticClientRequestOptions = {}): Promise<SyntheticModelsResponse> {
    const signal = combineWithTimeout(options.signal);

    try {
      const response = await fetch(
        syntheticUtilityApiUrl(DEFAULT_SYNTHETIC_API_BASE_URL, "/openai/v1/models"),
        {
          headers: authHeaders(this.apiKey),
          signal,
        },
      );

      if (!response.ok) {
        throw new Error(`Synthetic models API error: ${response.status} ${await response.text()}`);
      }

      const data = await response.json();
      if (!Value.Check(SyntheticModelsResponseSchema, data)) {
        throw new Error("Synthetic models API returned an invalid response");
      }
      return data;
    } catch (err: unknown) {
      const isAbort = signal.aborted || (err instanceof DOMException && err.name === "AbortError");
      if (isAbort && isTimeoutReason(signal.reason)) {
        throw new Error("Synthetic models API request timed out");
      }
      throw err;
    }
  }
}
