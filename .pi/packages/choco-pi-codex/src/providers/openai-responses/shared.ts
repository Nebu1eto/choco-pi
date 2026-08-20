import type { Api, Context, Model, Tool, Usage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseInputItem,
  ResponseToolSearchOutputItemParam,
  Tool as OpenAITool,
} from "openai/resources/responses/responses.js";
import {
  getJsonSchemaToolParameters,
  getGrammarToolInput,
  resolveGrammarConstrainedSampling,
  resolveJsonSchemaStrictSampling,
} from "../constrained-sampling.js";
import { parseTextSignature, shortHash } from "./signatures.ts";
import { normalizeResponsesToolHistory } from "./tool-history.ts";
import { normalizeResponsesMessageHistory } from "./message-history.ts";
import {
  encryptedWebRunOutputFromDetails,
  imageDetailForResponses,
  isImageGenerationCallBlock,
  isWebSearchCallBlock,
  sanitizeImageGenerationCallItem,
  sanitizeWebSearchCallItem,
  type ImageDetail,
  type ImageGenerationCallBlock,
  type WebSearchCallBlock,
} from "./native-items.ts";
import type { ProviderOutputItem } from "../openai-codex/types.ts";

type Message = Context["messages"][number];

type InternalAssistantContent =
  | Extract<Message, { role: "assistant" }>["content"][number]
  | ImageGenerationCallBlock
  | WebSearchCallBlock;
type FunctionCallInput = Extract<ResponseInputItem, { type: "function_call" }> & {
  namespace?: string | undefined;
};
interface CustomToolCallInput {
  type: "custom_tool_call";
  call_id: string;
  name: string;
  input: string;
  id?: string | undefined;
  namespace?: string | undefined;
}
type FunctionToolWithDeferredLoading = Omit<Extract<OpenAITool, { type: "function" }>, "strict"> & {
  strict?: boolean | null | undefined;
  defer_loading?: true | undefined;
};
interface GrammarOpenAITool {
  type: "custom";
  name: string;
  description: string;
  format: { type: "grammar"; syntax: "lark" | "regex"; definition: string };
  defer_loading?: true | undefined;
}

type ImageContentWithDetail = {
  type: "image";
  data: string;
  mimeType: string;
  detail?: ImageDetail | undefined;
};

