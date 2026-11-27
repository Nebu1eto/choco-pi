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

export interface SearchRouteTarget {
  family: SearchProviderFamily;
  model?: string;
  authProvider?: string;
}

const SEARCH_ROUTE_FAMILY_ALIASES = {
  "openai-codex": { family: "openai", authProvider: "openai-codex" },
  "google-antigravity": { family: "google" },
} as const satisfies Readonly<
  Record<string, { readonly family: SearchProviderFamily; readonly authProvider?: string }>
>;

function lookupSearchRouteAlias(
  prefix: string,
): { readonly family: SearchProviderFamily; readonly authProvider?: string } | undefined {
  if (prefix === "openai-codex") return SEARCH_ROUTE_FAMILY_ALIASES["openai-codex"];
  if (prefix === "google-antigravity") return SEARCH_ROUTE_FAMILY_ALIASES["google-antigravity"];
  return undefined;
}

export function parseSearchRouteTarget(raw: string): SearchRouteTarget | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const slashIndex = trimmed.indexOf("/");
  const rawPrefix = (slashIndex === -1 ? trimmed : trimmed.slice(0, slashIndex))
    .trim()
    .toLowerCase();
  const rawModel = slashIndex === -1 ? undefined : trimmed.slice(slashIndex + 1).trim();
  if (slashIndex !== -1 && (!rawModel || rawModel.length === 0)) return undefined;
  const alias = lookupSearchRouteAlias(rawPrefix);
  const family = alias ? alias.family : rawPrefix;
  if (!isValidSearchProviderFamily(family)) return undefined;
  const target: SearchRouteTarget = { family };
  if (rawModel) target.model = rawModel;
  if (alias?.authProvider) {
    target.authProvider = alias.authProvider;
  } else if (family === "openai" && rawModel) {
    target.authProvider = "openai";
  }
  return target;
}

export function formatSearchRouteTarget(target: SearchRouteTarget): string {
  const prefix = target.authProvider ?? target.family;
  return target.model ? `${prefix}/${target.model}` : prefix;
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
  targets?: readonly SearchRouteTarget[];
  fallbackOn?: SearchErrorKind[];
  configuredPriority?: boolean;
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
