import {
  type BoundaryRecord,
  type BoundaryValue,
  isBoolean,
  isBoundaryArray,
  isBoundaryRecord,
  isFiniteNumber,
  isString,
} from "../boundary.ts";

export type PiToolArguments = BoundaryValue;

export type PiToolResult = BoundaryValue;

export function recordField(value: BoundaryValue, key: string): BoundaryRecord | undefined {
  if (!isBoundaryRecord(value)) return undefined;
  const field = value[key];
  return isBoundaryRecord(field) ? field : undefined;
}

export function stringField(value: BoundaryValue, key: string): string | undefined {
  if (!isBoundaryRecord(value)) return undefined;
  const field = value[key];
  return isString(field) ? field : undefined;
}

export function numberField(value: BoundaryValue, key: string): number | undefined {
  if (!isBoundaryRecord(value)) return undefined;
  const field = value[key];
  return isFiniteNumber(field) ? field : undefined;
}

export function booleanField(value: BoundaryValue, key: string): boolean | undefined {
  if (!isBoundaryRecord(value)) return undefined;
  const field = value[key];
  return isBoolean(field) ? field : undefined;
}

export function arrayField(value: BoundaryValue, key: string): BoundaryValue[] | undefined {
  if (!isBoundaryRecord(value)) return undefined;
  const field = value[key];
  return isBoundaryArray(field) ? field : undefined;
}

export function toolResultText(result: PiToolResult): string {
  const content = arrayField(result, "content");
  if (!content) return "";
  let text = "";
  for (const block of content) {
    if (stringField(block, "type") !== "text") continue;
    const blockText = stringField(block, "text");
    if (blockText) text += blockText;
  }
  return text;
}

export function toolResultDetails(result: PiToolResult): BoundaryRecord | undefined {
  return recordField(result, "details");
}

export type PiRpcResponse = {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: BoundaryValue;
  error?: string;
};

export function decodePiRpcResponse(value: BoundaryValue): PiRpcResponse | undefined {
  if (!isBoundaryRecord(value) || value.type !== "response") return undefined;
  return {
    type: "response",
    id: stringField(value, "id"),
    command: stringField(value, "command") ?? "",
    success: booleanField(value, "success") ?? false,
    data: value.data,
    error: stringField(value, "error"),
  };
}

export type PiPromptDisposition = "started" | "queued" | "handled";

export function isPiPromptDisposition(value: BoundaryValue): value is PiPromptDisposition {
  return value === "started" || value === "queued" || value === "handled";
}

export function decodePiPromptDisposition(value: BoundaryValue): PiPromptDisposition | undefined {
  if (!isBoundaryRecord(value)) return undefined;
  const disposition = value.disposition;
  return isPiPromptDisposition(disposition) ? disposition : undefined;
}

export type PiModelSelection = {
  provider?: string;
  id?: string;
};

export type PiState = {
  sessionId?: string;
  sessionFile?: string;
  messageCount?: number;
  thinkingLevel?: string;
  model?: PiModelSelection;
  steeringMode?: string;
  followUpMode?: string;
  autoCompactionEnabled?: boolean;
  raw?: BoundaryValue;
};

export function decodePiState(value: BoundaryValue): PiState {
  const rawModel = recordField(value, "model");
  let model: PiModelSelection | undefined;
  if (rawModel) {
    model = { provider: stringField(rawModel, "provider"), id: stringField(rawModel, "id") };
  }
  return {
    sessionId: stringField(value, "sessionId"),
    sessionFile: stringField(value, "sessionFile"),
    messageCount: numberField(value, "messageCount"),
    thinkingLevel: stringField(value, "thinkingLevel"),
    model,
    steeringMode: stringField(value, "steeringMode"),
    followUpMode: stringField(value, "followUpMode"),
    autoCompactionEnabled: booleanField(value, "autoCompactionEnabled"),
    raw: value,
  };
}

export type PiModel = {
  provider: string;
  id: string;
  name?: string;
};

export type PiAvailableModels = {
  models: PiModel[];
};

