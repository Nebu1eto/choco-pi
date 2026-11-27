import type { Static } from "@earendil-works/pi-schema";
import type { SearchCapability, canonicalSearchParams } from "./index.ts";

export type CanonicalSearchParams = Static<typeof canonicalSearchParams>;

export function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

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

export const SNAKE_CAPABILITY_NAMES: string[] = [...CAPABILITY_BY_SNAKE.keys()];

export function internalCapability(value: string): SearchCapability {
  const capability = CAPABILITY_BY_SNAKE.get(value);
  if (capability === undefined) {
    throw new Error(
      `required_capabilities contains an unsupported value "${value}"; use one of ${SNAKE_CAPABILITY_NAMES.join(", ")}.`,
    );
  }
  return capability;
}

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
  | "providerOptions"
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
  provider_options?: CanonicalSearchParams["providerOptions"];
  summary?: boolean;
};

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
  "providerOptions",
];

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

export function toCanonicalSearchParams(
  params: SnakeWebSearchParams,
): CanonicalSearchParams & Pick<SnakeWebSearchParams, "summary"> {
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
    provider_options,
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
    ...(provider_options !== undefined && { providerOptions: provider_options }),
  };
}
