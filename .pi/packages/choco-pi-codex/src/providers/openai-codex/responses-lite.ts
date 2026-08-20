import { resizeImage } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import {
  namespaceResponsesLiteInputTools,
  namespaceResponsesLiteTools,
} from "./responses-lite-tools.ts";
import type { ProtocolPropertyValue, ProtocolValue } from "./types.ts";

export const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
const RESPONSES_LITE_WS_METADATA_KEY = "ws_request_header_x_openai_internal_codex_responses_lite";

const IMAGE_PROCESSING_PLACEHOLDER = "image content omitted because it could not be processed";
const IMAGE_MAX_DIMENSION = 2048;
const IMAGE_MAX_PATCHES = 2_500;
const IMAGE_PATCH_SIZE = 32;
const IMAGE_MAX_BASE64_BYTES = 64 * 1024 * 1024;

export interface ResponsesLiteCompatibleBody {
  model: string;
  input: ProtocolValue[];
  instructions?: string | undefined;
  tools?: ProtocolValue[] | undefined;
  parallel_tool_calls?: boolean | undefined;
  reasoning?: ProtocolValue | undefined;
  client_metadata?: Record<string, string> | undefined;
  [key: string]: ProtocolPropertyValue;
}

export function isResponsesLiteRequest(body: ResponsesLiteCompatibleBody): boolean {
  return isRecord(body.input[0]) && body.input[0]["type"] === "additional_tools";
}

const ProtocolRecordType = Type.Record(Type.String(), Type.Unknown());
type ProtocolRecord = Static<typeof ProtocolRecordType>;
const ProtocolRecordSchema = Type.Unsafe<ProtocolRecord>({ type: "object" });
const StringSchema = Type.String();

function isRecord<T>(value: T): value is Extract<T, object> & ProtocolRecord {
  return Check(ProtocolRecordSchema, value);
}

function prepareLiteContent<T>(content: T) {
  if (!Array.isArray(content)) return content;
  return content.map((item) => {
    if (!isRecord(item) || item["type"] !== "input_image") return item;
    const imageUrl = item["image_url"];
    if (Check(StringSchema, imageUrl) && /^https?:\/\//i.test(imageUrl)) {
      return {
        type: "input_text",
        text: "image content omitted because remote image URLs are not supported",
      };
    }
    const { detail: _detail, ...image } = item;
    return image;
  });
}

function prepareLiteInput(input: readonly ProtocolValue[]): ProtocolValue[] {
  const prepared = input.map((item) => {
    if (!isRecord(item)) return item;
    if (
      item["type"] === "message" ||
      item["role"] === "user" ||
      item["role"] === "developer" ||
      item["role"] === "system"
    ) {
      return { ...item, content: prepareLiteContent(item["content"]) };
    }
    const output = item["output"];
    if (
      (item["type"] === "function_call_output" || item["type"] === "custom_tool_call_output") &&
      isRecord(output)
    ) {
      return {
        ...item,
        output: Object.assign({}, output, { content: prepareLiteContent(output["content"]) }),
      };
    }
    if (
      (item["type"] === "function_call_output" || item["type"] === "custom_tool_call_output") &&
      Array.isArray(item["output"])
    ) {
      return { ...item, output: prepareLiteContent(item["output"]) };
    }
    return item;
  });
  return namespaceResponsesLiteInputTools(prepared);
}