export function decodePiAvailableModels(value: BoundaryValue): PiAvailableModels {
  const rawModels = arrayField(value, "models") ?? [];
  const models = rawModels.map((entry): PiModel => {
    const name = stringField(entry, "name");
    const model: PiModel = {
      provider: stringField(entry, "provider") ?? "",
      id: stringField(entry, "id") ?? "",
    };
    if (name !== undefined) model.name = name;
    return model;
  });
  return { models };
}

export type PiCommandOrigin = {
  location?: string;
  path?: string;
};

export type PiCommandInfo = {
  name?: string;
  description?: string;
  source?: string;
  sourceInfo?: PiCommandOrigin;
  location?: string;
  path?: string;
};

export type PiCommands = {
  commands: PiCommandInfo[];
};

export function decodePiCommands(value: BoundaryValue): PiCommands {
  const nested = recordField(value, "data");
  const rawCommands =
    arrayField(value, "commands") ?? (nested ? (arrayField(nested, "commands") ?? []) : []);
  const commands = rawCommands.map((entry): PiCommandInfo => {
    const rawOrigin = recordField(entry, "sourceInfo");
    let sourceInfo: PiCommandOrigin | undefined;
    if (rawOrigin) {
      sourceInfo = {
        location: stringField(rawOrigin, "location"),
        path: stringField(rawOrigin, "path"),
      };
    }
    return {
      name: stringField(entry, "name"),
      description: stringField(entry, "description"),
      source: stringField(entry, "source"),
      sourceInfo,
      location: stringField(entry, "location"),
      path: stringField(entry, "path"),
    };
  });
  return { commands };
}

export type PiUserMessage = {
  role: "user";
  content?: BoundaryValue;
  raw?: BoundaryValue;
};

export type PiAssistantMessage = {
  role: "assistant";
  content?: BoundaryValue[];
  raw?: BoundaryValue;
};

export type PiToolResultMessage = {
  role: "toolResult";
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  content?: BoundaryValue;
  details?: BoundaryValue;
  args?: PiToolArguments;
  raw?: BoundaryValue;
};

export type PiUnrecognizedMessage = {
  role: "other";
  raw?: BoundaryValue;
};

export type PiMessage =
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage
  | PiUnrecognizedMessage;

export type PiMessages = {
  messages: PiMessage[];
};

function decodePiMessage(value: BoundaryValue): PiMessage {
  const role = stringField(value, "role");
  if (role === "user") return { role: "user", content: recordContent(value), raw: value };
  if (role === "assistant") {
    return { role: "assistant", content: arrayField(value, "content") ?? [], raw: value };
  }
  if (role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: stringField(value, "toolCallId"),
      toolName: stringField(value, "toolName"),
      isError: booleanField(value, "isError") ?? false,
      content: recordContent(value),
      details: recordField(value, "details"),
      args: isBoundaryRecord(value) ? value.args : undefined,
      raw: value,
    };
  }
  return { role: "other", raw: value };
}

function recordContent(value: BoundaryValue): BoundaryValue {
  return isBoundaryRecord(value) ? value.content : undefined;
}

export function decodePiMessages(value: BoundaryValue): PiMessages {
  const rawMessages = arrayField(value, "messages") ?? [];
  return { messages: rawMessages.map(decodePiMessage) };
}

export type PiSessionTokens = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type PiSessionStats = {
  sessionId?: string;
  sessionFile?: string;
  totalMessages?: number;
  cost?: number;
  tokens?: PiSessionTokens;
  raw?: BoundaryValue;
};

export function decodePiSessionStats(value: BoundaryValue): PiSessionStats {
  const rawTokens = recordField(value, "tokens");
  let tokens: PiSessionTokens | undefined;
  if (rawTokens) {
    tokens = {
      input: numberField(rawTokens, "input"),
      output: numberField(rawTokens, "output"),
      cacheRead: numberField(rawTokens, "cacheRead"),
      cacheWrite: numberField(rawTokens, "cacheWrite"),
      total: numberField(rawTokens, "total"),
    };
  }
  return {
    sessionId: stringField(value, "sessionId"),
    sessionFile: stringField(value, "sessionFile"),
    totalMessages: numberField(value, "totalMessages"),
    cost: numberField(value, "cost"),
    tokens,
    raw: value,
  };
}

export type PiExportHtml = {
  path: string;
};

