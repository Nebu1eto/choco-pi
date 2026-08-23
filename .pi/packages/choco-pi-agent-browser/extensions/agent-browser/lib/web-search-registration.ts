import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_WEB_SEARCH_PROVIDER,
  WEB_SEARCH_PROVIDERS,
  type AgentBrowserConfigState,
} from "./config.ts";
import { JsonSchema, type JsonSchemaBuilder } from "./json-schema.ts";
import { WEB_SEARCH_PROMPT_GUIDELINE } from "./playbook.ts";
import { StringEnum as localStringEnum, type StringEnumBuilder } from "./string-enum-schema.ts";
import type { createAgentBrowserWebSearchTool as createRuntimeWebSearchTool } from "./web-search.ts";

export const AGENT_BROWSER_WEB_SEARCH_TOOL_NAME = "agent_browser_web_search";
export const DEFAULT_SEARCH_RESULT_COUNT = 5;
export const MAX_SEARCH_RESULT_COUNT = 10;
export const EXA_SEARCH_TYPES = [
  "auto",
  "fast",
  "instant",
  "deep-lite",
  "deep",
  "deep-reasoning",
] as const;
export type ExaSearchType = (typeof EXA_SEARCH_TYPES)[number];
export const WEB_SEARCH_PROVIDER_PARAM_VALUES = ["auto", ...WEB_SEARCH_PROVIDERS] as const;
export type WebSearchProviderParam = (typeof WEB_SEARCH_PROVIDER_PARAM_VALUES)[number];

export type SearchFreshness = "pd" | "pw" | "pm" | "py";

export type WebSearchToolDetails = {
  provider: "brave" | "exa";
  query: string;
  returnedQuery: string;
  count: number;
  offset: number;
  fetchedAt: string;
  results: Array<{
    title: string;
    url: string;
    description?: string;
    highlights?: string[];
    source?: string;
    age?: string;
    language?: string;
  }>;
  searchType?: string;
  requestId?: string;
};

export type AgentBrowserWebSearchParamsInput = {
  country?: string;
  count?: number;
  freshness?: SearchFreshness;
  offset?: number;
  provider?: WebSearchProviderParam;
  query: string;
  safesearch?: "off" | "moderate" | "strict";
  searchLang?: string;
  searchType?: ExaSearchType;
};

export function createAgentBrowserWebSearchParamsSchema(
  Type: JsonSchemaBuilder = JsonSchema,
  StringEnum: StringEnumBuilder = localStringEnum,
) {
  return Type.Object(
    {
      query: Type.String({
        minLength: 1,
        description: "Search query to run with the configured Exa or Brave web search provider.",
      }),
      provider: Type.Optional(
        StringEnum(WEB_SEARCH_PROVIDER_PARAM_VALUES, {
          description: `Optional provider override. auto uses configured keys and preferredProvider; when both Exa and Brave are available, the default preferred provider is ${DEFAULT_WEB_SEARCH_PROVIDER}.`,
        }),
      ),
      searchType: Type.Optional(
        StringEnum(EXA_SEARCH_TYPES, {
          description:
            "Optional Exa search type. Defaults to auto; ignored by Brave. Use deep/deep-reasoning only for harder research because they are slower.",
        }),
      ),
      count: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_SEARCH_RESULT_COUNT,
          description: `Number of web results to return. Defaults to ${DEFAULT_SEARCH_RESULT_COUNT}; max ${MAX_SEARCH_RESULT_COUNT}.`,
        }),
      ),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 9,
          description: "Zero-based result offset for pagination. Defaults to 0.",
        }),
      ),
      country: Type.Optional(
        Type.String({
          pattern: "^[A-Za-z]{2}$",
          description: "Optional 2-letter country code, such as US or GB.",
        }),
      ),
      searchLang: Type.Optional(
        Type.String({
          minLength: 2,
          maxLength: 8,
          description: "Optional Brave search language code, such as en or en-US.",
        }),
      ),
      safesearch: Type.Optional(
        StringEnum(["off", "moderate", "strict"] as const, {
          description:
            "Optional search safety setting. Brave forwards this as safesearch; Exa maps moderate/strict to moderation=true.",
        }),
      ),
      freshness: Type.Optional(
        StringEnum(["pd", "pw", "pm", "py"] as const, {
          description:
            "Optional freshness window: pd=past day, pw=past week, pm=past month, py=past year.",
        }),
      ),
    },
    { additionalProperties: false },
  );
}

export const AgentBrowserWebSearchParams = createAgentBrowserWebSearchParamsSchema();

type RuntimeWebSearchTool = ReturnType<typeof createRuntimeWebSearchTool>;

export function createDeferredAgentBrowserWebSearchTool(
  configState: AgentBrowserConfigState,
  options: {
    loadConfigState?: (ctx: {
      cwd: string;
      isProjectTrusted?: () => boolean;
    }) => AgentBrowserConfigState;
  } = {},
) {
  let runtimeToolPromise: Promise<RuntimeWebSearchTool> | undefined;
  const getRuntimeTool = (): Promise<RuntimeWebSearchTool> => {
    runtimeToolPromise ??= import("./web-search.ts").then(({ createAgentBrowserWebSearchTool }) =>
      createAgentBrowserWebSearchTool(configState, options),
    );
    return runtimeToolPromise;
  };
  return {
    name: AGENT_BROWSER_WEB_SEARCH_TOOL_NAME,
    label: "Agent Browser Web Search",
    description: `Search the web with Exa or Brave when configured. Returns up to ${MAX_SEARCH_RESULT_COUNT} concise web results.`,
    promptSnippet: "Search the live web with Exa or Brave for current or external information.",
    promptGuidelines: [
      WEB_SEARCH_PROMPT_GUIDELINE,
      "agent_browser_web_search chooses Exa or Brave from configured keys; when both are available, Exa is preferred by default unless webSearch.preferredProvider says otherwise. Use provider only when the user/config calls for a specific provider.",
      "Prefer agent_browser_web_search over opening or typing into public search engine result pages with agent_browser when a quick result list is enough; browser-automated search forms are often anti-bot/CAPTCHA-gated, and this tool is the fallback for discovery rather than a CAPTCHA bypass.",
      "Do not issue parallel or repeated agent_browser_web_search calls; use one high-signal query, inspect the results, then only run a focused follow-up if needed. If the provider returns HTTP 429, stop searching and tell the user the API plan/rate limit needs time or a plan change.",
      "After using agent_browser_web_search, cite result URLs in the final answer when web evidence informed the answer.",
    ],
    parameters: AgentBrowserWebSearchParams,
    async execute(
      toolCallId: string,
      params: AgentBrowserWebSearchParamsInput,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<WebSearchToolDetails>,
      ctx?: ExtensionContext,
    ) {
      const runtimeTool = await getRuntimeTool();
      return runtimeTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}
