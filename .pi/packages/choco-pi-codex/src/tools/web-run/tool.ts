import type { BoundaryRecord, BoundaryValue } from "../boundary.ts";
import { isFunctionValue, isObjectValue, isStringValue } from "../boundary.ts";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { formatNativeBinaryError, nativeBinaryRecoveryMessage } from "../../native-binary-error.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";
import {
  codexToolProviderEnv,
  CODEX_TOOL_PROVIDER_UNSUPPORTED_MESSAGE,
  resolveCodexToolProvider,
} from "../../adapter/codex-tool-provider.ts";
import { WEB_SEARCH_TOOL_NAME } from "../../adapter/activation/tool-set.ts";
import { supportsNativeWebSearch } from "../../adapter/tool-support.ts";
import { renderCodexToolCell } from "../../ui/tool-rendering/codex-tool-cell.ts";
import { getBundledToolBinaryPath } from "../native/binary.ts";
import { buildWebSearchInput } from "./history.ts";

export const WEB_SEARCH_UNSUPPORTED_MESSAGE = CODEX_TOOL_PROVIDER_UNSUPPORTED_MESSAGE;

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

interface WebRunRequest extends BoundaryRecord {
  id: string | undefined;
  model?: string | undefined;
  input?: NonNullable<ReturnType<typeof buildWebSearchInput>> | undefined;
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
  customRendering?: boolean | undefined;
  promptSnippet?: boolean | undefined;
}

async function runWebRunBinary(
  webRunPath: string,
  params: BoundaryRecord,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(webRunPath, ["-"], {
      env,
      signal: signal ?? undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stdinError: Error | undefined;
    let stdinErrorTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (stdinErrorTimer) clearTimeout(stdinErrorTimer);
      callback();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) =>
      finish(() =>
        reject(new Error(formatNativeBinaryError("web_run", error, { binaryPath: webRunPath }))),
      ),
    );
    child.on("close", (code) =>
      finish(() => {
        const detail = stderr.trim() || `web_run exited with code ${code ?? "unknown"}`;
        const nativeFailure =
          code === 0 ? undefined : nativeBinaryRecoveryMessage("web_run", detail);
        if (nativeFailure) reject(new Error(nativeFailure));
        else if (stdinError) reject(stdinError);
        else if (code === 0) resolve(stdout);
        else reject(new Error(detail));
      }),
    );
    child.stdin.on("error", (error) => {
      if (settled) return;
      stdinError = error;
      child.kill();
      stdinErrorTimer = setTimeout(() => finish(() => reject(error)), 50);
    });
    child.stdin.end(JSON.stringify(params));
  });
}

function formatWebRunOutput(parsed: BoundaryRecord): string | undefined {
  const outputText = parsed["output"] ?? parsed["output_text"] ?? parsed["text"];
  if (isStringValue(outputText) && outputText.trim()) return outputText;
  if (parsed["search_results"] !== undefined) return JSON.stringify(parsed, null, 2);
  if (
    Array.isArray(parsed["content"]) ||
    Array.isArray(parsed["open"]) ||
    Array.isArray(parsed["find"])
  )
    return JSON.stringify(parsed, null, 2);
  return undefined;
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
  const webRunPath =
    process.env["PI_CODEX_WEB_RUN_BIN"]?.trim() ||
    getBundledToolBinaryPath("web_run", {}, options.customRustBinariesDir);
  if (!webRunPath)
    throw new Error(`web_run binary is not bundled for ${process.platform}-${process.arch}`);
  const provider = await resolveCodexToolProvider(ctx, options.allowConfiguredProvider);
  const sessionId = ctx.sessionManager?.getSessionId?.() || options.sessionId;
  const configuredModel = isFunctionValue(options.model) ? options.model() : options.model;
  const model = provider.route === "configured-responses" ? provider.model : configuredModel;
  const env = codexToolProviderEnv(provider);
  const input = SEND_NATIVE_WEB_SEARCH_HISTORY
    ? buildWebSearchInput(ctx.sessionManager.buildContextEntries())
    : undefined;
  try {
    const request: WebRunRequest = { ...params, id: sessionId };
    if (model) request["model"] = model;
    if (input) request["input"] = input;
    const stdout = await runWebRunBinary(webRunPath, request, env, signal);
    const parsed: unknown = JSON.parse(stdout);
    if (!isObjectValue(parsed)) throw new Error("web_run returned invalid structured JSON output");
    const output = formatWebRunOutput(parsed);
    if (output) return { text: output, details: parsed };
    throw new Error("web_run search returned no output");
  } catch (error) {
    const stderr =
      error && isObjectValue(error) && "stderr" in error ? String(error.stderr ?? "") : "";
    const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(message);
  }
}

export function createWebSearchTool(
  name: string = WEB_SEARCH_TOOL_NAME,
  options: WebSearchToolOptions = {},
): ToolDefinition<typeof WEB_SEARCH_PARAMETERS> {
  const toolOptions = { sessionId: randomUUID(), ...options };
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