export function decodePiExportHtml(value: BoundaryValue): PiExportHtml {
  return { path: stringField(value, "path") ?? "" };
}

export type PiCompactResult = {
  tokensBefore?: number;
  summary?: string;
};

export function decodePiCompactResult(value: BoundaryValue): PiCompactResult {
  return {
    tokensBefore: numberField(value, "tokensBefore"),
    summary: stringField(value, "summary"),
  };
}

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type PiTurnMode = "all" | "one-at-a-time";

export type PiPromptImage = {
  type: "image";
  mimeType: string;
  data: string;
};

export type PiExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

export type PiAssistantToolCall = {
  id?: string;
  name?: string;
  arguments?: PiToolArguments;
  partialArgs?: string;
};

export type PiTextDeltaEvent = {
  type: "text_delta";
  delta: string;
};

export type PiThinkingDeltaEvent = {
  type: "thinking_delta";
  delta: string;
};

export type PiToolCallStreamEvent = {
  type: "toolcall_start" | "toolcall_delta" | "toolcall_end";
  toolCall?: PiAssistantToolCall;
  partialContent?: BoundaryValue[];
  contentIndex?: number;
};

export type PiUnrecognizedAssistantEvent = {
  type: "other";
  eventType?: string;
  raw?: BoundaryValue;
};

export type PiAssistantMessageEvent =
  | PiTextDeltaEvent
  | PiThinkingDeltaEvent
  | PiToolCallStreamEvent
  | PiUnrecognizedAssistantEvent;

function decodeAssistantToolCall(value: BoundaryValue): PiAssistantToolCall | undefined {
  if (!isBoundaryRecord(value)) return undefined;
  return {
    id: stringField(value, "id"),
    name: stringField(value, "name"),
    arguments: value.arguments,
    partialArgs: stringField(value, "partialArgs"),
  };
}

function decodeAssistantMessageEvent(value: BoundaryValue): PiAssistantMessageEvent | undefined {
  const eventType = stringField(value, "type");
  if (eventType === undefined) return undefined;
  if (eventType === "text_delta" || eventType === "thinking_delta") {
    const delta = stringField(value, "delta");
    if (delta === undefined) return { type: "other", eventType, raw: value };
    return eventType === "text_delta"
      ? { type: "text_delta", delta }
      : { type: "thinking_delta", delta };
  }
  if (
    eventType === "toolcall_start" ||
    eventType === "toolcall_delta" ||
    eventType === "toolcall_end"
  ) {
    const partial = recordField(value, "partial");
    const partialContent = partial === undefined ? [] : (arrayField(partial, "content") ?? []);
    const contentIndex = numberField(value, "contentIndex") ?? 0;
    const direct = isBoundaryRecord(value) ? decodeAssistantToolCall(value.toolCall) : undefined;
    const indexed = decodeAssistantToolCall(partialContent[contentIndex]);
    return { type: eventType, toolCall: direct ?? indexed, partialContent, contentIndex };
  }
  return { type: "other", eventType, raw: value };
}

export type PiMessageUpdateEvent = {
  type: "message_update";
  assistantMessageEvent?: PiAssistantMessageEvent;
};

export type PiToolExecutionStartEvent = {
  type: "tool_execution_start";
  toolCallId?: string;
  toolName?: string;
  args?: PiToolArguments;
};

export type PiToolExecutionUpdateEvent = {
  type: "tool_execution_update";
  toolCallId?: string;
  partialResult?: PiToolResult;
};

export type PiToolExecutionEndEvent = {
  type: "tool_execution_end";
  toolCallId?: string;
  result?: PiToolResult;
  isError?: boolean;
};

export type PiExtensionUiRequestEvent = {
  type: "extension_ui_request";
  id?: string;
  method?: string;
  title?: string;
  message?: string;
  options?: BoundaryValue[];
  placeholder?: string;
  prefill?: string;
  notifyType?: string;
  timeoutMs?: number;
  value?: string;
  text?: string;
  raw?: BoundaryValue;
};

export type PiAutoRetryStartEvent = {
  type: "auto_retry_start";
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
};

export type PiAgentEndEvent = {
  type: "agent_end";
  willRetry?: boolean;
};

