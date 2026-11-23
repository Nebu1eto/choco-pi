import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isJsonRecord, isString, type JsonRecord, type JsonValue } from "./lib/runtime-values.ts";

function describeOmittedBlock(block: JsonValue): string {
  const type = isJsonRecord(block) && isString(block.type) ? block.type : "non-text";
  const source = isJsonRecord(block) && isJsonRecord(block.source) ? block.source : undefined;
  const mediaType = source && isString(source.media_type) ? ` ${source.media_type}` : "";
  return `[${type}${mediaType} content omitted: Anthropic accepts only text in error tool results]`;
}

function sanitizeToolResult(block: JsonValue): JsonValue {
  if (!isJsonRecord(block) || block.type !== "tool_result" || block.is_error !== true) return block;
  const content = block.content;
  if (!Array.isArray(content)) return block;
  if (content.every((item) => isJsonRecord(item) && item.type === "text")) return block;
  const record: JsonRecord = block;
  return {
    ...record,
    content: content.map((item) =>
      isJsonRecord(item) && item.type === "text"
        ? item
        : { type: "text", text: describeOmittedBlock(item) },
    ),
  };
}

export function sanitizeErrorToolResults(payload: JsonValue): JsonRecord | undefined {
  if (!isJsonRecord(payload) || !Array.isArray(payload.messages)) return undefined;
  let changed = false;
  const messages = payload.messages.map((message) => {
    if (!isJsonRecord(message) || !Array.isArray(message.content)) return message;
    const original: JsonValue[] = message.content;
    const content = original.map(sanitizeToolResult);
    if (content.every((block, index) => block === original[index])) return message;
    changed = true;
    const record: JsonRecord = message;
    return { ...record, content };
  });
  if (!changed) return undefined;
  const source: JsonRecord = payload;
  return { ...source, messages };
}

export default function anthropicErrorToolResults(pi: ExtensionAPI): void {
  // SAFETY: Pi supplies provider payloads as JSON request bodies at this host boundary.
  pi.on("before_provider_request", (event) => sanitizeErrorToolResults(event.payload as JsonValue));
}
