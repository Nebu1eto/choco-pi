import type { BoundaryRecord, BoundaryValue } from "../boundary.ts";
import { isObjectValue, isStringValue } from "../boundary.ts";
import {
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import {
  imageContentFromViewImageOutput,
  imageContentsFromViewImageDetails,
  type ViewImageContent,
} from "./output.ts";
import { renderTextWithImages } from "../../ui/tool-rendering/media.ts";
import { renderCodexToolCell } from "../../ui/tool-rendering/codex-tool-cell.ts";
import { supportsViewImageInputs } from "../../adapter/tool-support.ts";

function memoizedImport<Module>(loader: () => Promise<Module>): () => Promise<Module> {
  let promise: Promise<Module> | undefined;
  return () => (promise ??= loader());
}

const loadNativeBinary = memoizedImport(() => import("../native/binary.ts"));
const loadNativeRunner = memoizedImport(() => import("../native/runner.ts"));
const loadSse = memoizedImport(() => import("../../providers/openai-codex/sse.ts"));
const loadToolProvider = memoizedImport(() => import("../../adapter/codex-tool-provider.ts"));

const VIEW_IMAGE_UNSUPPORTED_MESSAGE =
  "view_image is not allowed because you do not support image inputs";
const IMAGE_DESCRIPTION_MODEL = "gpt-5.6-luna";
const IMAGE_DESCRIPTION_PROMPT =
  "Describe this image in detail. Output only the image description, no other commentary";
interface ViewImageParams {
  path: string;
}

interface CreateViewImageToolOptions {
  customRustBinariesDir?: string | undefined;
  describeForTextModels?: boolean | undefined;
  customRendering?: boolean | undefined;
  promptSnippet?: boolean | undefined;
}

type ViewImageParameters = ReturnType<typeof createViewImageParameters>;

function createViewImageParameters() {
  const properties = { path: Type.String() };
  return Type.Object(properties);
}

export function parseViewImageParams(params: BoundaryValue): ViewImageParams {
  if (!params || !isObjectValue(params) || !("path" in params) || !isStringValue(params.path)) {
    throw new Error("view_image requires a string 'path' parameter");
  }
  if ("detail" in params) {
    const rawDetail = params.detail;
    if (rawDetail !== null && rawDetail !== undefined && !isStringValue(rawDetail)) {
      throw new Error("view_image.detail must be a string when provided");
    }
    if (isStringValue(rawDetail) && rawDetail !== "original") {
      throw new Error(`view_image.detail only supports \`original\`, got \`${rawDetail}\``);
    }
  }
  return { path: params.path.startsWith("@") ? params.path.slice(1) : params.path };
}

function prepareViewImageArguments(args: BoundaryValue): ViewImageParams {
  if (!args || !isObjectValue(args)) {
    // SAFETY: prepareArguments precedes schema validation; execute parses path before use, so invalid input remains available for normal rejection.
    return args as ViewImageParams;
  }

  const prepared: BoundaryRecord = { ...args };
  if (!("path" in prepared)) {
    if ("file_path" in prepared) {
      prepared["path"] = prepared["file_path"]!;
    } else if ("image_path" in prepared) {
      prepared["path"] = prepared["image_path"]!;
    }
  }
  const boundaryValue: BoundaryValue = prepared;
  // SAFETY: The registered schema and parseViewImageParams verify path before the prepared object reaches the binary.
  return boundaryValue as ViewImageParams;
}

async function executeRustViewImageContent(
  params: ViewImageParams,
  cwd: string,
  signal: AbortSignal | undefined,
  customRustBinariesDir?: string | undefined,
): Promise<ViewImageContent> {
  const [{ getBundledToolBinaryPath }, { runBundledTool }] = await Promise.all([
    loadNativeBinary(),
    loadNativeRunner(),
  ]);
  const binary = getBundledToolBinaryPath("view_image", {}, customRustBinariesDir);
  if (!binary) {
    throw new Error(`view_image binary is not bundled for ${process.platform}-${process.arch}`);
  }
  const child = await runBundledTool({
    binary,
    args: [JSON.stringify(params)],
    cwd,
    signal,
    label: "view_image",
  });
  if (child.status !== 0) {
    throw new Error((child.stderr || child.stdout || "view_image failed").trim());
  }
  const imageContent = imageContentFromViewImageOutput(child.stdout);
  if (!imageContent) {
    throw new Error("view_image expected an image file. Use exec_command for text files");
  }
  return imageContent;
}

async function executeRustViewImage(
  params: ViewImageParams,
  cwd: string,
  signal: AbortSignal | undefined,
  customRustBinariesDir?: string | undefined,
): Promise<AgentToolResult<unknown>> {
  const imageContent = await executeRustViewImageContent(
    params,
    cwd,
    signal,
    customRustBinariesDir,
  );
  return { content: [imageContent], details: { viewImage: true } };
}

function extractOutputText(value: BoundaryValue): string | undefined {
  if (!value || !isObjectValue(value)) return undefined;
  const record = value;
  const outputText = record["output_text"];
  if (isStringValue(outputText) && outputText.trim()) return outputText;
  const output = record["output"];
  if (!Array.isArray(output)) return undefined;
  const parts: string[] = [];
  for (const item of output) {
    if (!item || !isObjectValue(item)) continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || !isObjectValue(block)) continue;
      const text = block.text;
      if (isStringValue(text)) parts.push(text);
    }
  }
  const text = parts.join("").trim();
  return text || undefined;
}

