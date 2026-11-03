import { compile, lit, nullable, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { isJsonObject } from "../../adapter/runtime-values.ts";
import { isBoolean, isFunction, isNumber, isString } from "../value-guards.ts";

type NativeItemValue =
  | object
  | NativeItemValue[]
  | string
  | number
  | bigint
  | boolean
  | symbol
  | (() => NativeItemValue)
  | null;

// Identity against the wrapper rejects already-boxed values and never calls user code.
function isPrimitiveBigInt<Value>(value: Value): boolean {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof BigInt;
}

function isPrimitiveSymbol<Value>(value: Value): boolean {
  const boxed = Object(value);
  return boxed !== value && boxed instanceof Symbol;
}

function isNativeItemValue<Value>(value: Value): value is Value & NativeItemValue {
  return (
    isJsonObject(value) ||
    Array.isArray(value) ||
    isString(value) ||
    isNumber(value) ||
    isPrimitiveBigInt(value) ||
    isBoolean(value) ||
    isPrimitiveSymbol(value) ||
    isFunction(value) ||
    value === null
  );
}

// Pi content blocks and tool details are open objects: unknown members are ignored.
const imageGenerationBlockValidator = compile(
  obj(
    {
      type: lit("image_generation_call"),
      item: obj({ type: lit("image_generation_call") }, { open: true }),
    },
    { open: true },
  ),
);
const webSearchBlockValidator = compile(
  obj(
    { type: lit("web_search_call"), item: obj({ type: lit("web_search_call") }, { open: true }) },
    { open: true },
  ),
);
const imageGenerationCallValidator = compile(
  obj(
    {
      type: lit("image_generation_call"),
      id: str(),
      status: str(),
      result: nullable(str()),
      revised_prompt: opt(unknown()),
    },
    { open: true },
  ),
);
const webSearchCallValidator = compile(
  obj(
    {
      type: lit("web_search_call"),
      id: str(),
      status: opt(unknown()),
      action: opt(unknown()),
      results: opt(unknown()),
    },
    { open: true },
  ),
);

// Members below may sit on the prototype of live objects, so these are shallow object guards.
interface EncryptedOutputLike {
  encrypted_output?: unknown;
}
interface WebRunDetailsLike {
  webRun?: unknown;
}
interface ImageDetailLike {
  detail?: unknown;
}

function hasEncryptedOutput<Value>(value: Value): value is Value & EncryptedOutputLike {
  return isJsonObject(value);
}
function hasWebRunDetails<Value>(value: Value): value is Value & WebRunDetailsLike {
  return isJsonObject(value);
}
function hasImageDetail<Value>(value: Value): value is Value & ImageDetailLike {
  return isJsonObject(value);
}

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
  if (!hasEncryptedOutput(value)) return undefined;
  const encryptedOutput = value.encrypted_output;
  return isString(encryptedOutput) && encryptedOutput.trim() ? encryptedOutput : undefined;
}

export function encryptedWebRunOutputFromDetails<T>(details: T): string | undefined {
  if (!hasWebRunDetails(details)) return undefined;
  return encryptedOutputFromWebRunLike(details.webRun);
}

export function isImageGenerationCallBlock<T extends { type: string }>(
  block: T,
): block is T & ImageGenerationCallBlock {
  return imageGenerationBlockValidator.check(block);
}

export function isWebSearchCallBlock<T extends { type: string }>(
  block: T,
): block is T & WebSearchCallBlock {
  return webSearchBlockValidator.check(block);
}

export function sanitizeImageGenerationCallItem<T>(item: T): ImageGenerationCallItem | undefined {
  if (!imageGenerationCallValidator.check(item) || item.id === "" || item.status === "") {
    return undefined;
  }
  const sanitized: ImageGenerationCallItem = {
    type: "image_generation_call",
    id: item.id,
    status: item.status,
    result: item.result,
  };
  if (isString(item.revised_prompt)) sanitized.revised_prompt = item.revised_prompt;
  return sanitized;
}

export function sanitizeWebSearchCallItem<T>(item: T): WebSearchCallItem | undefined {
  if (!webSearchCallValidator.check(item) || item.id === "") return undefined;
  const sanitized: WebSearchCallItem = { type: "web_search_call", id: item.id };
  if (isString(item.status)) sanitized.status = item.status;
  if (isNativeItemValue(item.action)) sanitized.action = item.action;
  if (isNativeItemValue(item.results)) sanitized.results = item.results;
  return sanitized;
}

export function imageDetailForResponses<T>(block: T): ImageDetail {
  if (!hasImageDetail(block)) return "auto";
  return block.detail === "high" || block.detail === "original" ? block.detail : "auto";
}
