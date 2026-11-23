import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isString } from "@choco-pi/shared/value-guards";

export const BUILTIN_SEARCH_PROVIDER_FAMILIES = Object.freeze([
  "openai",
  "exa",
  "kagi",
  "synthetic",
  "brave",
  "google",
  "xai",
] as const);
export const searchProviderFamilies = BUILTIN_SEARCH_PROVIDER_FAMILIES;
export type BuiltinSearchProviderFamily = (typeof BUILTIN_SEARCH_PROVIDER_FAMILIES)[number];
export type SearchProviderFamily = BuiltinSearchProviderFamily | (string & {});
export const defaultSearchFamilyOrder: readonly SearchProviderFamily[] =
  BUILTIN_SEARCH_PROVIDER_FAMILIES;
export const searchProviderSelections = Object.freeze([
  "auto",
  "all",
  ...BUILTIN_SEARCH_PROVIDER_FAMILIES,
] as const);

export type BuiltinSearchProviderName = (typeof searchProviderSelections)[number];
export type SearchProviderName = "auto" | "all" | SearchProviderFamily;
export type SearchProviderSelection = SearchProviderName | SearchProviderFamily[];
export type SearchAction = "search" | "image" | "open" | "click" | "find";
export type SearchErrorKind =
  | "auth"
  | "config"
  | "invalid-request"
  | "transient"
  | "quota"
  | "network"
  | "invalid-response"
  | "capability"
  | "stale-context"
  | "entitlement"
  | "conflict"
  | "deadline"
  | "cancelled";
export type SearchBilling = "subscription" | "api" | "free" | "unknown";
export type SearchCapability =
  | "url"
  | "lineno"
  | "numResults"
  | "recencyFilter"
  | "recencyDays"
  | "domainFilter"
  | "domainExclusions"
  | "includeContent"
  | "country"
  | "language"
  | "safesearch"
  | "offset"
  | "exaSearchType"
  | "answerMode"
  | "responseLength"
  | "searchContextSize";

const SEARCH_PROVIDER_FAMILY_PATTERN = /^[a-z][a-z0-9-]*$/;

/** True when `value` is a valid non-empty lowercase provider family id (excluding `auto`/`all`). */
export function isValidSearchProviderFamily<Value>(
  value: Value,
): value is Value & SearchProviderFamily {
  return (
    isString(value) &&
    value !== "auto" &&
    value !== "all" &&
    SEARCH_PROVIDER_FAMILY_PATTERN.test(value)
  );
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonRecord = { [key: string]: JsonValue };

export interface SearchRequest {
  query?: string;
  queries?: string[];
  action?: SearchAction;
  imageQuery?: string;
  url?: string;
  lineno?: number;
  open?: boolean;
  click?: { id: number };
  find?: { pattern: string };
  reference?: { id: string };
  responseLength?: "short" | "medium" | "long";
  numResults?: number;
  recencyFilter?: "day" | "week" | "month" | "year";
  recencyDays?: number;
  domainFilter?: string[];
  includeContent?: boolean;
  country?: string;
  language?: string;
  safesearch?: "off" | "moderate" | "strict";
  offset?: number;
  exaSearchType?: "auto" | "fast" | "instant" | "deep-lite" | "deep" | "deep-reasoning";
  answerMode?: "answer" | "results" | "both";
  searchContextSize?: "low" | "medium" | "high";
  provider?: SearchProviderSelection;
  requiredCapabilities?: SearchCapability[];
  /** Namespaced per-backend options bag (e.g. `{ exa: { searchType: "deep" } }`). */
  providerOptions?: Readonly<Record<string, JsonRecord>>;
}

export type ReadonlySessionManager = ExtensionContext["sessionManager"];

export interface SearchBindingContext {
  sessionManager: ReadonlySessionManager;
}

export interface SearchCapabilities {
  actions: readonly SearchAction[];
  constraints?: Partial<Record<SearchCapability, boolean>>;
}

export interface SearchAvailability {
  status: "available" | "unavailable" | "disabled" | "error";
  reason?: string;
  transport?: string;
  billing?: SearchBilling;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchInlineContent {
  url: string;
  title: string;
  content: string;
  error: string | null;
  thumbnail?: { data: string; mimeType: string };
  mimeType?: string;
  status?: number;
}

export interface SearchNativeReference {
  id: string;
  kind: string;
  native?: JsonValue;
}

export interface SearchAdapterResponse {
  answer: string;
  results: SearchResult[];
  inlineContent?: SearchInlineContent[];
  warnings?: string[];
  native?: JsonValue;
  references?: SearchNativeReference[];
}

export interface SearchReference {
  id: string;
  kind: string;
  adapterId: string;
  transport: string;
}

export interface SearchAttemptDiagnostic {
  adapterId: string;
  family: SearchProviderFamily;
  transport: string;
  outcome: "success" | "unavailable" | "disabled" | "incompatible" | "error";
  errorKind?: SearchErrorKind;
  reason?: string;
}

export interface SearchResponse extends SearchAdapterResponse {
  provider: SearchProviderFamily | "all";
  adapterId: string | "all";
  transport: string | "multiple";
  billing?: SearchBilling;
  attempts: SearchAttemptDiagnostic[];
  references?: SearchReference[];
  providerResponses?: SearchResponse[];
  providerErrors?: Array<{ provider: SearchProviderFamily; error: string; kind: SearchErrorKind }>;
}

export interface StoredReference {
  publicReference: SearchReference;
  nativeReference: SearchNativeReference;
}

export interface SearchRouting {
  providers: SearchProviderFamily[];
  fallbackOn?: SearchErrorKind[];
}

export interface SearchErrorOptions {
  family?: SearchProviderFamily;
  adapterId?: string;
  transport?: string;
  billing?: SearchBilling;
  status?: number;
  retryable?: boolean;
  deadlineKind?: "total" | "attempt";
  attempts?: readonly SearchAttemptDiagnostic[];
  cause?: unknown;
}
