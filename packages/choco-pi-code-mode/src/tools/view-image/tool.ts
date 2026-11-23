import { memoizedImport } from "../../memoized-import.ts";
import type { BoundaryRecord, BoundaryValue } from "../boundary.ts";
import { isObjectValue, isStringValue } from "../boundary.ts";
import {
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { obj, str } from "@earendil-works/pi-schema";
import { hostParams } from "../../schema-bridge.ts";
import { Text } from "@earendil-works/pi-tui";
import {
  imageContentFromViewImageOutput,
  imageContentsFromViewImageDetails,
  type ViewImageContent,
} from "./output.ts";
import { renderTextWithImages } from "../../ui/tool-rendering/media.ts";
import { renderCodexToolCell } from "../../ui/tool-rendering/codex-tool-cell.ts";
import { supportsViewImageInputs } from "../../adapter/tool-support.ts";

const loadNativeBinary = memoizedImport(() => import("../native/binary.ts"));
const loadNativeRunner = memoizedImport(() => import("../native/runner.ts"));

const VIEW_IMAGE_UNSUPPORTED_MESSAGE =
  "view_image is not allowed because you do not support image inputs";
interface ViewImageParams {
  path: string;
}

export type ImageDescribeFallbackPort = (
  image: ViewImageContent,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
) => Promise<string>;

interface CreateViewImageToolOptions {
  customRustBinariesDir?: string | undefined;
  describeForTextModels?: boolean | undefined;
  describeImage?: ImageDescribeFallbackPort | undefined;
  customRendering?: boolean | undefined;
  promptSnippet?: boolean | undefined;
}

type ViewImageParameters = ReturnType<typeof createViewImageParameters>;

function createViewImageParameters() {
  return hostParams(obj({ path: str() }, { open: true }));
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

export function createViewImageTool(
  options: CreateViewImageToolOptions = {},
): ToolDefinition<ViewImageParameters> {
  const parameters = createViewImageParameters();
  const describeImage = options.describeForTextModels ? options.describeImage : undefined;

  const tool: ToolDefinition<ViewImageParameters> = {
    name: "view_image",
    label: "view_image",
    description: "View image",
    parameters,
    prepareArguments: prepareViewImageArguments,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!supportsViewImageInputs(ctx.model) && !describeImage) {
        throw new Error(VIEW_IMAGE_UNSUPPORTED_MESSAGE);
      }
      const typedParams = parseViewImageParams(params);
      if (describeImage && !supportsViewImageInputs(ctx.model)) {
        const image = await executeRustViewImageContent(
          typedParams,
          ctx.cwd,
          signal,
          options.customRustBinariesDir,
        );
        const description = await describeImage(image, ctx, signal);
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