async function prepareDataImageUrl(imageUrl: string): Promise<string | undefined> {
  const match = /^data:([^;,]+);base64,([a-z0-9+/]*={0,2})$/i.exec(imageUrl);
  if (!match?.[1] || !match[2] || !match[1].toLowerCase().startsWith("image/")) return undefined;
  if (Buffer.byteLength(match[2], "utf8") > IMAGE_MAX_BASE64_BYTES) return undefined;
  try {
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length === 0) return undefined;
    let resized = await resizeImage(bytes, match[1], {
      maxWidth: IMAGE_MAX_DIMENSION,
      maxHeight: IMAGE_MAX_DIMENSION,
      maxBytes: IMAGE_MAX_BASE64_BYTES,
    });
    if (!resized) return undefined;
    const patches =
      Math.ceil(resized.width / IMAGE_PATCH_SIZE) * Math.ceil(resized.height / IMAGE_PATCH_SIZE);
    if (patches > IMAGE_MAX_PATCHES) {
      const scale = Math.sqrt(IMAGE_MAX_PATCHES / patches);
      resized = await resizeImage(bytes, match[1], {
        maxWidth: Math.max(1, Math.floor(resized.width * scale)),
        maxHeight: Math.max(1, Math.floor(resized.height * scale)),
        maxBytes: IMAGE_MAX_BASE64_BYTES,
      });
    }
    return resized ? `data:${resized.mimeType};base64,${resized.data}` : undefined;
  } catch {
    return undefined;
  }
}

async function prepareLiteImageContent<T>(content: T) {
  if (!Array.isArray(content)) return content;
  return Promise.all(
    content.map(async (item) => {
      if (
        !isRecord(item) ||
        item["type"] !== "input_image" ||
        !Check(StringSchema, item["image_url"])
      )
        return item;
      if (!/^data:/i.test(item["image_url"])) return item;
      const imageUrl = await prepareDataImageUrl(item["image_url"]);
      return imageUrl
        ? { ...item, image_url: imageUrl }
        : { type: "input_text", text: IMAGE_PROCESSING_PLACEHOLDER };
    }),
  );
}

export async function prepareResponsesLiteRequestImages<TBody extends ResponsesLiteCompatibleBody>(
  body: TBody,
): Promise<TBody> {
  const input = await Promise.all(
    body.input.map(async (item) => {
      if (!isRecord(item)) return item;
      if (
        (item["type"] === "message" ||
          item["role"] === "user" ||
          item["role"] === "developer" ||
          item["role"] === "system") &&
        "content" in item
      ) {
        return { ...item, content: await prepareLiteImageContent(item["content"]) };
      }
      const output = item["output"];
      if (
        (item["type"] === "function_call_output" || item["type"] === "custom_tool_call_output") &&
        isRecord(output)
      ) {
        return {
          ...item,
          output: Object.assign({}, output, {
            content: await prepareLiteImageContent(output["content"]),
          }),
        };
      }
      if (
        (item["type"] === "function_call_output" || item["type"] === "custom_tool_call_output") &&
        Array.isArray(item["output"])
      ) {
        return { ...item, output: await prepareLiteImageContent(item["output"]) };
      }
      return item;
    }),
  );
  return { ...body, input };
}

export function applyResponsesLiteRequest<TBody extends ResponsesLiteCompatibleBody>(
  body: TBody,
): TBody {
  const instructions = body.instructions?.trim();
  const tools = [...(body.tools ?? [])];
  const prefix: ProtocolValue[] = [
    {
      type: "additional_tools",
      role: "developer",
      tools: namespaceResponsesLiteTools(tools),
    },
    ...(instructions
      ? [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: instructions }],
          },
        ]
      : []),
  ];
  const { instructions: _instructions, tools: _tools, ...rest } = body;
  const reasoning: ProtocolRecord = isRecord(body.reasoning) ? { ...body.reasoning } : {};
  reasoning["context"] = "all_turns";
  // SAFETY: The constructed value preserves every TBody property except the intentionally omitted
  // instructions and tools fields, then supplies the required Responses Lite replacements.
  return {
    ...rest,
    input: [...prefix, ...prepareLiteInput(body.input)],
    parallel_tool_calls: false,
    reasoning,
  } as TBody;
}

export function namespaceExistingResponsesLiteRequest<TBody extends ResponsesLiteCompatibleBody>(
  body: TBody,
): TBody {
  return { ...body, input: namespaceResponsesLiteInputTools(body.input) };
}

export function applyResponsesLiteWebSocketMetadata<TBody extends ResponsesLiteCompatibleBody>(
  body: TBody,
): TBody & { client_metadata: Record<string, string> } {
  return {
    ...body,
    client_metadata: { ...body.client_metadata, [RESPONSES_LITE_WS_METADATA_KEY]: "true" },
  };
}