export interface OpenAIResponsesStreamOptions {
  serviceTier?: ResponseCreateParamsStreaming["service_tier"] | undefined;
  grammarToolInputProperties?: ReadonlyMap<string, string> | undefined;
  resolveServiceTier?: (
    responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
    requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => ResponseCreateParamsStreaming["service_tier"] | undefined;
  applyServiceTierPricing?: (
    usage: Usage,
    serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => void;
  onOutputItemDone?: (item: ProviderOutputItem) => void;
}

interface ConvertResponsesMessagesOptions {
  includeSystemPrompt?: boolean | undefined;
  grammarToolInputProperties?: ReadonlyMap<string, string> | undefined;
  deferredTools?: ReadonlyMap<string, Tool> | undefined;
  deferredToolsMode?: "additional-tools" | "tool-search" | undefined;
  toolOptions?: ConvertResponsesToolsOptions | undefined;
}

interface ConvertResponsesToolsOptions {
  strict?: boolean | null | undefined;
  supportsStrictMode?: boolean | undefined;
  supportsOpenAIGrammarTools?: boolean | undefined;
  deferLoading?: boolean | undefined;
}

export const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const StringSchema = Type.String();
const ResponsesInputItemSchema = Type.Unsafe<ResponseInput[number]>({
  anyOf: [
    { type: "object" },
    { type: "array" },
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
});
const JsonSchemaRecordType = Type.Record(Type.String(), Type.Unknown());
type JsonSchemaRecord = Static<typeof JsonSchemaRecordType>;
const JsonSchemaRecordSchema = Type.Unsafe<JsonSchemaRecord>({ type: "object" });

interface DeferredToolPlacement {
  immediate: Tool[];
  deferred: Map<string, Tool>;
}

export function splitDeferredTools(context: Context, enabled: boolean): DeferredToolPlacement {
  const uniqueTools = new Map<string, Tool>();
  for (const tool of context.tools ?? []) uniqueTools.set(tool.name, tool);
  if (!enabled) return { immediate: [...uniqueTools.values()], deferred: new Map() };

  const deferredNames = new Set<string>();
  const usedNames = new Set<string>();
  for (const message of context.messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") usedNames.add(block.name);
      }
    } else if (message.role === "toolResult") {
      for (const name of message.addedToolNames ?? []) {
        if (!usedNames.has(name)) deferredNames.add(name);
      }
    }
  }

  const immediate: Tool[] = [];
  const deferred = new Map<string, Tool>();
  for (const [name, tool] of uniqueTools) {
    if (deferredNames.has(name)) deferred.set(name, tool);
    else immediate.push(tool);
  }
  return { immediate, deferred };
}

function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

function parseResponsesThinkingSignature(signature: string): ResponseInput[number] | undefined {
  try {
    const parsed: object = JSON.parse(signature);
    return Check(ResponsesInputItemSchema, parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function convertResponsesMessages<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options?: ConvertResponsesMessagesOptions,
): ResponseInput {
  const messages: ResponseInput = [];
  const loadedToolNames = new Set<string>();
  const normalizeIdPart = (part: string) => {
    const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
    const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
    return normalized.replace(/_+$/, "");
  };
  const buildForeignResponsesItemId = (itemId: string) => {
    const normalized = `fc_${shortHash(itemId)}`;
    return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
  };
  const normalizeToolCallId = (
    id: string,
    _targetModel: Model<Api>,
    source: Extract<Message, { role: "assistant" }>,
  ) => {
    if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
    if (!id.includes("|")) return normalizeIdPart(id);
    const [callId = "", itemId] = id.split("|");
    const normalizedCallId = normalizeIdPart(callId);
    const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
    let normalizedItemId = isForeignToolCall
      ? buildForeignResponsesItemId(itemId ?? "")
      : normalizeIdPart(itemId ?? "");
    if (!normalizedItemId.startsWith("fc_"))
      normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
    return `${normalizedCallId}|${normalizedItemId}`;
  };

  const transformedMessages = normalizeResponsesMessageHistory(
    context.messages,
    model,
    normalizeToolCallId,
  );
  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    messages.push({
      role: model.reasoning ? "developer" : "system",
      content: sanitizeSurrogates(context.systemPrompt),
    });
  }

  let msgIndex = 0;
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (Check(StringSchema, msg.content)) {
        messages.push({
          role: "user",
          content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
        });
      } else {
        const content = msg.content.map((item) =>
          item.type === "text"
            ? { type: "input_text" as const, text: sanitizeSurrogates(item.text) }
            : {
                type: "input_image" as const,
                detail: imageDetailForResponses(item),
                image_url: `data:${item.mimeType};base64,${item.data}`,
              },
        );
        if (content.length > 0) messages.push({ role: "user", content });
      }
    } else if (msg.role === "assistant") {
      const output: ResponseInput = [];
      const isSameProviderAndApi = msg.provider === model.provider && msg.api === model.api;
      const isSameModel = isSameProviderAndApi && msg.model === model.id;
      const isDifferentModel = isSameProviderAndApi && msg.model !== model.id;
      let textBlockIndex = 0;
      // SAFETY: Provider assistant history may include the native image-generation and web-search
      // blocks in InternalAssistantContent; their discriminator guards parse them before wire use.
      for (const block of msg.content as InternalAssistantContent[]) {
        if (isImageGenerationCallBlock(block)) {
          const imageGenerationCall = sanitizeImageGenerationCallItem(block.item);
          if (imageGenerationCall) {
            // SAFETY: sanitizeImageGenerationCallItem validates every required Responses item field.
            output.push(imageGenerationCall as ResponseInput[number]);
          }
        } else if (isWebSearchCallBlock(block)) {
          const webSearchCall = sanitizeWebSearchCallItem(block.item);
          if (webSearchCall) {
            const parsedWebSearchCall: unknown = webSearchCall;
            // SAFETY: sanitizeWebSearchCallItem validates the discriminator and required item id;
            // action/results remain the original provider payload fields.
            output.push(parsedWebSearchCall as ResponseInput[number]);
          }
        } else if (block.type === "thinking") {
          const thinkingItem = block.thinkingSignature
            ? parseResponsesThinkingSignature(block.thinkingSignature)
            : undefined;
          if (thinkingItem) output.push(thinkingItem);
        } else if (block.type === "text") {
          const parsedSignature = parseTextSignature(block.textSignature);
          const fallbackMessageId =
            textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
          textBlockIndex++;
          let msgId = parsedSignature?.id ?? fallbackMessageId;
          if (msgId.length > 64) msgId = `msg_${shortHash(msgId)}`;
          const messageContent = [
            {
              type: "output_text" as const,
              text: sanitizeSurrogates(block.text),
              annotations: [],
            },
          ];
          if (parsedSignature?.phase) {
            output.push({
              type: "message",
              role: "assistant",
              content: messageContent,
              status: "completed",
              id: msgId,
              phase: parsedSignature.phase,
            });
          } else {
            output.push({
              type: "message",
              role: "assistant",
              content: messageContent,
              status: "completed",
              id: msgId,
            });
          }
        } else if (block.type === "toolCall") {
          const [callId = "", itemIdRaw] = block.id.split("|");
          const customInputProperty = options?.grammarToolInputProperties?.get(block.name);
          let itemId: string | undefined = itemIdRaw;
          if (customInputProperty !== undefined && itemId?.startsWith("fc_")) {
            itemId = `ctc_${itemId.slice(3)}`;
          }
          if (
            (isDifferentModel && itemId?.startsWith("fc_")) ||
            (customInputProperty === undefined && !itemId?.startsWith("fc_"))
          )
            itemId = undefined;
          const canReplayNamespace =
            isSameModel || options?.deferredTools?.has(block.name) === true;
          if (customInputProperty === undefined) {
            const functionCall: FunctionCallInput = {
              type: "function_call",
              call_id: callId,
              name: block.name,
              arguments: JSON.stringify(block.arguments),
            };
            if (itemId) functionCall.id = itemId;
            if (canReplayNamespace && block.namespace !== undefined) {
              functionCall.namespace = block.namespace;
            }
            output.push(functionCall);
          } else {
            const customCall: CustomToolCallInput = {
              type: "custom_tool_call",
              call_id: callId,
              name: block.name,
              input: sanitizeSurrogates(
                getGrammarToolInput(block.name, block.arguments, customInputProperty),
              ),
            };
            if (itemId) customCall.id = itemId;
            if (canReplayNamespace && block.namespace !== undefined) {
              customCall.namespace = block.namespace;
            }
            // SAFETY: The custom tool item uses Codex's Responses extension fields and preserves the
            // standard call discriminator, id, name, and input representation.
            output.push(customCall as ResponseInput[number]);
          }
        }
      }
      if (output.length > 0) messages.push(...output);
    } else if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const hasImages = msg.content.some((c) => c.type === "image");
      const hasText = textResult.length > 0;
      const [callId = ""] = msg.toolCallId.split("|");
      const encryptedWebRunOutput = encryptedWebRunOutputFromDetails(msg.details);
      const output = encryptedWebRunOutput
        ? [{ type: "encrypted_content" as const, encrypted_content: encryptedWebRunOutput }]
        : hasImages && model.input.includes("image")
          ? [
              ...(hasText
                ? [{ type: "input_text" as const, text: sanitizeSurrogates(textResult) }]
                : []),
              ...msg.content
                .filter((block): block is ImageContentWithDetail => block.type === "image")
                .map((block) => ({
                  type: "input_image" as const,
                  detail: imageDetailForResponses(block),
                  image_url: `data:${block.mimeType};base64,${block.data}`,
                })),
            ]
          : sanitizeSurrogates(hasText ? textResult : "(see attached image)");
      const outputItem = {
        type: options?.grammarToolInputProperties?.has(msg.toolName)
          ? ("custom_tool_call_output" as const)
          : ("function_call_output" as const),
        call_id: callId,
        output,
      };
      // SAFETY: output is constructed from the documented string, input content, or encrypted
      // content representations accepted by Responses tool-call output items.
      messages.push(outputItem as ResponseInput[number]);

      const deferredTools: Tool[] = [];
      for (const name of msg.addedToolNames ?? []) {
        const tool = options?.deferredTools?.get(name);
        if (!tool || loadedToolNames.has(name)) continue;
        loadedToolNames.add(name);
        deferredTools.push(tool);
      }
      if (deferredTools.length > 0 && options?.deferredToolsMode === "additional-tools") {
        const additionalTools = {
          type: "additional_tools",
          role: "developer",
          tools: convertResponsesTools(deferredTools, options.toolOptions),
        };
        // SAFETY: additional_tools is the Codex Responses extension item used only on Codex-capable
        // paths; all nested tools are built by convertResponsesTools.
        messages.push(additionalTools as ResponseInputItem);
      } else if (deferredTools.length > 0 && options?.deferredToolsMode === "tool-search") {
        const names = deferredTools.map((tool) => tool.name);
        const searchCallId = `pi_tool_load_${shortHash(`${msg.toolCallId}:${names.join(",")}`)}`;
        messages.push({
          type: "tool_search_call",
          call_id: searchCallId,
          execution: "client",
          status: "completed",
          arguments: { query: names.join(" "), limit: names.length },
        } satisfies ResponseInputItem);
        messages.push({
          type: "tool_search_output",
          call_id: searchCallId,
          execution: "client",
          status: "completed",
          tools: convertResponsesTools(deferredTools, {
            ...options.toolOptions,
            deferLoading: true,
          }),
        } satisfies ResponseToolSearchOutputItemParam);
      }
    }
    msgIndex++;
  }

  return normalizeResponsesToolHistory(messages);
}

