import type { BoundaryRecord, BoundaryValue } from "../boundary.ts";
import { isFunctionValue, isObjectValue, isStringValue } from "../boundary.ts";
import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";
import { WEB_SEARCH_TOOL_NAME } from "../../adapter/activation/tool-set.ts";
import { supportsNativeWebSearch } from "../../adapter/tool-support.ts";
import { renderCodexToolCell } from "../../ui/tool-rendering/codex-tool-cell.ts";
import { buildWebSearchInput } from "./history.ts";

function memoizedImport<Module>(loader: () => Promise<Module>): () => Promise<Module> {
  let promise: Promise<Module> | undefined;
  return () => (promise ??= loader());
}

const loadNativeBinary = memoizedImport(() => import("../native/binary.ts"));
const loadToolProvider = memoizedImport(() => import("../../adapter/codex-tool-provider.ts"));
const loadWebRunBackend = memoizedImport(() => import("./backend.ts"));

export const WEB_SEARCH_UNSUPPORTED_MESSAGE =
  "web_run/imagegen requires an OpenAI Codex-compatible Responses provider or /login openai-codex";

// Codex sends the recent visible turn in SearchRequest.input. Controlled
// alpha/search comparisons showed no meaningful output benefit, so Pi keeps
// the compatible builder dormant rather than disclose conversation context.
const SEND_NATIVE_WEB_SEARCH_HISTORY = false;

const SearchQueryParameters = Type.Object(
  {
    q: Type.String(),
    recency: Type.Optional(Type.Number({ description: "Recent days" })),
    domains: Type.Optional(Type.Array(Type.String(), { description: "Domains" })),
  },
  { additionalProperties: true },
);

