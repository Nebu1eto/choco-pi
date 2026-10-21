/**
 * Wire-faithful transport capture for the xAI native lane.
 *
 * A provider registered through `registerProvider` delegates to the INSTALLED
 * `openai-responses` adapter with a capturing `fetch`; that fetch sees the
 * serialized body after every `before_provider_request` handler, so it is the
 * only trustworthy view of what was sent. Each captured Responses `input` is
 * aligned to branch entries by content keys (text, `call_id`, image data URL,
 * compaction `encrypted_content`) with the shared order-preserving aligner.
 *
 * Captures hold the request body (conversation content, never credentials).
 * Transport checks registered for the current provider call run before the
 * request leaves the process; a failed check refuses it locally (fail closed).
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type {
  Api,
  AssistantMessageEventStream,
  Message,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { streamSimple as installedStreamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import {
  convertToLlm,
  type ExtensionAPI,
  type ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import {
  alignKeyedWire,
  freezeJson,
  type WireKey,
  wireKey,
  type WireMapping,
} from "../anthropic/capture.ts";
import { JsonValueSchema } from "../background/contract.ts";
import { isXaiDetails } from "./details.ts";

// ---------------------------------------------------------------------------
// Wire model (Responses `input` items)
// ---------------------------------------------------------------------------

const JsonRecordSchema = Type.Record(Type.String(), JsonValueSchema);
export const XaiWireItemSchema = JsonRecordSchema;
export const XaiWireBodySchema = Type.Intersect([
  Type.Object({
    model: Type.String({ minLength: 1 }),
    input: Type.Array(XaiWireItemSchema),
  }),
  JsonRecordSchema,
]);
export type XaiWireItem = Static<typeof XaiWireItemSchema>;
export type XaiWireBody = Static<typeof XaiWireBodySchema>;

const InstructionItemSchema = Type.Object({
  role: Type.Union([Type.Literal("system"), Type.Literal("developer")]),
  content: Type.String(),
});
const UserMessageSchema = Type.Object({
  role: Type.Literal("user"),
  content: Type.Union([Type.String(), Type.Array(JsonRecordSchema)]),
});
const AssistantMessageSchema = Type.Object({
  type: Type.Literal("message"),
  role: Type.Literal("assistant"),
  content: Type.Array(JsonRecordSchema),
});
const InputTextSchema = Type.Object({
  type: Type.Union([Type.Literal("input_text"), Type.Literal("output_text")]),
  text: Type.String(),
});
const InputImageSchema = Type.Object({
  type: Type.Literal("input_image"),
  image_url: Type.String(),
});
const CallIdSchema = Type.Object({ call_id: Type.String({ minLength: 1 }) });
const WireCompactionItemSchema = Type.Object({
  type: Type.Literal("compaction"),
  encrypted_content: Type.String(),
});
const StringSchema = Type.String();

/** Items opening a tool call answered by a later output item with the same `call_id`. */
const CALL_TYPES: ReadonlySet<string> = new Set([
  "function_call",
  "custom_tool_call",
  "tool_search_call",
]);
const OUTPUT_TYPES: ReadonlySet<string> = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "tool_search_output",
]);

export function parseXaiWireBody(text: string): XaiWireBody | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return Value.Check(XaiWireBodySchema, parsed) ? parsed : undefined;
}

function itemType(item: XaiWireItem): string | undefined {
  return Value.Check(StringSchema, item.type) ? item.type : undefined;
}

/** Role-like label of an item: its `role`, else its `type`, else "item". */
export function itemRole(item: XaiWireItem): string {
  if (Value.Check(StringSchema, item.role)) return item.role;
  return itemType(item) ?? "item";
}

/** A leading system prompt or mid-conversation system update (`system`/`developer`, string content). */
export function isInstructionItem(item: XaiWireItem | undefined): boolean {
  return item !== undefined && Value.Check(InstructionItemSchema, item);
}

export function isUserMessageItem(item: XaiWireItem | undefined): boolean {
  return item !== undefined && Value.Check(UserMessageSchema, item);
}

export function isCompactionWireItem(item: XaiWireItem | undefined): boolean {
  return item !== undefined && Value.Check(WireCompactionItemSchema, item);
}

