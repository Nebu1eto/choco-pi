import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  arr,
  bool,
  compile,
  obj,
  oneOf,
  str,
  unknown,
  type Schema,
  type Static,
} from "@earendil-works/pi-schema";
import { isJsonObject } from "../../adapter/runtime-values.ts";
import { isBoolean, isNumber, isString } from "../value-guards.ts";
import type {
  ResponseCreateParamsStreaming,
  ResponseOutputItem,
} from "openai/resources/responses/responses.js";
import type {
  CodexCompactionContinuation,
  CodexCompactionDiagnostic,
} from "../../adapter/compaction/diagnostics.ts";
import type { CodexFastModeDecision } from "./fast-mode-decision.ts";
import type { CodexAccessPrograms, CodexDaybreakTicket } from "./daybreak-decision.ts";

// Wire request bodies: compiled once at module scope. Properties the schema does not name stay
// open, as the TypeBox object it replaces allowed them.
const responsesBodyRequiredValidator = compile(
  obj(
    {
      model: str(),
      store: bool(),
      stream: bool(),
      input: arr(unknown()),
      text: obj({ verbosity: str() }, { open: true }),
      include: arr(str()),
      tool_choice: oneOf(["auto", "none", "required"]),
      parallel_tool_calls: bool(),
    },
    { open: true },
  ),
);
const codexStreamEventValidator = compile({
  anyOf: [
    { type: "object" },
    { type: "array" },
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
});

/** Deep check of a JSON-like protocol value: finite numbers only, no undefined below the top level. */
function isDeepProtocolValue<Value>(value: Value): boolean {
  if (isString(value) || isNumber(value) || isBoolean(value) || value === null) return true;
  if (Array.isArray(value)) return value.every((item) => isDeepProtocolValue(item));
  if (isJsonObject(value)) return Object.values(value).every((item) => isDeepProtocolValue(item));
  return false;
}

export type ProtocolPrimitive = boolean | number | string | null;
// Schema-derived so the dictionary contract below names its owner; any JSON value or live object.
const protocolValueSchema: Schema<object | string | number | boolean | null> = {
  anyOf: [
    { type: "object" },
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
};
export type ProtocolValue = Static<typeof protocolValueSchema>;
export type ProtocolPropertyValue = ProtocolValue | undefined;
export type ProviderOutputItem = ResponseOutputItem | Extract<ProtocolValue, object>;
export interface ProtocolObject {
  [key: string]: ProtocolPropertyValue;
}

export function isProtocolObject<Value>(value: Value): value is Value & ProtocolObject {
  return (
    isJsonObject(value) &&
    Object.values(value).every((item) => item === undefined || isDeepProtocolValue(item))
  );
}

export function isResponsesBody<Value>(value: Value): value is Value & ResponsesBody {
  return isProtocolObject(value) && responsesBodyRequiredValidator.check(value);
}

export interface WebSocketArrayBufferData {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface WebSocketEvent {
  data?: string | ArrayBuffer | ArrayBufferView | Blob | WebSocketArrayBufferData | undefined;
  code?: number | undefined;
  reason?: string | undefined;
  error?: object | undefined;
}

export interface WebSocketLike {
  readyState?: number | undefined;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: WebSocketEvent) => void): void;
  removeEventListener(type: string, listener: (event: WebSocketEvent) => void): void;
}

export interface WebSocketConstructorLike {
  new (
    url: string,
    options?: { headers?: Record<string, string> | undefined } | string | string[],
  ): WebSocketLike;
}

export interface SessionWebSocketCacheEntry {
  socket: WebSocketLike;
  busy: boolean;
  continuation?: CachedWebSocketContinuationState | undefined;
}

export interface AcquiredWebSocket {
  socket: WebSocketLike;
  entry?: SessionWebSocketCacheEntry | undefined;
  reused: boolean;
  release: (options?: { keep?: boolean | undefined }) => void;
}

export interface CachedWebSocketContinuationState {
  lastRequestBody: ResponsesBody;
  lastResponseId: string;
  lastResponseItems: ProtocolValue[];
}

/**
 * Every decision is also a valid `CodexCompactionDiagnostic.continuation`: the
 * websocket stream copies it into the compaction diagnostic, and the details
 * validator rejects any value outside that list, hiding the compaction from
 * the native display path.
 */
export type WebSocketContinuationDecision = CodexCompactionContinuation;

export type CanonicalHistoryDecision =
  | "compaction"
  | "identity_mismatch"
  | "input_shorter_than_baseline"
  | "request_prefix_mismatch"
  | "response_prefix_mismatch"
  | "validated";

export type CodexDiagnosticsLane = "response" | "compaction" | "prewarm";
export type CodexDiagnosticsTransport = "websocket" | "sse";
export type CodexDiagnosticsFailureCategory =
  | "aborted"
  | "authentication"
  | "connection"
  | "connection_limit"
  | "message_too_big"
  | "overload"
  | "previous_response_missing"
  | "protocol"
  | "rate_limit"
  | "timeout"
  | "transport"
  | "unknown";
export interface CodexDiagnosticsFailure {
  category: CodexDiagnosticsFailureCategory;
  code?: string | undefined;
  status?: number | undefined;
}
export type CodexDiagnosticsEvent =
  | {
      type: "native-steering";
      failure?: CodexDiagnosticsFailure | undefined;
      phase:
        | "sent"
        | "accepted"
        | "automatic-ready"
        | "required-ready"
        | "failed"
        | "closed"
        | "fallback-history"
        | "fallback-input"
        | "fallback-settings";
    }
  | {
      type: "request";
      lane: CodexDiagnosticsLane;
      transport: CodexDiagnosticsTransport;
      attempt: number;
      fullInputItems: number;
      sentInputItems: number;
      model?: string | undefined;
      socketReused?: boolean | undefined;
      continuation?: WebSocketContinuationDecision | undefined;
      canonicalHistory?: CanonicalHistoryDecision | undefined;
      compaction?: CodexCompactionDiagnostic | undefined;
      previousResponseId?: boolean | undefined;
      nativeSteering?: "automatic" | "required" | undefined;
    }
  | {
      type: "usage";
      lane: Exclude<CodexDiagnosticsLane, "prewarm">;
      transport: CodexDiagnosticsTransport;
      inputTokens: number;
      cachedInputTokens: number;
      cacheWriteInputTokens: number;
      outputTokens: number;
    }
  | {
      type: "retry";
      lane: Exclude<CodexDiagnosticsLane, "prewarm">;
      transport: CodexDiagnosticsTransport;
      attempt: number;
      delayMs?: number | undefined;
      failure: CodexDiagnosticsFailure;
    }
  | {
      type: "fallback";
      lane: Exclude<CodexDiagnosticsLane, "prewarm">;
      from: CodexDiagnosticsTransport;
      to: CodexDiagnosticsTransport;
      reason: "upgrade_required" | "message_too_big" | "unauthorized" | "retry_budget_exhausted";
    }
  | {
      type: "failure";
      lane: CodexDiagnosticsLane;
      transport: CodexDiagnosticsTransport;
      failure: CodexDiagnosticsFailure;
    }
  | {
      type: "prewarm-ready";
      transport: "websocket";
      socketReused: boolean;
    };

export type CodexDiagnosticsSink = (event: CodexDiagnosticsEvent) => void;

export interface CachedWebSocketRequestBodyResult {
  body: ResponsesBody;
  decision: WebSocketContinuationDecision;
}

export type ServiceTier = ResponseCreateParamsStreaming["service_tier"];
export type ProviderEnv = Record<string, string>;
export type CodexProviderStreamOptions = SimpleStreamOptions & {
  serviceTier?: ServiceTier | undefined;
  textVerbosity?: string | undefined;
  reasoningSummary?: string | undefined;
  toolChoice?: "auto" | "none" | "required" | undefined;
};
export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type OpenAICodexStreamOptions = CodexProviderStreamOptions & {
  fastModeDecision?: CodexFastModeDecision | undefined;
  /** Minted by the registered provider entry; injected values are never trusted. */
  daybreakTicket?: CodexDaybreakTicket | undefined;
  midTurnSteering?: boolean | undefined;
  asyncCodeMode?: boolean | undefined;
  reasoningEffort?: CodexReasoningEffort | undefined;
  responsesLite?: boolean | undefined;
  grammarToolInputProperties?: ReadonlyMap<string, string> | undefined;
  onOutputItemDone?: ((item: ProviderOutputItem) => void) | undefined;
  websocketConnectTimeoutMs?: number | undefined;
  env?: ProviderEnv | undefined;
  canonicalCompaction?: boolean | undefined;
  /** Isolated native preparation: no foreground turn state or responses-lite rewriting. */
  backgroundCompactionLane?: boolean | undefined;
  validateBackgroundCompactionPayload?: ((body: ResponsesBody) => boolean) | undefined;
  compactionDiagnostics?: CodexCompactionDiagnostic | undefined;
};

export interface ResponsesBody {
  model: string;
  store: boolean;
  stream: boolean;
  instructions?: string | undefined;
  previous_response_id?: string | undefined;
  input: ProtocolValue[];
  text: { verbosity: string };
  include: string[];
  prompt_cache_key?: string | undefined;
  tool_choice: "auto" | "none" | "required";
  parallel_tool_calls: boolean;
  temperature?: number | undefined;
  service_tier?: ServiceTier | undefined;
  access_programs?: CodexAccessPrograms | undefined;
  tools?: ProtocolValue[] | undefined;
  reasoning?:
    | {
        effort?: string | undefined;
        summary?: string | undefined;
        context?: "all_turns" | undefined;
      }
    | undefined;
  client_metadata?: Record<string, string> | undefined;
  [key: string]: ProtocolPropertyValue;
}

export interface CodexPrewarmUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
}

