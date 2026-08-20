import { conditionalProperties } from "../runtime-values.ts";
import { JsonObjectSchema } from "../runtime-values.ts";
import type { JsonObject, BoundaryValue } from "../runtime-values.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { normalizeResponsesToolHistory } from "../../providers/openai-responses/tool-history.ts";

const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;
const APPROX_BYTES_PER_TOKEN = 4;

const CONTEXTUAL_USER_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ["# AGENTS.md instructions", "</INSTRUCTIONS>"],
  ["<environment_context>", "</environment_context>"],
  ["<skill>", "</skill>"],
  ["<user_shell_command>", "</user_shell_command>"],
  ["<turn_aborted>", "</turn_aborted>"],
  ["<subagent_notification>", "</subagent_notification>"],
  ["<recommended_plugins>", "</recommended_plugins>"],
];

function isRecord(value: BoundaryValue): value is JsonObject {
  return Value.Check(JsonObjectSchema, value);
}

function validMetadata(value: BoundaryValue): boolean {
  return (
    value === undefined ||
    value === null ||
    (isRecord(value) &&
      (value["turn_id"] === undefined ||
        value["turn_id"] === null ||
        Value.Check(Type.String(), value["turn_id"])))
  );
}

export function canonicalCompactionOutput(item: BoundaryValue): JsonObject | undefined {
  if (!isRecord(item) || (item["type"] !== "compaction" && item["type"] !== "compaction_summary"))
    return undefined;
  if (
    !Value.Check(Type.String(), item["encrypted_content"]) ||
    item["encrypted_content"].trim() === ""
  )
    return undefined;
  if (item["id"] !== undefined && item["id"] !== null && !Value.Check(Type.String(), item["id"]))
    return undefined;
  if (!validMetadata(item["internal_chat_message_metadata_passthrough"])) return undefined;
  const metadata = item["internal_chat_message_metadata_passthrough"];
  const metadataPassthrough = isRecord(metadata)
    ? conditionalProperties(Value.Check(Type.String(), metadata["turn_id"]), {
        turn_id: metadata["turn_id"],
      })
    : undefined;
  return {
    type: "compaction",
    ...conditionalProperties(Boolean(Value.Check(Type.String(), item["id"])), { id: item["id"] }),
    encrypted_content: item["encrypted_content"],
    ...conditionalProperties(Boolean(metadataPassthrough), {
      internal_chat_message_metadata_passthrough: metadataPassthrough,
    }),
  };
}

export function normalizeRemoteCompactionV2PromptInput(
  input: readonly BoundaryValue[],
): JsonObject[] {
  return normalizeResponsesToolHistory([...input])
    .filter((item): item is JsonObject => Value.Check(JsonObjectSchema, item))
    .map((item) => structuredClone(item));
}

function matchesMarkedText(text: string, start: string, end: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.slice(0, start.length).toLowerCase() === start.toLowerCase() &&
    trimmed.slice(-end.length).toLowerCase() === end.toLowerCase()
  );
}

function isHookPrompt(text: string): boolean {
  const match =
    /^\s*<hook_prompt\s+hook_run_id=(?:"([^"]*)"|'([^']*)')\s*>[\s\S]*<\/hook_prompt>\s*$/.exec(
      text,
    );
  return (match?.[1] ?? match?.[2] ?? "").trim() !== "";
}

function isAdditionalContext(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("<external_")) return false;
  const close = trimmed.indexOf(">");
  if (close < 0) return false;
  const key = trimmed.slice("<external_".length, close);
  return trimmed.slice(close + 1).endsWith(`</external_${key}>`);
}

function isInternalModelContext(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("<goal_context>") && trimmed.endsWith("</goal_context>")) return true;
  const match =
    /^<codex_internal_context source="([a-z][a-z0-9_]*)">[\s\S]*<\/codex_internal_context>$/.exec(
      trimmed,
    );
  return match !== null;
}

function isLegacyContextWarning(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith(
      "Warning: The maximum number of unified exec processes you can keep open is",
    ) ||
    trimmed.startsWith(
      "Warning: Your account was flagged for potentially high-risk cyber activity",
    ) ||
    (trimmed.startsWith("Warning: apply_patch was requested via ") &&
      trimmed.endsWith("Use the apply_patch tool instead of exec_command."))
  );
}

function isContextualText(text: string): boolean {
  return (
    CONTEXTUAL_USER_MARKERS.some(([start, end]) => matchesMarkedText(text, start, end)) ||
    isAdditionalContext(text) ||
    isInternalModelContext(text) ||
    isLegacyContextWarning(text)
  );
}

function retainedRealUserMessage(item: BoundaryValue): JsonObject | undefined {
  if (
    !isRecord(item) ||
    (item["type"] !== undefined && item["type"] !== "message") ||
    item["role"] !== "user" ||
    !Array.isArray(item["content"])
  )
    return undefined;
  const content = item["content"].filter((part) => {
    if (!isRecord(part)) return false;
    if (part["type"] !== "input_text" || !Value.Check(Type.String(), part["text"])) return true;
    return !isHookPrompt(part["text"]) && !isContextualText(part["text"]);
  });
  return content.length > 0
    ? { ...structuredClone(item), type: "message", content: structuredClone(content) }
    : undefined;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function approxTokenCount(value: string): number {
  return Math.ceil(utf8Bytes(value) / APPROX_BYTES_PER_TOKEN);
}

function messageTextTokenCount(item: JsonObject): number {
  if (!Array.isArray(item["content"])) return 0;
  return item["content"].reduce((tokens, part) => {
    if (
      !isRecord(part) ||
      (part["type"] !== "input_text" && part["type"] !== "output_text") ||
      !Value.Check(Type.String(), part["text"])
    )
      return tokens;
    return tokens + approxTokenCount(part["text"]);
  }, 0);
}

export function buildRemoteCompactionV2Window(
  promptInput: readonly BoundaryValue[],
  compactionOutput: JsonObject,
  maxTokens = RETAINED_MESSAGE_TOKEN_BUDGET,
): JsonObject[] {
  const retained = promptInput
    .filter(
      (item) =>
        isRecord(item) &&
        (item["type"] === undefined || item["type"] === "message") &&
        (item["role"] === "user" || item["role"] === "developer" || item["role"] === "system"),
    )
    .map(retainedRealUserMessage)
    .filter((item): item is JsonObject => item !== undefined);
  let remaining = Math.max(0, Math.floor(maxTokens));
  const reversed: JsonObject[] = [];
  for (let index = retained.length - 1; index >= 0; index--) {
    const item = retained[index]!;
    const tokens = Math.max(1, messageTextTokenCount(item));
    if (tokens <= remaining) {
      reversed.push(item);
      remaining = Math.max(0, remaining - tokens);
    } else break;
  }
  reversed.reverse();
  return [...reversed, structuredClone(compactionOutput)];
}
