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
import { arr, compile, lit, obj, oneOf, str, union } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import {
  alignKeyedWire,
  freezeJson,
  type WireKey,
  wireKey,
  type WireMapping,
} from "../anthropic/capture.ts";
import {
  jsonRecordMember,
  jsonRest,
  JsonRecordSchema,
  withJsonValueDefs,
} from "../background/contract.ts";
import { isString, nonEmptyStr } from "../guards.ts";
import { isXaiDetails } from "./details.ts";
import {
  endpointOf,
  laneRuntime,
  type LaneRuntime,
  type ProjectionSource,
  projectionFor,
  requestUrl,
  responseRingSlot,
  storeBounded,
} from "../shared/lane-runtime.ts";

export const XaiWireItemSchema = JsonRecordSchema;
const xaiWireBody = jsonRest({
  model: nonEmptyStr(),
  input: arr(jsonRecordMember),
});
export const XaiWireBodySchema = withJsonValueDefs(xaiWireBody);
export type XaiWireItem = Static<typeof XaiWireItemSchema>;
export type XaiWireBody = Static<typeof xaiWireBody>;
export const isXaiWireBody = compile(XaiWireBodySchema).check;

const open = { open: true } as const;
const isInstructionFields = compile(
  obj({ role: oneOf(["system", "developer"]), content: str() }, open),
).check;
const isUserMessageFields = compile(
  withJsonValueDefs(
    obj({ role: lit("user"), content: union([str(), arr(jsonRecordMember)]) }, open),
  ),
).check;
const isAssistantMessage = compile(
  withJsonValueDefs(
    obj({ type: lit("message"), role: lit("assistant"), content: arr(jsonRecordMember) }, open),
  ),
).check;
const isInputText = compile(
  obj({ type: oneOf(["input_text", "output_text"]), text: str() }, open),
).check;
const isInputImage = compile(obj({ type: lit("input_image"), image_url: str() }, open)).check;
const hasCallId = compile(obj({ call_id: nonEmptyStr() }, open)).check;
const isWireCompactionItem = compile(
  obj({ type: lit("compaction"), encrypted_content: str() }, open),
).check;

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
  return isXaiWireBody(parsed) ? parsed : undefined;
}

function itemType(item: XaiWireItem): string | undefined {
  return isString(item.type) ? item.type : undefined;
}

export function itemRole(item: XaiWireItem): string {
  if (isString(item.role)) return item.role;
  return itemType(item) ?? "item";
}

export function isInstructionItem(item: XaiWireItem | undefined): boolean {
  return item !== undefined && isInstructionFields(item);
}

export function isUserMessageItem(item: XaiWireItem | undefined): boolean {
  return item !== undefined && isUserMessageFields(item);
}

export function isCompactionWireItem(item: XaiWireItem | undefined): boolean {
  return item !== undefined && isWireCompactionItem(item);
}

export function countCompactionItems(items: readonly XaiWireItem[]): number {
  return items.filter((item) => isCompactionWireItem(item)).length;
}

export function callIdOf(item: XaiWireItem): string | undefined {
  const type = itemType(item);
  if (type === undefined || !CALL_TYPES.has(type)) return undefined;
  return hasCallId(item) ? item.call_id : undefined;
}

export function outputIdOf(item: XaiWireItem): string | undefined {
  const type = itemType(item);
  if (type === undefined || !OUTPUT_TYPES.has(type)) return undefined;
  return hasCallId(item) ? item.call_id : undefined;
}

export function leadingInstructionIndex(input: readonly XaiWireItem[]): number {
  if (isInstructionItem(input[0])) return 0;
  if (isCompactionWireItem(input[0]) && isInstructionItem(input[1])) return 1;
  return -1;
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

function textKey(text: string): WireKey[] {
  return isBlank(text) ? [] : [wireKey("text", text)];
}

function contentKeys(content: readonly XaiWireItem[]): WireKey[] {
  return content.flatMap((part): WireKey[] => {
    if (isInputText(part)) return textKey(part.text);
    if (isInputImage(part)) return [wireKey("image", part.image_url)];
    return [];
  });
}

function wireItemKeys(item: XaiWireItem): WireKey[] {
  if (isUserMessageFields(item)) {
    return Array.isArray(item.content) ? contentKeys(item.content) : textKey(item.content);
  }
  if (isAssistantMessage(item)) return contentKeys(item.content);
  if (isWireCompactionItem(item)) {
    return [wireKey("compaction", item.encrypted_content)];
  }
  const call = callIdOf(item);
  if (call !== undefined) return [wireKey("tool_use", call)];
  const output = outputIdOf(item);
  if (output !== undefined) return [wireKey("tool_result", output)];
  return [];
}

function normalizeIdPart(part: string): string {
  return part
    .replace(/[^a-zA-Z0-9_-]/gu, "_")
    .slice(0, 64)
    .replace(/_+$/u, "");
}

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
  if (source.type === "compaction" && entry.messages.length > 0 && isXaiDetails(source.details)) {
    keys.push(wireKey("compaction", source.details.item.encrypted_content));
  }
  return keys;
}

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

