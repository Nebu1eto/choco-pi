import { isStringValue } from "../boundary.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { Text } from "@earendil-works/pi-tui";
import {
  codexToolProviderEnv,
  resolveCodexToolProvider,
} from "../../adapter/codex-tool-provider.ts";
import { IMAGE_GENERATION_TOOL_NAME } from "../../adapter/activation/tool-set.ts";
import { supportsNativeImageGeneration } from "../../adapter/tool-support.ts";
import { getBundledToolBinaryPath } from "../native/binary.ts";
import {
  formatImagegenOutput,
  imageContentsFromImagegenOutput,
  imagegenOutputFromJson,
} from "./output.ts";
import { renderTextWithImages } from "../../ui/tool-rendering/media.ts";
import { runBundledTool } from "../native/runner.ts";
import { renderCodexToolCell } from "../../ui/tool-rendering/codex-tool-cell.ts";

export const IMAGE_GENERATION_UNSUPPORTED_MESSAGE =
  "imagegen requires an image-capable OpenAI Codex-compatible Responses provider";
const IMAGE_GENERATION_PARAMETERS = Type.Object({
  prompt: Type.String(),
  action: Type.Optional(
    Type.Union([Type.Literal("generate"), Type.Literal("edit")], {
      description: "Default generate",
    }),
  ),
  images: Type.Optional(Type.Array(Type.String(), { description: "Edit inputs" })),
});

type ImagegenArgs = {
  prompt: string;
  action?: "generate" | "edit" | undefined;
  images?: string[] | undefined;
};

type SavedImage = {
  path: string;
  absolute_path: string;
  latest_path?: string;
  latest_absolute_path?: string;
};

// Keep the post-parse validation aligned with imagegenOutputFromJson: only `path` is mandatory.
const ImagegenDetailsSchema = Type.Unsafe<ImagegenDetails>({
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
});

type ImagegenDetails = {
  path: string;
  latest_path: string;
  images: SavedImage[];
  background?: string | undefined;
  quality?: string | undefined;
  size?: string | undefined;
};

function supportsImageInputs(model: ExtensionContext["model"]): boolean {
  return !Array.isArray(model?.input) || model.input.includes("image");
}

function supportsExecutableImageGeneration(
  model: ExtensionContext["model"],
  options: ImageGenerationToolOptions,
): boolean {
  return (
    supportsNativeImageGeneration(model) ||
    Boolean(options.allowConfiguredProvider?.(model)) ||
    options.allowCodexProviderFallback === true
  );
}

async function executeRustImagegen(
  args: ImagegenArgs,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  options: ImageGenerationToolOptions,
): Promise<ImagegenDetails> {
  if (signal?.aborted) throw new Error("imagegen aborted");
  const binary = getBundledToolBinaryPath("imagegen", {}, options.customRustBinariesDir);
  if (!binary)
    throw new Error(`imagegen binary is not bundled for ${process.platform}-${process.arch}`);
  const provider = await resolveCodexToolProvider(ctx, options.allowConfiguredProvider);
  const child = await runBundledTool({
    binary,
    args: [JSON.stringify({ ...args, cwd: ctx.cwd })],
    cwd: ctx.cwd,
    env: codexToolProviderEnv(provider),
    signal,
    label: IMAGE_GENERATION_TOOL_NAME,
  });
  if (child.status !== 0)
    throw new Error((child.stderr || child.stdout || "imagegen failed").trim());
  const parsed = imagegenOutputFromJson(child.stdout);
  if (!Value.Check(ImagegenDetailsSchema, parsed)) {
    throw new Error("imagegen returned output, but Pi could not parse it");
  }
  return parsed;
}

export interface ImageGenerationToolOptions {
  customRustBinariesDir?: string | undefined;
  allowConfiguredProvider?: ((model: ExtensionContext["model"]) => boolean) | undefined;
  allowCodexProviderFallback?: boolean | undefined;
  customRendering?: boolean | undefined;
  promptSnippet?: boolean | undefined;
}

export function createImageGenerationTool(
  options: ImageGenerationToolOptions = {},
): ToolDefinition<typeof IMAGE_GENERATION_PARAMETERS, ImagegenDetails> {
  const description = "Generate/edit images";
  const tool: ToolDefinition<typeof IMAGE_GENERATION_PARAMETERS, ImagegenDetails> = {
    name: IMAGE_GENERATION_TOOL_NAME,
    label: IMAGE_GENERATION_TOOL_NAME,
    description,
    parameters: IMAGE_GENERATION_PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!supportsExecutableImageGeneration(ctx.model, options))
        throw new Error(IMAGE_GENERATION_UNSUPPORTED_MESSAGE);
      const details = await executeRustImagegen(params, signal, ctx, options);
      const imageContent = supportsImageInputs(ctx.model)
        ? imageContentsFromImagegenOutput(details)
        : [];
      return {
        content: [{ type: "text", text: formatImagegenOutput(details) }, ...imageContent],
        details,
      };
    },
  };
  if (options.promptSnippet !== false) tool.promptSnippet = description;
  if (options.customRendering !== false) {
    tool.renderCall = (args, theme) =>
      renderCodexToolCell(
        "Generated Image:",
        isStringValue(args.prompt) ? args.prompt : undefined,
        theme,
      );
    tool.renderResult = (result, _options, theme, context) => {
      const textBlock = result.content.find((item) => item.type === "text");
      const text = theme.fg("dim", textBlock?.type === "text" ? textBlock.text : "(no output)");
      return result.content.some((item) => item.type === "image")
        ? renderTextWithImages(text, result.content, theme, {
            showImages: context.showImages,
            cwd: context.cwd,
            imagePaths: result.details.images.map((image) => image.absolute_path),
          })
        : new Text(text, 0, 0);
    };
  }
  return tool;
}

export function registerImageGenerationTool(
  pi: ExtensionAPI,
  options: ImageGenerationToolOptions = {},
): void {
  pi.registerTool(createImageGenerationTool(options));
}
