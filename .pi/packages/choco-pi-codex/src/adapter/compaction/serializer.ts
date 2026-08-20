import { conditionalProperties } from "../runtime-values.ts";
import { jsonValueType, JsonObjectSchema } from "../runtime-values.ts";
import type { JsonObject, BoundaryValue } from "../runtime-values.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSessionContext,
  convertToLlm,
  getAgentDir,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  Api,
  ImageContent,
  Message,
  Model,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  CODEX_TOOL_CALL_PROVIDERS,
  convertResponsesMessages,
} from "../../providers/openai-responses/shared.ts";
import { isCodexTransportModel } from "../prompt/codex-model.ts";
import { isProviderContextExcludedMessage } from "../prompt/context-filter.ts";

/**
 * Responses compaction reuses the provider's serializer.
 *
 * Replay parity must match the actual OpenAI Codex provider payload, including
 * tool-call id normalization and cross-model/provider history handling.
 */
export type AssistantPhase = "commentary" | "final_answer";

type ResponsesTextInputItem = {
  type: "input_text";
  text: string;
};

type ResponsesImageInputItem = {
  type: "input_image";
  detail: "auto" | "high" | "original";
  image_url: string;
};

type ResponsesEncryptedContentItem = {
  type: "encrypted_content";
  encrypted_content: string;
};

export type ResponsesInputContentItem =
  | ResponsesTextInputItem
  | ResponsesImageInputItem
  | ResponsesEncryptedContentItem;

export type ResponsesInputMessageItem = {
  role: "user" | "developer" | "system";
  content: ResponsesInputContentItem[] | string;
};

export type ResponsesAssistantOutputItem = {
  type: "message";
  role: "assistant";
  content: Array<{
    type: "output_text";
    text: string;
    annotations: [];
  }>;
  status: "completed";
  id: string;
  phase?: AssistantPhase | undefined;
};

export type ResponsesFunctionCallItem = {
  type: "function_call";
  id?: string | undefined;
  call_id: string;
  name: string;
  arguments: string;
};

export type ResponsesFunctionCallOutputItem = {
  type: "function_call_output";
  call_id: string;
  output: ResponsesInputContentItem[] | string;
};

export type ResponsesReasoningItem = JsonObject;

export type ResponsesInputItem =
  | ResponsesInputMessageItem
  | ResponsesAssistantOutputItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem;

export type NativeCompactionRequestBody = {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string | undefined;
  parallel_tool_calls?: boolean | undefined;
  prompt_cache_key?: string | undefined;
  service_tier?: string | undefined;
  text?: { verbosity: string } | undefined;
  tools?: BoundaryValue[] | undefined;
  reasoning?: BoundaryValue | undefined;
};

export type NativeCompactionRequestOptions = Pick<
  NativeCompactionRequestBody,
  "parallel_tool_calls" | "prompt_cache_key" | "service_tier" | "text" | "tools" | "reasoning"
>;

export type SerializeResponsesMessagesOptions = {
  instructions?: string | undefined;
  includeInstructionsInInput?: boolean | undefined;
  blockImages?: boolean | undefined;
  grammarToolInputProperties?: ReadonlyMap<string, string> | undefined;
};

export type ResponsesParityReport = {
  ok: boolean;
  actual: string[];
  expected: string[];
  mismatches: string[];
};

function isRecord(value: BoundaryValue): value is JsonObject {
  return Value.Check(JsonObjectSchema, value);
}

let cachedBlockImagesSetting: boolean | undefined;

function readBlockImagesSetting(): boolean {
  if (cachedBlockImagesSetting !== undefined) return cachedBlockImagesSetting;
  try {
    const parsed: BoundaryValue = JSON.parse(
      readFileSync(join(getAgentDir(), "settings.json"), "utf-8"),
    );
    cachedBlockImagesSetting =
      isRecord(parsed) && isRecord(parsed["images"]!) && parsed["images"]["blockImages"] === true;
  } catch {
    cachedBlockImagesSetting = false;
  }
  return cachedBlockImagesSetting;
}

function replaceImagesWithDisabledPlaceholder<TMessage extends UserMessage | ToolResultMessage>(
  message: TMessage,
): TMessage {
  if (!Array.isArray(message.content) || !message.content.some((item) => item.type === "image"))
    return message;
  const content = message.content
    .map((item): TextContent | ImageContent =>
      item.type === "image" ? { type: "text", text: "Image reading is disabled." } : item,
    )
    .filter((item, index, items) => {
      const previous = items[index - 1]!;
      return !(
        item.type === "text" &&
        item.text === "Image reading is disabled." &&
        previous?.type === "text" &&
        previous.text === "Image reading is disabled."
      );
    });
  return { ...message, content };
}