export function countCompactionItems(items: readonly XaiWireItem[]): number {
  return items.filter((item) => isCompactionWireItem(item)).length;
}

/** `call_id` of a tool-call opening item, else undefined. */
export function callIdOf(item: XaiWireItem): string | undefined {
  const type = itemType(item);
  if (type === undefined || !CALL_TYPES.has(type)) return undefined;
  return Value.Check(CallIdSchema, item) ? item.call_id : undefined;
}

/** `call_id` of a tool output item, else undefined. */
export function outputIdOf(item: XaiWireItem): string | undefined {
  const type = itemType(item);
  if (type === undefined || !OUTPUT_TYPES.has(type)) return undefined;
  return Value.Check(CallIdSchema, item) ? item.call_id : undefined;
}

/**
 * Index of the leading instruction item the adapter writes for the system
 * prompt: 0, or 1 right after a replayed compaction item; -1 when absent.
 */
export function leadingInstructionIndex(input: readonly XaiWireItem[]): number {
  if (isInstructionItem(input[0])) return 0;
  if (isCompactionWireItem(input[0]) && isInstructionItem(input[1])) return 1;
  return -1;
}

// ---------------------------------------------------------------------------
// Key alignment (wire item <-> projected entry)
// ---------------------------------------------------------------------------

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

function textKey(text: string): WireKey[] {
  return isBlank(text) ? [] : [wireKey("text", text)];
}

function contentKeys(content: readonly XaiWireItem[]): WireKey[] {
  return content.flatMap((part): WireKey[] => {
    if (Value.Check(InputTextSchema, part)) return textKey(part.text);
    if (Value.Check(InputImageSchema, part)) return [wireKey("image", part.image_url)];
    return [];
  });
}

/** Keys of one transport item. Instructions and reasoning are deliberately unkeyed. */
function wireItemKeys(item: XaiWireItem): WireKey[] {
  if (Value.Check(UserMessageSchema, item)) {
    return Array.isArray(item.content) ? contentKeys(item.content) : textKey(item.content);
  }
  if (Value.Check(AssistantMessageSchema, item)) return contentKeys(item.content);
  if (Value.Check(WireCompactionItemSchema, item)) {
    return [wireKey("compaction", item.encrypted_content)];
  }
  const call = callIdOf(item);
  if (call !== undefined) return [wireKey("tool_use", call)];
  const output = outputIdOf(item);
  if (output !== undefined) return [wireKey("tool_result", output)];
  return [];
}

/** The adapter's id sanitizing for tool calls from another provider or model. */
function normalizeIdPart(part: string): string {
  return part
    .replace(/[^a-zA-Z0-9_-]/gu, "_")
    .slice(0, 64)
    .replace(/_+$/u, "");
}

/** Every `call_id` the adapter may emit for a host tool-call id (same-model raw or normalized). */
function callIdVariants(id: string): string[] {
  const [raw = id] = id.split("|");
  return [...new Set([raw, normalizeIdPart(id)])];
}

function llmMessageKeys(message: Message): WireKey[] {
  if (message.role === "user") {
    if (!Array.isArray(message.content)) return textKey(message.content);
    return message.content.flatMap((part): WireKey[] =>
      part.type === "text"
        ? textKey(part.text)
        : [wireKey("image", `data:${part.mimeType};base64,${part.data}`)],
    );
  }
  if (message.role === "assistant") {
    return message.content.flatMap((part): WireKey[] => {
      if (part.type === "text") return textKey(part.text);
      if (part.type === "toolCall") {
        return callIdVariants(part.id).map((id) => wireKey("tool_use", id));
      }
      return [];
    });
  }
  if (message.role === "toolResult") {
    return callIdVariants(message.toolCallId).map((id) => wireKey("tool_result", id));
  }
  return [];
}

function projectedEntryKeys(entry: ProjectedSessionEntry): WireKey[] {
  const keys = convertToLlm(entry.messages).flatMap(llmMessageKeys);
  const source = entry.sourceEntry;
  // Only the newest compaction is projected with messages (and sent as an item);
  // an older one retained in the kept range is invisible and absent from the wire.
  if (source.type === "compaction" && entry.messages.length > 0 && isXaiDetails(source.details)) {
    keys.push(wireKey("compaction", source.details.item.encrypted_content));
  }
  return keys;
}

