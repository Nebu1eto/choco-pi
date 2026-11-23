import type {
  JsonRecord,
  SearchAction,
  SearchAttemptDiagnostic,
  SearchCapability,
  SearchErrorKind,
  SearchProviderFamily,
  SearchRequest,
  SearchResponse,
} from "./contract.ts";
import type { SearchAdapter } from "./scope.ts";

export function actionFor(request: SearchRequest): SearchAction {
  if (request.action) return request.action;
  if (request.imageQuery) return "image";
  if (request.open || request.url) return "open";
  if (request.click) return "click";
  if (request.find) return "find";
  return "search";
}

export function isValidDomain(domain: string): boolean {
  const bareDomain = domain.startsWith("-") ? domain.slice(1) : domain;
  if (bareDomain.length > 253 || bareDomain.endsWith(".")) return false;
  const labels = bareDomain.split(".");
  if (labels.length < 2) return false;
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
  );
}

export function requiredCapabilities(request: SearchRequest): SearchCapability[] {
  const required = new Set(request.requiredCapabilities ?? []);
  if (request.url) required.add("url");
  if (request.lineno !== undefined) required.add("lineno");
  if (request.recencyFilter) required.add("recencyFilter");
  if (request.recencyDays !== undefined) required.add("recencyDays");
  if (request.domainFilter) required.add("domainFilter");
  if (request.domainFilter?.some((domain) => domain.startsWith("-"))) {
    required.add("domainExclusions");
  }
  if (request.includeContent) required.add("includeContent");
  if (request.country) required.add("country");
  if (request.language) required.add("language");
  if (request.safesearch) required.add("safesearch");
  if (request.offset !== undefined) required.add("offset");
  if (request.exaSearchType) required.add("exaSearchType");
  if (request.answerMode) required.add("answerMode");
  if (request.responseLength) required.add("responseLength");
  if (request.searchContextSize) required.add("searchContextSize");
  return [...required];
}

export function toolParamName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function incompatibility(
  adapter: SearchAdapter,
  request: SearchRequest,
): string | undefined {
  const action = actionFor(request);
  if (!adapter.capabilities.actions.includes(action)) return `action ${action} is unsupported`;
  for (const capability of requiredCapabilities(request)) {
    if (adapter.capabilities.constraints?.[capability] !== true)
      return `${toolParamName(capability)} is unsupported`;
  }
  return undefined;
}

export function normalizeSearchRequest(
  request: SearchRequest,
  adapterFamily?: SearchProviderFamily,
): SearchRequest {
  if (request.exaSearchType === undefined) return request;
  if (
    adapterFamily !== undefined &&
    adapterFamily !== "exa" &&
    request.providerOptions === undefined
  ) {
    return request;
  }
  const existingExa = request.providerOptions?.exa;
  if (existingExa && existingExa.searchType !== undefined) return request;
  const mergedExa: JsonRecord = {
    ...existingExa,
    searchType: request.exaSearchType,
  };
  const mergedOptions = {
    ...request.providerOptions,
    exa: mergedExa,
  };
  return {
    ...request,
    providerOptions: mergedOptions,
  };
}

export function combineResponses(
  responses: SearchResponse[],
  failures: Array<{ provider: SearchProviderFamily; error: string; kind: SearchErrorKind }>,
  attempts: SearchAttemptDiagnostic[],
): SearchResponse {
  const seen = new Set<string>();
  const results = responses
    .flatMap((response) => response.results)
    .filter((result) => {
      if (seen.has(result.url)) return false;
      seen.add(result.url);
      return true;
    });
  const response: SearchResponse = {
    answer: responses
      .map((response) => response.answer)
      .filter(Boolean)
      .join("\n\n"),
    results,
    inlineContent: responses.flatMap((response) => response.inlineContent ?? []),
    warnings: responses.flatMap((response) => response.warnings ?? []),
    references: responses.flatMap((response) => response.references ?? []),
    provider: "all",
    adapterId: "all",
    transport: "multiple",
    attempts,
    providerResponses: responses,
  };
  if (failures.length > 0) response.providerErrors = failures;
  return response;
}