export interface CodexPrewarmResult {
  socketReused: boolean;
  usage?: CodexPrewarmUsage | undefined;
}

export interface ResponseEnvelope {
  id?: string | undefined;
  status?: string | undefined;
  usage?:
    | {
        input_tokens?: number | undefined;
        output_tokens?: number | undefined;
        total_tokens?: number | undefined;
        input_tokens_details?:
          | { cached_tokens?: number | undefined; cache_write_tokens?: number | undefined }
          | undefined;
        output_tokens_details?: { reasoning_tokens?: number | undefined } | undefined;
      }
    | undefined;
  service_tier?: string | undefined;
  error?:
    | (ProtocolObject & {
        code?: string | undefined;
        type?: string | undefined;
        message?: string | undefined;
        status?: number | string | undefined;
        status_code?: number | string | undefined;
      })
    | undefined;
  [key: string]: ProtocolPropertyValue;
}

export interface CodexStreamEvent {
  type?: string | undefined;
  headers?: ProtocolObject | undefined;
  response?: ResponseEnvelope | undefined;
  item?:
    | (ProtocolObject & {
        id?: string | undefined;
        type?: string | undefined;
        result?: string | null | undefined;
        output_format?: string | undefined;
        revised_prompt?: string | undefined;
        status?: string | undefined;
      })
    | undefined;
  code?: string | undefined;
  message?: string | undefined;
  [key: string]: ProtocolPropertyValue;
}

/** Any JSON value is a stream event candidate, as the former union of JSON kinds accepted. */
export function isCodexStreamEvent<Value>(value: Value): value is Value & CodexStreamEvent {
  return codexStreamEventValidator.check(value);
}

export function createInitialAssistantMessage(model: {
  provider: string;
  id: string;
}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}