export type PiResponseEvent = {
  type: "response";
  id?: string;
  command?: string;
  success?: boolean;
  data?: BoundaryValue;
  error?: string;
};

export type PiLifecycleEvent = {
  type:
    | "auto_retry_end"
    | "auto_compaction_start"
    | "auto_compaction_end"
    | "agent_start"
    | "turn_end"
    | "agent_settled";
};

export type PiUnknownEvent = {
  type: "unknown_event";
  eventType?: string;
  raw?: BoundaryValue;
};

export type PiRpcEvent =
  | PiMessageUpdateEvent
  | PiToolExecutionStartEvent
  | PiToolExecutionUpdateEvent
  | PiToolExecutionEndEvent
  | PiExtensionUiRequestEvent
  | PiAutoRetryStartEvent
  | PiAgentEndEvent
  | PiResponseEvent
  | PiLifecycleEvent
  | PiUnknownEvent;

const LIFECYCLE_EVENT_TYPES = [
  "auto_retry_end",
  "auto_compaction_start",
  "auto_compaction_end",
  "agent_start",
  "turn_end",
  "agent_settled",
] as const;

function decodeLifecycleEvent(eventType: string): PiLifecycleEvent | undefined {
  for (const lifecycle of LIFECYCLE_EVENT_TYPES) {
    if (lifecycle === eventType) return { type: lifecycle };
  }
  return undefined;
}

function decodeExtensionUiRequest(value: BoundaryValue): PiExtensionUiRequestEvent {
  return {
    type: "extension_ui_request",
    id: stringField(value, "id"),
    method: stringField(value, "method"),
    title: stringField(value, "title"),
    message: stringField(value, "message"),
    options: arrayField(value, "options"),
    placeholder: stringField(value, "placeholder"),
    prefill: stringField(value, "prefill"),
    notifyType: stringField(value, "notifyType"),
    timeoutMs: numberField(value, "timeoutMs"),
    value: stringField(value, "value"),
    text: stringField(value, "text"),
    raw: value,
  };
}

export function decodePiRpcEvent(value: BoundaryValue): PiRpcEvent {
  const eventType = stringField(value, "type");
  if (eventType === undefined) return { type: "unknown_event", eventType: "", raw: value };

  if (eventType === "message_update") {
    const rawAssistantEvent = isBoundaryRecord(value) ? value.assistantMessageEvent : undefined;
    return {
      type: "message_update",
      assistantMessageEvent: decodeAssistantMessageEvent(rawAssistantEvent),
    };
  }

  if (eventType === "tool_execution_start") {
    return {
      type: "tool_execution_start",
      toolCallId: stringField(value, "toolCallId"),
      toolName: stringField(value, "toolName"),
      args: isBoundaryRecord(value) ? value.args : undefined,
    };
  }

  if (eventType === "tool_execution_update") {
    return {
      type: "tool_execution_update",
      toolCallId: stringField(value, "toolCallId"),
      partialResult: isBoundaryRecord(value) ? value.partialResult : undefined,
    };
  }

  if (eventType === "tool_execution_end") {
    return {
      type: "tool_execution_end",
      toolCallId: stringField(value, "toolCallId"),
      result: isBoundaryRecord(value) ? value.result : undefined,
      isError: booleanField(value, "isError") ?? false,
    };
  }

  if (eventType === "extension_ui_request") return decodeExtensionUiRequest(value);

  if (eventType === "auto_retry_start") {
    return {
      type: "auto_retry_start",
      attempt: numberField(value, "attempt"),
      maxAttempts: numberField(value, "maxAttempts"),
      delayMs: numberField(value, "delayMs"),
      errorMessage: stringField(value, "errorMessage"),
    };
  }

  if (eventType === "agent_end") {
    return { type: "agent_end", willRetry: booleanField(value, "willRetry") };
  }

  if (eventType === "response") {
    return {
      type: "response",
      id: stringField(value, "id"),
      command: stringField(value, "command"),
      success: booleanField(value, "success"),
      data: isBoundaryRecord(value) ? value.data : undefined,
      error: stringField(value, "error"),
    };
  }

  const lifecycle = decodeLifecycleEvent(eventType);
  return lifecycle ?? { type: "unknown_event", eventType, raw: value };
}