/** Align captured input items to the branch projection at request time. */
export function mapXaiWireToEntries(
  input: readonly XaiWireItem[],
  entries: readonly ProjectedSessionEntry[],
): WireMapping {
  return alignKeyedWire(
    input.map((item, index) => ({
      role: itemRole(item),
      keys: wireItemKeys(item),
      continuesPrevious: isAssistantTurnItem(item) && isAssistantTurnItem(input[index - 1]),
    })),
    entries.map((entry) => ({
      entryId: entry.sourceEntry.id,
      visible: entry.messages.length > 0,
      keys: projectedEntryKeys(entry),
    })),
  );
}

/**
 * Items the adapter emits for one assistant message: its reasoning item, its
 * text as an assistant `message` item, and its tool calls. A turn with text
 * and a call (or several calls) spans several consecutive items that all map
 * to the same projected entry.
 */
function isAssistantTurnItem(item: XaiWireItem | undefined): boolean {
  if (item === undefined) return false;
  if (Value.Check(AssistantMessageSchema, item)) return true;
  const type = itemType(item);
  return type === "reasoning" || (type !== undefined && CALL_TYPES.has(type));
}

// ---------------------------------------------------------------------------
// Captures and the per-call transport context
// ---------------------------------------------------------------------------

export interface XaiWireCapture {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly sequence: number;
  readonly capturedAt: number;
  readonly provider: string;
  readonly modelId: string;
  readonly baseUrl: string;
  /** Request URL origin and path; the query is dropped. */
  readonly endpoint: string;
  /** HTTP status of the response to this exact request. */
  readonly status: number;
  readonly bodyText: string;
  /** Deep-frozen parse of bodyText. */
  readonly body: XaiWireBody;
  /** Undefined when no projection source was bound for the session. */
  readonly mapping: WireMapping | undefined;
}

export interface XaiTransportRequest {
  readonly sessionId: string | undefined;
  readonly body: XaiWireBody;
  readonly bodyText: string;
}
export type XaiTransportVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: string;
      /** Local, user-facing refusal text (without the prefix); defaults to the code. */
      readonly message?: string;
    };
type TransportCheck = (request: XaiTransportRequest) => XaiTransportVerdict;
/** Observes the provider response before the adapter reads it; must read a clone and never throw. */
export type XaiResponseObserver = (response: Response) => Promise<void>;

interface TransportCall {
  readonly sessionId: string | undefined;
  readonly checks: TransportCheck[];
  readonly responseObservers: XaiResponseObserver[];
  /** Called once with the reason code when a check refuses the request. */
  readonly refusalObservers: ((code: string) => void)[];
  readonly refusals: string[];
}

interface TransportRefusal {
  readonly sessionId: string | undefined;
  readonly code: string;
  readonly at: number;
}

type ProjectionSource = () => readonly ProjectedSessionEntry[];

interface LaneRuntime {
  readonly schemaVersion: 1;
  readonly calls: AsyncLocalStorage<TransportCall>;
  readonly captures: Map<string, XaiWireCapture[]>;
  readonly projections: Map<string, ProjectionSource>;
  readonly refusals: TransportRefusal[];
  readonly counter: { value: number };
}

const RUNTIME_SYMBOL = Symbol.for("choco-pi:xai-native-lane");
const RuntimeSlotSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  calls: Type.Unknown(),
  captures: Type.Unknown(),
  projections: Type.Unknown(),
  refusals: Type.Array(Type.Unknown()),
  counter: Type.Object({ value: Type.Integer({ minimum: 0 }) }),
});

function isRuntime<T>(value: T): value is T & LaneRuntime {
  return (
    Value.Check(RuntimeSlotSchema, value) &&
    value.calls instanceof AsyncLocalStorage &&
    value.captures instanceof Map &&
    value.projections instanceof Map
  );
}

/** Process-wide state shared by every extension instance that loads this module. */
function runtime(): LaneRuntime {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, RUNTIME_SYMBOL);
  const found: unknown = descriptor?.value;
  if (descriptor !== undefined) {
    if (!isRuntime(found)) throw new Error("Invalid xAI native lane runtime slot");
    return found;
  }
  const created: LaneRuntime = {
    schemaVersion: 1,
    calls: new AsyncLocalStorage<TransportCall>(),
    captures: new Map(),
    projections: new Map(),
    refusals: [],
    counter: { value: 0 },
  };
  Object.defineProperty(globalThis, RUNTIME_SYMBOL, { value: created, configurable: true });
  return created;
}