function applyBlockImages(messages: Message[], blockImages: boolean): Message[] {
  if (!blockImages) return messages;
  return messages.map((message) => {
    if (message.role === "user" || message.role === "toolResult")
      return replaceImagesWithDisabledPlaceholder(message);
    return message;
  });
}

export function serializeActiveSessionToResponsesInput<TApi extends Api>(args: {
  model: Model<TApi>;
  entries: SessionEntry[];
  leafId?: string | null | undefined;
  options?: SerializeResponsesMessagesOptions | undefined;
}): ResponsesInputItem[] {
  const messages = buildSessionContext(args.entries, args.leafId).messages.filter(
    (message) => !isProviderContextExcludedMessage(message),
  );
  return serializeMessagesToResponsesInput(args.model, messages, args.options);
}

export function serializeMessagesToResponsesInput<TApi extends Api>(
  model: Model<TApi>,
  messages: AgentMessage[],
  options: SerializeResponsesMessagesOptions = {},
): ResponsesInputItem[] {
  const llmMessages = applyBlockImages(
    convertToLlm(messages),
    options.blockImages ?? readBlockImagesSetting(),
  );
  const allowedToolCallProviders =
    isCodexTransportModel(model) && !CODEX_TOOL_CALL_PROVIDERS.has(model.provider)
      ? new Set([...CODEX_TOOL_CALL_PROVIDERS, model.provider])
      : CODEX_TOOL_CALL_PROVIDERS;
  // SAFETY: convertResponsesMessages is the provider serializer and returns Responses API input items for this model.
  return convertResponsesMessages(
    model,
    {
      messages: llmMessages,
      ...conditionalProperties(
        Boolean(options.includeInstructionsInInput && options.instructions),
        { systemPrompt: options.instructions },
      ),
    },
    allowedToolCallProviders,
    {
      includeSystemPrompt: options.includeInstructionsInInput ?? false,
      ...conditionalProperties(Boolean(options.grammarToolInputProperties), {
        grammarToolInputProperties: options.grammarToolInputProperties,
      }),
    },
  ) as ResponsesInputItem[];
}

export function createResponsesInputParitySignature(input: readonly BoundaryValue[]): string[] {
  return input.map(describeResponsesInputItem);
}

export function compareResponsesInputParity(
  actual: readonly BoundaryValue[],
  expected: readonly BoundaryValue[],
): ResponsesParityReport {
  const actualSignature = createResponsesInputParitySignature(actual);
  const expectedSignature = createResponsesInputParitySignature(expected);
  const maxLength = Math.max(actualSignature.length, expectedSignature.length);
  const mismatches: string[] = [];

  for (let index = 0; index < maxLength; index++) {
    const actualValue = actualSignature[index]!;
    const expectedValue = expectedSignature[index]!;
    if (actualValue !== expectedValue) {
      mismatches.push(
        `index ${index}: expected ${expectedValue ?? "<missing>"}, got ${actualValue ?? "<missing>"}`,
      );
    }
  }

  return {
    ok: mismatches.length === 0,
    actual: actualSignature,
    expected: expectedSignature,
    mismatches,
  };
}

function describeResponsesInputItem(item: BoundaryValue): string {
  if (!Value.Check(JsonObjectSchema, item)) {
    return jsonValueType(item);
  }

  const record = item;
  const type = Value.Check(Type.String(), record["type"]!) ? record["type"]! : undefined;
  if (type === "message") {
    const phase =
      record["phase"] === "commentary" || record["phase"] === "final_answer"
        ? `:${record["phase"]!}`
        : "";
    return `message:${Value.Check(Type.String(), record["role"]!) ? record["role"]! : "unknown"}${phase}`;
  }

  if (type === "function_call") {
    return `function_call:${Value.Check(Type.String(), record["name"]!) ? record["name"]! : "unknown"}`;
  }

  if (type === "function_call_output") {
    return "function_call_output";
  }

  if (type === "reasoning") {
    return "reasoning";
  }

  if (Value.Check(Type.String(), record["role"]!)) {
    const content = Array.isArray(record["content"]!) ? `[${record["content"]!.length}]` : "";
    return `input:${record["role"]!}${content}`;
  }

  return type ? `item:${type}` : "object";
}
