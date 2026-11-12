// Boundary helpers: tool parameters are snake_case; internal request objects keep camelCase.
import type { Static } from "@earendil-works/pi-schema";
import type { SearchCapability, canonicalSearchParams } from "../choco-pi-web-search/index.ts";

export type CanonicalSearchParams = Static<typeof canonicalSearchParams>;

export function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Every capability the shared router knows, as spelled internally (camelCase). */
export const SEARCH_CAPABILITIES: readonly SearchCapability[] = [
  "url",
  "lineno",
  "numResults",
  "recencyFilter",
  "recencyDays",
  "domainFilter",
  "domainExclusions",
  "includeContent",
  "country",
  "language",
  "safesearch",
  "offset",
  "exaSearchType",
  "answerMode",
  "responseLength",
  "searchContextSize",
];

const CAPABILITY_BY_SNAKE = new Map<string, SearchCapability>(
  SEARCH_CAPABILITIES.map((capability) => [camelToSnake(capability), capability]),
);

/** Snake_case capability names accepted by `required_capabilities`. */
export const SNAKE_CAPABILITY_NAMES: string[] = [...CAPABILITY_BY_SNAKE.keys()];

/** Map one `required_capabilities` tool value to the internal capability name. */
export function internalCapability(value: string): SearchCapability {
  const capability = CAPABILITY_BY_SNAKE.get(value);
  if (capability === undefined) {
    throw new Error(
      `required_capabilities contains an unsupported value "${value}"; use one of ${SNAKE_CAPABILITY_NAMES.join(", ")}.`,
    );
  }
  return capability;
}

/** The web_search tool parameters as the model sends them. */
export type SnakeWebSearchParams = Omit<
  CanonicalSearchParams,
  | "imageQuery"
  | "responseLength"
  | "numResults"
  | "recencyFilter"
  | "recencyDays"
  | "domainFilter"
  | "includeContent"
  | "exaSearchType"
  | "answerMode"
  | "searchContextSize"
  | "requiredCapabilities"
> & {
  image_query?: CanonicalSearchParams["imageQuery"];
  response_length?: CanonicalSearchParams["responseLength"];
  num_results?: CanonicalSearchParams["numResults"];
  recency_filter?: CanonicalSearchParams["recencyFilter"];
  recency_days?: CanonicalSearchParams["recencyDays"];
  domain_filter?: CanonicalSearchParams["domainFilter"];
  include_content?: CanonicalSearchParams["includeContent"];
  exa_search_type?: CanonicalSearchParams["exaSearchType"];
  answer_mode?: CanonicalSearchParams["answerMode"];
  search_context_size?: CanonicalSearchParams["searchContextSize"];
  required_capabilities?: string[];
  workflow?: "none" | "summary-review" | "auto-summary";
};

/** Pre-snake_case web_search parameter names; they are rejected, never aliased. */
export const LEGACY_WEB_SEARCH_PARAMS: readonly string[] = [
  "imageQuery",
  "responseLength",
  "numResults",
  "recencyFilter",
  "recencyDays",
  "domainFilter",
  "includeContent",
  "exaSearchType",
  "answerMode",
  "searchContextSize",
  "requiredCapabilities",
];

/** Reject pre-snake_case parameter names so they never act as aliases. */
export function rejectLegacyParamNames(
  suppliedNames: readonly string[],
  legacyNames: readonly string[],
): void {
  for (const name of legacyNames) {
    if (suppliedNames.includes(name)) {
      throw new Error(`Unknown parameter ${name}; use ${camelToSnake(name)}.`);
    }
  }
}

/** Convert snake_case web_search parameters to the internal canonical request shape. */
export function toCanonicalSearchParams(
  params: SnakeWebSearchParams,
): CanonicalSearchParams & Pick<SnakeWebSearchParams, "workflow"> {
  rejectLegacyParamNames(Object.keys(params), LEGACY_WEB_SEARCH_PARAMS);
  const {
    image_query,
    response_length,
    num_results,
    recency_filter,
    recency_days,
    domain_filter,
    include_content,
    exa_search_type,
    answer_mode,
    search_context_size,
    required_capabilities,
    ...rest
  } = params;
  return {
    ...rest,
    ...(image_query !== undefined && { imageQuery: image_query }),
    ...(response_length !== undefined && { responseLength: response_length }),
    ...(num_results !== undefined && { numResults: num_results }),
    ...(recency_filter !== undefined && { recencyFilter: recency_filter }),
    ...(recency_days !== undefined && { recencyDays: recency_days }),
    ...(domain_filter !== undefined && { domainFilter: domain_filter }),
    ...(include_content !== undefined && { includeContent: include_content }),
    ...(exa_search_type !== undefined && { exaSearchType: exa_search_type }),
    ...(answer_mode !== undefined && { answerMode: answer_mode }),
    ...(search_context_size !== undefined && { searchContextSize: search_context_size }),
    ...(required_capabilities !== undefined && {
      requiredCapabilities: required_capabilities.map(internalCapability),
    }),
  };
}
