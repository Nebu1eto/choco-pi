import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isJsonRecord, isString, type JsonRecord, type JsonValue } from "./lib/runtime-values.ts";

/**
 * Keeps Anthropic Messages requests valid when a tool failed after producing media.
 *
 * Anthropic rejects a `tool_result` whose `is_error` is true unless every content
 * block is text. Tools legitimately return images on failure (an agent-browser batch
 * whose screenshot step succeeded before a later step failed, or a Code Mode cell
 * that emitted `image()` and then threw), and pi-ai forwards `content` and
 * `isError` verbatim. Because the rejected message stays in the transcript, every
 * later request fails with the same 400 and the session cannot continue.
 *
 * The guard rewrites only the outgoing payload: each non-text block of an error
 * `tool_result` becomes a short text placeholder, so the session entry and its
 * rendering keep the original media and already-affected sessions recover.
 */

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

/**
 * Returns the Anthropic Messages payload with media removed from error tool results,
 * or `undefined` when no block needed a change.
 */
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