const MAX_SESSIONS = 64;
const MAX_REFUSALS = 64;
const DEFAULT_CAPTURES_PER_SESSION = 4;

/** The xAI transport call a before_provider_request handler is running for, if any. */
export function currentXaiTransportCall(): TransportCall | undefined {
  return runtime().calls.getStore();
}

/** Bind the projection captures map against; the returned unbind removes only this source. */
export function bindXaiSessionProjection(sessionId: string, source: ProjectionSource): () => void {
  const projections = runtime().projections;
  projections.set(sessionId, source);
  return () => {
    if (projections.get(sessionId) === source) projections.delete(sessionId);
  };
}

/** Captures for a session, oldest first. */
export function xaiCapturesFor(sessionId: string): readonly XaiWireCapture[] {
  return runtime().captures.get(sessionId) ?? [];
}

export function releaseXaiSessionCaptures(sessionId: string): void {
  const state = runtime();
  state.captures.delete(sessionId);
  state.projections.delete(sessionId);
}

export function xaiTransportRefusals(sessionId?: string): readonly TransportRefusal[] {
  const refusals = runtime().refusals;
  return sessionId === undefined
    ? [...refusals]
    : refusals.filter((refusal) => refusal.sessionId === sessionId);
}

/** Every refusal is a local error of this package, never a provider body. */
export const XAI_TRANSPORT_REFUSAL_PREFIX = "choco-pi compaction: xAI native transport refused";
const TRANSPORT_REFUSAL_HEADER = "x-choco-pi-transport-refusal";

