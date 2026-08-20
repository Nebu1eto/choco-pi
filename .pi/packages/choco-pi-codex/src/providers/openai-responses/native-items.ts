import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const NativeItemValueSchema = Type.Union([
  Type.Unsafe<object>({ type: "object" }),
  Type.Array(Type.Unknown()),
  Type.String(),
  Type.Number(),
  Type.BigInt(),
  Type.Boolean(),
  Type.Symbol(),
  Type.Function([], Type.Unknown()),
  Type.Null(),
]);
type NativeItemValue = Static<typeof NativeItemValueSchema>;
const EncryptedOutputSchema = Type.Object({ encrypted_output: Type.Optional(Type.Unknown()) });
const WebRunDetailsSchema = Type.Object({ webRun: Type.Optional(Type.Unknown()) });
const ImageGenerationBlockSchema = Type.Object({
  type: Type.Literal("image_generation_call"),
  item: Type.Object({ type: Type.Literal("image_generation_call") }),
});
const WebSearchBlockSchema = Type.Object({
  type: Type.Literal("web_search_call"),
  item: Type.Object({ type: Type.Literal("web_search_call") }),
});
const ImageGenerationCallSchema = Type.Object({
  type: Type.Literal("image_generation_call"),
  id: Type.String(),
  status: Type.String(),
  result: Type.Union([Type.String(), Type.Null()]),
  revised_prompt: Type.Optional(Type.Unknown()),
});
const WebSearchCallSchema = Type.Object({
  type: Type.Literal("web_search_call"),
  id: Type.String(),
  status: Type.Optional(Type.Unknown()),
  action: Type.Optional(Type.Unknown()),
  results: Type.Optional(Type.Unknown()),
});
const ImageDetailSchema = Type.Object({ detail: Type.Optional(Type.Unknown()) });

export interface ImageGenerationCallItem {
  type: "image_generation_call";
  id: string;
  status: string;
  result: string | null;
  revised_prompt?: string | undefined;
}

export interface ImageGenerationCallBlock {
  type: "image_generation_call";
  item: ImageGenerationCallItem;
}

export interface WebSearchCallItem {
  type: "web_search_call";
  id: string;
  status?: string | undefined;
  action?: NativeItemValue | undefined;
  results?: NativeItemValue | undefined;
}

export interface WebSearchCallBlock {
  type: "web_search_call";
  item: WebSearchCallItem;
}

export type ImageDetail = "auto" | "high" | "original";

export function encryptedOutputFromWebRunLike<T>(value: T): string | undefined {
  if (!Check(EncryptedOutputSchema, value)) return undefined;
  const encryptedOutput = value.encrypted_output;
  return Check(Type.String(), encryptedOutput) && encryptedOutput.trim()
    ? encryptedOutput
    : undefined;
}

export function encryptedWebRunOutputFromDetails<T>(details: T): string | undefined {
  if (!Check(WebRunDetailsSchema, details)) return undefined;
  return encryptedOutputFromWebRunLike(details.webRun);
}

export function isImageGenerationCallBlock<T extends { type: string }>(
  block: T,
): block is T & ImageGenerationCallBlock {
  return Check(ImageGenerationBlockSchema, block);
}

export function isWebSearchCallBlock<T extends { type: string }>(
  block: T,
): block is T & WebSearchCallBlock {
  return Check(WebSearchBlockSchema, block);
}

export function sanitizeImageGenerationCallItem<T>(item: T): ImageGenerationCallItem | undefined {
  if (!Check(ImageGenerationCallSchema, item) || item.id === "" || item.status === "") {
    return undefined;
  }
  const sanitized: ImageGenerationCallItem = {
    type: "image_generation_call",
    id: item.id,
    status: item.status,
    result: item.result,
  };
  if (Check(Type.String(), item.revised_prompt)) sanitized.revised_prompt = item.revised_prompt;
  return sanitized;
}

export function sanitizeWebSearchCallItem<T>(item: T): WebSearchCallItem | undefined {
  if (!Check(WebSearchCallSchema, item) || item.id === "") return undefined;
  const sanitized: WebSearchCallItem = { type: "web_search_call", id: item.id };
  if (Check(Type.String(), item.status)) sanitized.status = item.status;
  if (Check(NativeItemValueSchema, item.action)) sanitized.action = item.action;
  if (Check(NativeItemValueSchema, item.results)) sanitized.results = item.results;
  return sanitized;
}

export function imageDetailForResponses<T>(block: T): ImageDetail {
  if (!Check(ImageDetailSchema, block)) return "auto";
  return block.detail === "high" || block.detail === "original" ? block.detail : "auto";
}