const WEB_SEARCH_PARAMETERS = Type.Object(
  {
    search_query: Type.Optional(Type.Array(SearchQueryParameters)),
    image_query: Type.Optional(Type.Array(SearchQueryParameters)),
    open: Type.Optional(
      Type.Array(
        Type.Object(
          { ref_id: Type.String(), lineno: Type.Optional(Type.Number()) },
          { additionalProperties: true },
        ),
        { description: "ref_id or URL" },
      ),
    ),
    click: Type.Optional(
      Type.Array(
        Type.Object({ ref_id: Type.String(), id: Type.Number() }, { additionalProperties: true }),
      ),
    ),
    find: Type.Optional(
      Type.Array(
        Type.Object(
          { ref_id: Type.String(), pattern: Type.String() },
          { additionalProperties: true },
        ),
      ),
    ),
    response_length: Type.Optional(
      Type.Union([Type.Literal("short"), Type.Literal("medium"), Type.Literal("long")], {
        description: "Answer length",
      }),
    ),
    settings: Type.Optional(
      Type.Object(
        {
          search_context_size: Type.Optional(
            Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
          ),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);
function createEmptyResultComponent(): Container {
  return new Container();
}

type WebRunOutput = BoundaryRecord;

type WebRunExecutionResult = { text: string; details: WebRunOutput };

function firstString(value: BoundaryValue, key: string): string | undefined {
  if (!value || !isObjectValue(value)) return undefined;
  const field = value[key];
  return isStringValue(field) && field.trim() ? field.trim() : undefined;
}

function webSearchCallDetail(params: BoundaryRecord): string | undefined {
  const search = Array.isArray(params["search_query"]!) ? params["search_query"]![0] : undefined;
  const image = Array.isArray(params["image_query"]!) ? params["image_query"]![0] : undefined;
  const open = Array.isArray(params["open"]!) ? params["open"]![0] : undefined;
  const click = Array.isArray(params["click"]!) ? params["click"]![0] : undefined;
  const find = Array.isArray(params["find"]!) ? params["find"]![0] : undefined;
  const query = firstString(search, "q") ?? firstString(image, "q");
  if (query) return query;
  const opened =
    firstString(open, "url") ?? firstString(open, "ref_id") ?? firstString(click, "ref_id");
  if (opened) return opened;
  const pattern = firstString(find, "pattern");
  if (pattern) return `'${pattern}'`;
  return undefined;
}

export interface WebSearchToolOptions {
  customRustBinariesDir?: string | undefined;
  sessionId?: string | undefined;
  model?: string | (() => string | undefined) | undefined;
  allowConfiguredProvider?: ((model: ExtensionContext["model"]) => boolean) | undefined;
  allowCodexProviderFallback?: boolean | undefined;
  /** Explicit owner id for adapter callers. Takes precedence over ctx.sessionManager. */
  sessionIdOverride?: boolean | undefined;
  isSessionCurrent?: (() => boolean) | undefined;
  customRendering?: boolean | undefined;
  promptSnippet?: boolean | undefined;
}

function supportsExecutableWebSearch(
  model: ExtensionContext["model"],
  options: WebSearchToolOptions,
): boolean {
  return (
    supportsNativeWebSearch(model) ||
    Boolean(options.allowConfiguredProvider?.(model)) ||
    options.allowCodexProviderFallback === true
  );
}

export async function executeCodexWebSearch(
  params: BoundaryRecord,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined | null,
  options: WebSearchToolOptions = {},
): Promise<WebRunExecutionResult> {
  const sessionManager = ctx.sessionManager;
  const modelRegistry = ctx.modelRegistry;
  const currentModel = ctx.model;
  const contextSessionId = sessionManager.getSessionId();
  const sessionId =
    options.sessionIdOverride === true ? options.sessionId : contextSessionId || options.sessionId;
  if (!sessionId) throw new Error("web_run requires a session owner id");
  const configuredModelOption = options.model;
  const configuredModel = isFunctionValue(configuredModelOption)
    ? configuredModelOption()
    : configuredModelOption;
  const configuredProvider = options.allowConfiguredProvider;
  const customRustBinariesDir = options.customRustBinariesDir;
  const historyInput = SEND_NATIVE_WEB_SEARCH_HISTORY
    ? buildWebSearchInput(sessionManager.buildContextEntries())
    : undefined;
  const isSessionCurrent =
    options.isSessionCurrent ?? (() => sessionManager.getSessionId() === contextSessionId);
  if (signal?.aborted) throw new Error("web_run was cancelled");
  if (!isSessionCurrent()) throw new Error("web_run session is no longer current");
  const [
    { getBundledToolBinaryPath },
    { resolveCodexToolProvider },
    { CodexWebRunTransportError, executeConfiguredCodexWebRun },
  ] = await Promise.all([loadNativeBinary(), loadToolProvider(), loadWebRunBackend()]);
  if (signal?.aborted) throw new Error("web_run was cancelled");
  if (!isSessionCurrent()) throw new Error("web_run session is no longer current");
  const webRunPath =
    process.env["PI_CODEX_WEB_RUN_BIN"]?.trim() ||
    getBundledToolBinaryPath("web_run", {}, customRustBinariesDir);
  if (!webRunPath)
    throw new CodexWebRunTransportError(
      "missing_binary",
      `web_run binary is not bundled for ${process.platform}-${process.arch}`,
    );
  const provider = await resolveCodexToolProvider(
    { model: currentModel, modelRegistry },
    configuredProvider,
  );
  if (signal?.aborted) throw new Error("web_run was cancelled");
  if (!isSessionCurrent()) throw new Error("web_run session is no longer current");
  const model = provider.route === "configured-responses" ? provider.model : configuredModel;
  const requestParams: BoundaryRecord = { ...params };
  if (historyInput) requestParams["input"] = historyInput;
  return executeConfiguredCodexWebRun({
    binaryPath: webRunPath,
    params: requestParams,
    provider,
    sessionId,
    model,
    signal,
    isSessionCurrent,
  });
}

export function createWebSearchTool(
  name: string = WEB_SEARCH_TOOL_NAME,
  options: WebSearchToolOptions = {},
): ToolDefinition<typeof WEB_SEARCH_PARAMETERS> {
  const toolOptions = {
    sessionId: randomUUID(),
    ...options,
    sessionIdOverride: options.sessionId !== undefined,
  };
  // SAFETY: The Pi tool API provides object arguments to prepareArguments; the record check preserves that shape.
  const tool: ToolDefinition<typeof WEB_SEARCH_PARAMETERS> = {
    name,
    label: name,
    description: "Search/open web",
    parameters: WEB_SEARCH_PARAMETERS,
    prepareArguments: (args) => (args && isObjectValue(args) ? args : {}),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!supportsExecutableWebSearch(ctx.model, toolOptions))
        throw new Error(WEB_SEARCH_UNSUPPORTED_MESSAGE);
      const output = await executeCodexWebSearch(params, ctx, signal, toolOptions);
      return {
        content: [{ type: "text", text: output.text }],
        details: { webRun: output.details },
      };
    },
  };
  if (toolOptions.promptSnippet !== false) tool.promptSnippet = "Use explicit args";
  if (toolOptions.customRendering !== false) {
    tool.renderCall = (args, theme) => {
      // SAFETY: The renderer receives the parameter object validated by the registered tool schema.
      return renderCodexToolCell(
        "Searched the web",
        webSearchCallDetail(args as BoundaryRecord),
        theme,
      );
    };
    tool.renderResult = (result, { expanded }, theme) => {
      if (!expanded) return createEmptyResultComponent();
      const textBlock = result.content.find((item) => item.type === "text");
      return new Text(
        theme.fg("dim", textBlock?.type === "text" ? textBlock.text : "(no output)"),
        0,
        0,
      );
    };
  }
  return tool;
}

export function registerWebSearchTool(
  pi: ExtensionAPI,
  name: string = WEB_SEARCH_TOOL_NAME,
  options: WebSearchToolOptions = {},
): void {
  pi.registerTool(createWebSearchTool(name, options));
}