export type XaiProviderStream = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface XaiCapturingOptions {
  /** Defaults to the installed openai-responses adapter's streamSimple. */
  readonly delegate?: typeof installedStreamSimple;
  /** Base transport; defaults to the host-provided fetch, then globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly maxCapturesPerSession?: number;
}

function isResponsesModel(model: Model<Api>): model is Model<"openai-responses"> {
  return model.api === "openai-responses";
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
}

function endpointOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

function projectionFor(
  sessionId: string | undefined,
): readonly ProjectedSessionEntry[] | undefined {
  if (sessionId === undefined) return undefined;
  const source = runtime().projections.get(sessionId);
  if (source === undefined) return undefined;
  try {
    return source();
  } catch {
    // A stale or disposed session context cannot describe this request; leave it unmapped.
    return undefined;
  }
}

function storeCapture(capture: XaiWireCapture, limit: number): void {
  const captures = runtime().captures;
  const list = captures.get(capture.sessionId) ?? [];
  captures.delete(capture.sessionId);
  captures.set(capture.sessionId, [...list, capture].slice(-limit));
  while (captures.size > MAX_SESSIONS) {
    const oldest = captures.keys().next();
    if (oldest.done === true) break;
    captures.delete(oldest.value);
  }
}

/** A refused request is answered locally with a non-retryable 400 and never transmitted. */
function refuse(call: TransportCall, code: string, now: number, detail?: string): Response {
  call.refusals.push(code);
  const refusals = runtime().refusals;
  refusals.push({ sessionId: call.sessionId, code, at: now });
  if (refusals.length > MAX_REFUSALS) refusals.splice(0, refusals.length - MAX_REFUSALS);
  for (const observe of call.refusalObservers.splice(0)) observe(code);
  const message = `${XAI_TRANSPORT_REFUSAL_PREFIX} (${code}): ${detail ?? code}`;
  return new Response(JSON.stringify({ error: { type: "invalid_request_error", code, message } }), {
    status: 400,
    headers: { "content-type": "application/json", [TRANSPORT_REFUSAL_HEADER]: code },
  });
}

interface CaptureSettings {
  readonly delegate: typeof installedStreamSimple;
  readonly now: () => number;
  readonly limit: number;
  readonly fetch: typeof globalThis.fetch | undefined;
}

interface CaptureCall {
  readonly settings: CaptureSettings;
  readonly model: Model<"openai-responses">;
  readonly call: TransportCall;
  readonly base: typeof globalThis.fetch;
}

/**
 * Provider `streamSimple` running the installed Responses adapter with a
 * capturing, verifying fetch. Captures are keyed by `options.sessionId`;
 * requests without one are verified but not captured.
 */
export function createXaiCapturingStreamSimple(
  options: XaiCapturingOptions = {},
): XaiProviderStream {
  const settings: CaptureSettings = {
    delegate: options.delegate ?? installedStreamSimple,
    now: options.now ?? Date.now,
    limit: Math.max(1, options.maxCapturesPerSession ?? DEFAULT_CAPTURES_PER_SESSION),
    fetch: options.fetch,
  };
  return (model, context, streamOptions) => {
    if (!isResponsesModel(model)) {
      throw new Error(`xAI capture cannot serve api ${model.api}`);
    }
    const call: TransportCall = {
      sessionId: streamOptions?.sessionId,
      checks: [],
      responseObservers: [],
      refusalObservers: [],
      refusals: [],
    };
    const base = settings.fetch ?? streamOptions?.fetch ?? globalThis.fetch;
    const capture: CaptureCall = { settings, model, call, base };
    const capturingFetch: typeof globalThis.fetch = (input, init) =>
      captureAndForward(capture, input, init);
    return runtime().calls.run(call, () =>
      settings.delegate(model, context, { ...streamOptions, fetch: capturingFetch }),
    );
  };
}

interface ReadRequest {
  readonly bodyText: string | undefined;
  readonly body: XaiWireBody | undefined;
}

function readRequest(init: RequestInit | undefined): ReadRequest {
  const bodyText = Value.Check(StringSchema, init?.body) ? init.body : undefined;
  return { bodyText, body: bodyText === undefined ? undefined : parseXaiWireBody(bodyText) };
}

function verifyRequest(capture: CaptureCall, request: ReadRequest): Response | undefined {
  const { call, settings } = capture;
  if (call.checks.length === 0) return undefined;
  const { body, bodyText } = request;
  if (body === undefined || bodyText === undefined) {
    return refuse(call, "body-unreadable", settings.now());
  }
  for (const check of call.checks) {
    const verdict = check({ sessionId: call.sessionId, body, bodyText });
    if (!verdict.ok) return refuse(call, verdict.code, settings.now(), verdict.message);
  }
  return undefined;
}

async function captureAndForward(
  capture: CaptureCall,
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
): Promise<Response> {
  const url = requestUrl(input);
  const request = readRequest(init);
  const refusal = verifyRequest(capture, request);
  if (refusal) return refusal;
  const entries = projectionFor(capture.call.sessionId);
  const mapping =
    request.body === undefined || entries === undefined
      ? undefined
      : mapXaiWireToEntries(request.body.input, entries);
  const response = await capture.base(input, init);
  recordCapture(capture, { url, request, mapping, status: response.status });
  for (const observe of capture.call.responseObservers) await observe(response);
  return response;
}

function recordCapture(
  capture: CaptureCall,
  sent: {
    readonly url: string;
    readonly request: ReadRequest;
    readonly mapping: WireMapping | undefined;
    readonly status: number;
  },
): void {
  const { sessionId } = capture.call;
  const { body, bodyText } = sent.request;
  if (sessionId === undefined || body === undefined || bodyText === undefined) return;
  freezeJson(body);
  const counter = runtime().counter;
  counter.value += 1;
  const { model, settings } = capture;
  storeCapture(
    {
      schemaVersion: 1,
      sessionId,
      sequence: counter.value,
      capturedAt: settings.now(),
      provider: model.provider,
      modelId: model.id,
      baseUrl: model.baseUrl,
      endpoint: endpointOf(sent.url),
      status: sent.status,
      bodyText,
      body,
      mapping: sent.mapping,
    },
    settings.limit,
  );
}

/** Override `provider`'s Responses stream with the capturing wrapper (models and auth are kept). */
export function registerXaiCapture(
  pi: ExtensionAPI,
  provider: string,
  options: XaiCapturingOptions = {},
): void {
  pi.registerProvider(provider, {
    api: "openai-responses",
    streamSimple: createXaiCapturingStreamSimple(options),
  });
}
