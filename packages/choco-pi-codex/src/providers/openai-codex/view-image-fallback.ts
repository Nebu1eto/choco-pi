/**
 * OpenAI-side text-model fallback for the provider-neutral view_image tool.
 *
 * The universal tool (`src/tools/view-image/tool.ts`) accepts an injected
 * `ImageDescribeFallbackPort`; this module implements it over the OpenAI
 * Responses endpoint the Codex tool provider resolves, and the extension
 * composition root (`src/extension/`) wires it in.
 */
import { memoizedImport } from "../../memoized-import.ts";
import type { BoundaryValue } from "../../tools/boundary.ts";
import { isObjectValue, isStringValue } from "../../tools/boundary.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ViewImageContent } from "../../tools/view-image/output.ts";
import type { ImageDescribeFallbackPort } from "../../tools/view-image/tool.ts";
import { OPENAI_PLATFORM_BASE_URL } from "../../adapter/openai-sign-in.ts";

const loadSse = memoizedImport(() => import("./sse.ts"));
const loadToolProvider = memoizedImport(() => import("../../adapter/codex-tool-provider.ts"));

const IMAGE_DESCRIPTION_MODEL = "gpt-5.6-luna";
const OPENAI_PLATFORM_RESPONSES_URL = `${OPENAI_PLATFORM_BASE_URL}/responses`;
const IMAGE_DESCRIPTION_PROMPT =
  "Describe this image in detail. Output only the image description, no other commentary";
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

function isUsableDescriptionModel(
  model: ExtensionContext["model"],
  providerName: string = "openai-codex",
): boolean {
  return (
    (model?.provider ?? "").toLowerCase() === providerName &&
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

/** Pick the description model from the provider whose credential will be used. */
export function resolveImageDescriptionModel(
  ctx: ExtensionContext,
  providerName: "openai-codex" | "openai" = "openai-codex",
): string {
  // SAFETY: ExtensionContext supplies Pi's model registry; this narrows only the documented optional lookup methods used below.
  const registry = ctx.modelRegistry as {
    getAvailable?: () => ExtensionContext["model"][];
    getAll?: () => ExtensionContext["model"][];
    find?: (provider: string, modelId: string) => ExtensionContext["model"] | undefined;
  };
  const models = [...(registry.getAvailable?.() ?? []), ...(registry.getAll?.() ?? [])].filter(
    (model) => isUsableDescriptionModel(model, providerName),
  );
  const mini = models
    .filter((model) => model?.id?.toLowerCase().includes("mini"))
    .sort((left, right) => compareModelIdsDescending(left!.id, right!.id))[0];
  if (mini?.id) return mini.id;
  const direct = registry.find?.(providerName, IMAGE_DESCRIPTION_MODEL);
  return isUsableDescriptionModel(direct, providerName) && direct?.id
    ? direct.id
    : IMAGE_DESCRIPTION_MODEL;
}

export async function describeImageContentForTextModel(
  image: ViewImageContent,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<string> {
  const [
    { parseSSE },
    { codexToolProviderHeaders, resolveCodexResponsesUrl, resolveCodexToolProvider },
  ] = await Promise.all([loadSse(), loadToolProvider()]);
  const provider = await resolveCodexToolProvider(ctx);
  const openAIPlatform = Boolean(provider.openAIPlatform);
  const model = resolveImageDescriptionModel(ctx, openAIPlatform ? "openai" : "openai-codex");
  const headers = codexToolProviderHeaders(provider);
  headers.set("accept", "text/event-stream");
  headers.set("OpenAI-Beta", "responses=experimental");
  const responsesUrl = openAIPlatform
    ? OPENAI_PLATFORM_RESPONSES_URL
    : resolveCodexResponsesUrl(provider.baseUrl);
  const response = await fetch(responsesUrl, {
    method: "POST",
    headers,
    signal: signal ?? null,
    body: JSON.stringify({
      model,
      store: false,
      stream: true,
      instructions: IMAGE_DESCRIPTION_PROMPT,
      text: { verbosity: "low" },
      // api.openai.com may gate reasoning summaries behind org verification; the description needs none.
      reasoning: openAIPlatform ? { effort: "low" } : { effort: "low", summary: "auto" },
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

/** The OpenAI implementation of the view_image text-model fallback port. */
export const openAIImageDescribeFallback: ImageDescribeFallbackPort = (image, ctx, signal) =>
  describeImageContentForTextModel(image, ctx, signal);