function isAssistantTurnItem(item: XaiWireItem | undefined): boolean {
  if (item === undefined) return false;
  if (isAssistantMessage(item)) return true;
  const type = itemType(item);
  return type === "reasoning" || (type !== undefined && CALL_TYPES.has(type));
}

export interface XaiWireCapture {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly sequence: number;
  readonly capturedAt: number;
  readonly provider: string;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly endpoint: string;
  readonly status: number;
  readonly bodyText: string;
  readonly body: XaiWireBody;
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
      readonly message?: string;
    };
type TransportCheck = (request: XaiTransportRequest) => XaiTransportVerdict;
export type XaiResponseObserver = (response: Response) => Promise<void>;

interface TransportCall {
  readonly sessionId: string | undefined;
  readonly checks: TransportCheck[];
  readonly responseObservers: XaiResponseObserver[];
  readonly refusalObservers: ((code: string) => void)[];
  readonly refusals: string[];
}

interface TransportRefusal {
  readonly sessionId: string | undefined;
  readonly code: string;
  readonly at: number;
}

const RUNTIME_SYMBOL = Symbol.for("choco-pi:xai-native-lane");

function runtime(): LaneRuntime<TransportCall, XaiWireCapture, TransportRefusal> {
  return laneRuntime<TransportCall, XaiWireCapture, TransportRefusal>(RUNTIME_SYMBOL, "xAI");
}

const MAX_REFUSALS = 64;
const DEFAULT_CAPTURES_PER_SESSION = 4;

export function currentXaiTransportCall(): TransportCall | undefined {
  return runtime().calls.getStore();
}

export function bindXaiSessionProjection(sessionId: string, source: ProjectionSource): () => void {
  const projections = runtime().projections;
  projections.set(sessionId, source);
  return () => {
    if (projections.get(sessionId) === source) projections.delete(sessionId);
  };
}

export function xaiCapturesFor(sessionId: string): readonly XaiWireCapture[] {
  return runtime().captures.get(sessionId) ?? [];
}

export function releaseXaiSessionCaptures(sessionId: string): void {
  const state = runtime();
  state.captures.delete(sessionId);
  state.projections.delete(sessionId);
  responseRing().delete(sessionId);
}

export interface XaiRecordedResponse {
  readonly sequence: number;
  readonly status: number;
  readonly capturedAt: number;
  readonly provider: string;
  readonly modelId: string;
  readonly baseUrl: string;
}

const RESPONSES_SYMBOL = Symbol.for("choco-pi:xai-native-responses");
const MAX_RESPONSES_PER_SESSION = 8;

function responseRing(): Map<string, XaiRecordedResponse[]> {
  return responseRingSlot<XaiRecordedResponse>(RESPONSES_SYMBOL, "xAI");
}

export function recentXaiResponsesFor(sessionId: string): readonly XaiRecordedResponse[] {
  return responseRing().get(sessionId) ?? [];
}

function storeResponse(sessionId: string, response: XaiRecordedResponse): void {
  storeBounded(responseRing(), sessionId, response, MAX_RESPONSES_PER_SESSION);
}

export function xaiTransportRefusals(sessionId?: string): readonly TransportRefusal[] {
  const refusals = runtime().refusals;
  return sessionId === undefined
    ? [...refusals]
    : refusals.filter((refusal) => refusal.sessionId === sessionId);
}

export const XAI_TRANSPORT_REFUSAL_PREFIX = "choco-pi compaction: xAI native transport refused";
const TRANSPORT_REFUSAL_HEADER = "x-choco-pi-transport-refusal";

export type XaiProviderStream = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface XaiCapturingOptions {
  readonly delegate?: typeof installedStreamSimple;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly maxCapturesPerSession?: number;
}

function isResponsesModel(model: Model<Api>): model is Model<"openai-responses"> {
  return model.api === "openai-responses";
}

function storeCapture(capture: XaiWireCapture, limit: number): void {
  storeBounded(runtime().captures, capture.sessionId, capture, limit);
}

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
  const bodyText = isString(init?.body) ? init.body : undefined;
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
  const entries = projectionFor(runtime().projections, capture.call.sessionId);
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
  const counter = runtime().counter;
  counter.value += 1;
  const { model, settings } = capture;
  if (sent.status !== 200 || sent.mapping === undefined) {
    storeResponse(sessionId, {
      sequence: counter.value,
      status: sent.status,
      capturedAt: settings.now(),
      provider: model.provider,
      modelId: model.id,
      baseUrl: model.baseUrl,
    });
    return;
  }
  freezeJson(body);
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