function isUsableDescriptionModel(model: ExtensionContext["model"]): boolean {
  return (
    (model?.provider ?? "").toLowerCase() === "openai-codex" &&
    Boolean(model?.api?.includes("responses")) &&
    (!Array.isArray(model?.input) || model.input.includes("image"))
  );
}

function modelVersionScore(id: string): number[] {
  return [...id.matchAll(/\d+/g)].map((match) => Number.parseInt(match[0]!, 10));
}

function compareModelIdsDescending(left: string, right: string): number {
  const a = modelVersionScore(left);
  const b = modelVersionScore(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return right.localeCompare(left);
}

export function resolveImageDescriptionModel(ctx: ExtensionContext): string {
  // SAFETY: ExtensionContext supplies Pi's model registry; this narrows only the documented optional lookup methods used below.
  const registry = ctx.modelRegistry as {
    getAvailable?: () => ExtensionContext["model"][];
    getAll?: () => ExtensionContext["model"][];
    find?: (provider: string, modelId: string) => ExtensionContext["model"] | undefined;
  };
  const models = [...(registry.getAvailable?.() ?? []), ...(registry.getAll?.() ?? [])].filter(
    isUsableDescriptionModel,
  );
  const mini = models
    .filter((model) => model?.id?.toLowerCase().includes("mini"))
    .sort((left, right) => compareModelIdsDescending(left!.id, right!.id))[0];
  if (mini?.id) return mini.id;
  const direct = registry.find?.("openai-codex", IMAGE_DESCRIPTION_MODEL);
  return isUsableDescriptionModel(direct) && direct?.id ? direct.id : IMAGE_DESCRIPTION_MODEL;
}

export async function describeImageContentForTextModel(
  image: ViewImageContent,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<string> {
  const [{ parseSSE }, { codexToolProviderHeaders, resolveCodexResponsesUrl, resolveCodexToolProvider }] =
    await Promise.all([loadSse(), loadToolProvider()]);
  const provider = await resolveCodexToolProvider(ctx);
  const model = resolveImageDescriptionModel(ctx);
  const headers = codexToolProviderHeaders(provider);
  headers.set("accept", "text/event-stream");
  headers.set("OpenAI-Beta", "responses=experimental");
  const response = await fetch(resolveCodexResponsesUrl(provider.baseUrl), {
    method: "POST",
    headers,
    signal: signal ?? null,
    body: JSON.stringify({
      model,
      store: false,
      stream: true,
      instructions: IMAGE_DESCRIPTION_PROMPT,
      text: { verbosity: "low" },
      reasoning: { effort: "low", summary: "auto" },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Describe the image" },
            {
              type: "input_image",
              image_url: `data:${image.mimeType};base64,${image.data}`,
              detail: image.detail,
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok)
    throw new Error(
      `view_image description failed: HTTP ${response.status} ${await response.text()}`,
    );
  let text = "";
  for await (const event of parseSSE(response, signal)) {
    if (!isObjectValue(event)) continue;
    const record = event;
    if (record["type"] === "response.output_text.delta" && isStringValue(record["delta"]))
      text += record["delta"];
    if (
      record["type"] === "response.output_text.done" &&
      !text.trim() &&
      isStringValue(record["text"])
    )
      text = record["text"];
    if (record["type"] === "response.completed" && !text.trim())
      text = extractOutputText(record["response"]) ?? "";
  }
  const trimmed = text.trim();
  if (!trimmed) throw new Error("view_image description returned no text");
  return trimmed;
}

export function createViewImageTool(
  options: CreateViewImageToolOptions = {},
): ToolDefinition<ViewImageParameters> {
  const parameters = createViewImageParameters();

  const tool: ToolDefinition<ViewImageParameters> = {
    name: "view_image",
    label: "view_image",
    description: "View image",
    parameters,
    prepareArguments: prepareViewImageArguments,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!supportsViewImageInputs(ctx.model) && !options.describeForTextModels) {
        throw new Error(VIEW_IMAGE_UNSUPPORTED_MESSAGE);
      }
      const typedParams = parseViewImageParams(params);
      if (!supportsViewImageInputs(ctx.model)) {
        const image = await executeRustViewImageContent(
          typedParams,
          ctx.cwd,
          signal,
          options.customRustBinariesDir,
        );
        const description = await describeImageContentForTextModel(image, ctx, signal);
        return {
          content: [{ type: "text", text: description }],
          details: { viewImageDescription: { image, path: typedParams.path, description } },
        };
      }
      return executeRustViewImage(typedParams, ctx.cwd, signal, options.customRustBinariesDir);
    },
  };
  if (options.promptSnippet !== false) tool.promptSnippet = "View image";
  if (options.customRendering !== false) {
    tool.renderCall = (args, theme) =>
      renderCodexToolCell(
        "Viewed Image",
        isStringValue(args["path"]!) ? args["path"]! : undefined,
        theme,
      );
    tool.renderResult = (result, { isPartial }, theme, context) => {
      if (isPartial) return new Text(theme.fg("warning", "Loading image..."), 0, 0);
      const textBlock = result.content.find((item) => item.type === "text");
      const text = theme.fg("dim", textBlock?.type === "text" ? textBlock.text : "");
      const content = result.content.some((item) => item.type === "image")
        ? result.content
        : [...result.content, ...imageContentsFromViewImageDetails(result.details)];
      return renderTextWithImages(text, content, theme, {
        showImages: context.showImages,
        cwd: context.cwd,
        imagePaths: [isStringValue(context.args.path) ? context.args.path : undefined],
      });
    };
  }
  return tool;
}

export function registerViewImageTool(
  pi: ExtensionAPI,
  options: CreateViewImageToolOptions = {},
): void {
  pi.registerTool(createViewImageTool(options));
}