export function convertResponsesTools(
  tools: readonly Tool[],
  options?: ConvertResponsesToolsOptions,
): OpenAITool[] {
  const defaultStrict = options?.strict === undefined ? false : options.strict;
  const supportsStrictMode = options?.supportsStrictMode ?? true;
  const supportsOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;
  return tools.map((tool): OpenAITool => {
    const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
    if (grammar) {
      const grammarTool: GrammarOpenAITool = {
        type: "custom",
        name: tool.name,
        description: tool.description,
        format: {
          type: "grammar",
          syntax: grammar.format,
          definition: grammar.definition,
        },
      };
      if (options?.deferLoading) grammarTool.defer_loading = true;
      // SAFETY: resolveGrammarConstrainedSampling validates the grammar format and definition;
      // custom grammar is a Codex extension to the upstream Responses tool union.
      return grammarTool as OpenAITool;
    }
    const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
    const strict = constrainedStrict ?? defaultStrict;
    const parameters = getJsonSchemaToolParameters(tool, strict === true);
    if (!Check(JsonSchemaRecordSchema, parameters)) {
      throw new Error(`Tool "${tool.name}" parameters must be a JSON schema object.`);
    }
    const parsedParameters: JsonSchemaRecord = parameters;
    const functionTool: FunctionToolWithDeferredLoading = {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: parsedParameters,
    };
    if (options?.deferLoading) functionTool.defer_loading = true;
    if (supportsStrictMode) functionTool.strict = strict;
    // SAFETY: The parameters schema check and controlled construction establish a Responses
    // function tool; strict is intentionally omitted for endpoints that do not support it.
    return functionTool as OpenAITool;
  });
}

export { processResponsesStream } from "./stream.ts";
