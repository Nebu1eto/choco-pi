import type {
  Api,
  AssistantMessageEventStream,
  Message,
  Model,
  Provider,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { streamSimple as installedStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  convertToLlm,
  type ExtensionAPI,
  type ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";
import { arr, bool, compile, lit, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { jsonRest, withJsonValueDefs, type JsonValue } from "../background/contract.ts";
import { finiteInt, hasProperty, isString, nonEmptyStr, nonNegative } from "../guards.ts";
import { OPAQUE_GUARD_NOTICE, opaqueProviderOf } from "../opaque-checkpoint.ts";
import { pendingOpaqueBlock } from "../opaque-guard.ts";
import { isAnthropicDetails } from "./details.ts";
import { sha256 } from "../shared/details.ts";
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

const wireBlock = jsonRest({ type: str() });
const wireMessage = jsonRest({
  role: str(),
  content: union([str(), arr(wireBlock)]),
});
const wireBody = jsonRest({
  model: nonEmptyStr(),
  messages: arr(wireMessage),
});
export const WireBlockSchema = withJsonValueDefs(wireBlock);
export const wireBlockMember = wireBlock;
export const WireBodySchema = withJsonValueDefs(wireBody);
export type WireBlock = Static<typeof wireBlock>;
export type WireMessage = Static<typeof wireMessage>;
export type WireBody = Static<typeof wireBody>;
export const isWireBody = compile(WireBodySchema).check;

const isTextBlock = compile(obj({ type: lit("text"), text: str() }, { open: true })).check;
const isImageBlock = compile(
  obj({ type: lit("image"), source: obj({ data: str() }, { open: true }) }, { open: true }),
).check;
const isToolUseBlock = compile(obj({ type: lit("tool_use"), id: str() }, { open: true })).check;
const isToolResultBlock = compile(
  obj({ type: lit("tool_result"), tool_use_id: str() }, { open: true }),
).check;
const isSignedBlock = compile(
  obj({ type: lit("compaction"), signature: str() }, { open: true }),
).check;
const isThinkingBlock = compile(
  obj({ type: oneOf(["thinking", "redacted_thinking"]) }, { open: true }),
).check;
const isDeferredTool = compile(obj({ defer_loading: lit(true) }, { open: true })).check;

export function parseWireBody(text: string): WireBody | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isWireBody(parsed) ? parsed : undefined;
}

export function wireBlocks(message: WireMessage): readonly WireBlock[] {
  return Array.isArray(message.content) ? message.content : [];
}

export function toolUseIds(message: WireMessage): string[] {
  return wireBlocks(message).flatMap((block) => (isToolUseBlock(block) ? [block.id] : []));
}

export function toolResultIds(message: WireMessage): string[] {
  return wireBlocks(message).flatMap((block) =>
    isToolResultBlock(block) ? [block.tool_use_id] : [],
  );
}

export function hasThinking(message: WireMessage): boolean {
  return wireBlocks(message).some((block) => isThinkingBlock(block));
}

interface BindingDigests {
  readonly systemDigest: string;
  readonly toolsDigest: string;
}

export function bindingDigests(body: WireBody): BindingDigests {
  const tools = Array.isArray(body.tools)
    ? body.tools.filter((tool) => !isDeferredTool(tool))
    : (body.tools ?? null);
  return {
    systemDigest: sha256(JSON.stringify(body.system ?? null)),
    toolsDigest: sha256(JSON.stringify(tools)),
  };
}

export function countCompactionBlocks(messages: readonly WireMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total + wireBlocks(message).filter((block) => block.type === "compaction").length,
    0,
  );
}

export type WireKeyKind = "text" | "tool_use" | "tool_result" | "image" | "compaction";
interface WireKeyRef {
  readonly kind: WireKeyKind;
  readonly digest: string;
}
export interface WireKey {
  readonly id: string;
  readonly ref: WireKeyRef;
}

export function keyRef(kind: WireKeyKind, value: string): WireKeyRef {
  return { kind, digest: sha256(value).slice(0, 16) };
}

export function wireKey(kind: WireKeyKind, value: string): WireKey {
  return { id: `${kind}\u0000${value}`, ref: keyRef(kind, value) };
}

const key = wireKey;

function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64);
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

function wireMessageKeys(message: WireMessage): WireKey[] {
  if (message.role === "system") return [];
  if (!Array.isArray(message.content)) {
    return isBlank(message.content) ? [] : [key("text", message.content)];
  }
  return message.content.flatMap((block): WireKey[] => {
    if (isTextBlock(block)) return isBlank(block.text) ? [] : [key("text", block.text)];
    if (isToolUseBlock(block)) return [key("tool_use", block.id)];
    if (isToolResultBlock(block)) return [key("tool_result", block.tool_use_id)];
    if (isImageBlock(block)) return [key("image", block.source.data)];
    if (isSignedBlock(block)) return [key("compaction", block.signature)];
    return [];
  });
}

function llmMessageKeys(message: Message): WireKey[] {
  if (message.role === "user") {
    if (!Array.isArray(message.content)) {
      return isBlank(message.content) ? [] : [key("text", message.content)];
    }
    return message.content.flatMap((part): WireKey[] => {
      if (part.type === "text") return isBlank(part.text) ? [] : [key("text", part.text)];
      return [key("image", part.data)];
    });
  }
  if (message.role === "assistant") {
    return message.content.flatMap((part): WireKey[] => {
      if (part.type === "text") return isBlank(part.text) ? [] : [key("text", part.text)];
      if (part.type === "toolCall") return [key("tool_use", normalizeToolCallId(part.id))];
      return [];
    });
  }
  if (message.role === "toolResult") {
    return [key("tool_result", normalizeToolCallId(message.toolCallId))];
  }
  return [];
}

function projectedEntryKeys(entry: ProjectedSessionEntry): WireKey[] {
  const keys = convertToLlm(entry.messages).flatMap(llmMessageKeys);
  const source = entry.sourceEntry;
  if (
    source.type === "compaction" &&
    entry.messages.length > 0 &&
    isAnthropicDetails(source.details)
  ) {
    keys.push(key("compaction", source.details.block.signature));
  }
  return keys;
}

interface ProjectionRef {
  readonly entryId: string;
  readonly visible: boolean;
  readonly keyed: boolean;
}

interface AmbiguousKey {
  readonly key: WireKeyRef;
  readonly candidates: readonly string[];
  readonly outOfOrder: boolean;
}

interface WireMessageMapping {
  readonly index: number;
  readonly role: string;
  readonly entryIds: readonly string[];
  readonly unmapped: readonly WireKeyRef[];
  readonly ambiguous: readonly AmbiguousKey[];
}

export interface WireMapping {
  readonly projection: readonly ProjectionRef[];
  readonly messages: readonly WireMessageMapping[];
}

export interface KeyedWireMessage {
  readonly role: string;
  readonly keys: readonly WireKey[];
  readonly continuesPrevious?: boolean;
}

export interface KeyedProjection {
  readonly entryId: string;
  readonly visible: boolean;
  readonly keys: readonly WireKey[];
}

export function mapWireToEntries(
  messages: readonly WireMessage[],
  entries: readonly ProjectedSessionEntry[],
): WireMapping {
  return alignKeyedWire(
    messages.map((message) => ({ role: message.role, keys: wireMessageKeys(message) })),
    entries.map((entry) => ({
      entryId: entry.sourceEntry.id,
      visible: entry.messages.length > 0,
      keys: projectedEntryKeys(entry),
    })),
  );
}

export function alignKeyedWire(
  messages: readonly KeyedWireMessage[],
  entries: readonly KeyedProjection[],
): WireMapping {
  const owners = indexKeyOwners(entries);
  let floor = 0;
  let runFloor = 0;
  const alignments = messages.map((message) => {
    if (message.continuesPrevious !== true) runFloor = floor;
    const alignment = alignWireMessage(message, owners, runFloor);
    if (alignment.entryIndexes.length > 0) {
      floor = Math.max(floor, ...alignment.entryIndexes.map((index) => index + 1));
    }
    return alignment;
  });
  const positional = positionallyResolvedKeys(alignments, owners);
  const mapped = messages.map((message, index): WireMessageMapping => {
    const alignment = alignments[index];
    const ambiguous = (alignment?.ambiguous ?? []).filter(
      (record) => record.outOfOrder || !positional.has(record.keyId),
    );
    return {
      index,
      role: message.role,
      entryIds: entryIdsAt(owners.projection, alignment?.entryIndexes ?? []),
      unmapped: alignment?.unmapped ?? [],
      ambiguous: ambiguous.map(({ key: ref, candidates, outOfOrder }) => ({
        key: ref,
        candidates,
        outOfOrder,
      })),
    };
  });
  return { projection: owners.projection, messages: mapped };
}

function positionallyResolvedKeys(
  alignments: readonly MessageAlignment[],
  owners: KeyOwners,
): ReadonlySet<string> {
  const picked = new Map<string, Set<number>>();
  const outOfOrder = new Set<string>();
  for (const alignment of alignments) {
    for (const { keyId, pick } of alignment.picks) {
      const set = picked.get(keyId);
      if (set === undefined) picked.set(keyId, new Set([pick]));
      else set.add(pick);
    }
    for (const record of alignment.ambiguous) if (record.outOfOrder) outOfOrder.add(record.keyId);
  }
  const resolved = new Set<string>();
  for (const [keyId, picks] of picked) {
    const all = owners.owners.get(keyId) ?? [];
    if (outOfOrder.has(keyId) || picks.size !== all.length) continue;
    if (all.every((index) => picks.has(index))) resolved.add(keyId);
  }
  return resolved;
}

interface KeyOwners {
  readonly projection: readonly ProjectionRef[];
  readonly owners: ReadonlyMap<string, readonly number[]>;
}

function indexKeyOwners(entries: readonly KeyedProjection[]): KeyOwners {
  const owners = new Map<string, number[]>();
  const projection = entries.map((entry, index): ProjectionRef => {
    for (const entryKey of entry.keys) addKeyOwner(owners, entryKey.id, index);
    return {
      entryId: entry.entryId,
      visible: entry.visible,
      keyed: entry.keys.length > 0,
    };
  });
  return { projection, owners };
}

function addKeyOwner(owners: Map<string, number[]>, keyId: string, index: number): void {
  const list = owners.get(keyId);
  if (list === undefined) owners.set(keyId, [index]);
  else if (list.at(-1) !== index) list.push(index);
}

function entryIdsAt(projection: readonly ProjectionRef[], indexes: readonly number[]): string[] {
  return indexes.map((index) => projection[index]?.entryId ?? "");
}

interface KeyedAmbiguity extends AmbiguousKey {
  readonly keyId: string;
}

interface MessageAlignment {
  readonly entryIndexes: number[];
  readonly unmapped: WireKeyRef[];
  readonly ambiguous: KeyedAmbiguity[];
  readonly picks: { readonly keyId: string; readonly pick: number }[];
}

function alignWireMessage(
  message: KeyedWireMessage,
  owners: KeyOwners,
  floor: number,
): MessageAlignment {
  const alignment: MessageAlignment = { entryIndexes: [], unmapped: [], ambiguous: [], picks: [] };
  let localFloor = floor;
  for (const messageKey of message.keys) {
    const candidates = owners.owners.get(messageKey.id) ?? [];
    if (candidates.length === 0) {
      alignment.unmapped.push(messageKey.ref);
      continue;
    }
    const viable = candidates.filter((candidate) => candidate >= localFloor);
    const [pick] = viable;
    if (pick === undefined) {
      alignment.ambiguous.push({
        keyId: messageKey.id,
        key: messageKey.ref,
        candidates: entryIdsAt(owners.projection, candidates),
        outOfOrder: true,
      });
      continue;
    }
    if (viable.length > 1)
      alignment.ambiguous.push({
        keyId: messageKey.id,
        key: messageKey.ref,
        candidates: entryIdsAt(owners.projection, viable),
        outOfOrder: false,
      });
    alignment.picks.push({ keyId: messageKey.id, pick });
    if (!alignment.entryIndexes.includes(pick)) alignment.entryIndexes.push(pick);
    localFloor = pick;
  }
  return alignment;
}

export interface WireCapture {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly sequence: number;
  readonly capturedAt: number;
  readonly provider: string;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly endpoint: string;
  readonly betas: readonly string[];
  readonly status: number;
  readonly bodyText: string;
  readonly body: WireBody;
  readonly mapping: WireMapping | undefined;
}

const KeyRefSchema = obj(
  {
    kind: oneOf(["text", "tool_use", "tool_result", "image", "compaction"]),
    digest: str(),
  },
  { open: true },
);
export const WireMappingSchema = obj(
  {
    projection: arr(obj({ entryId: str(), visible: bool(), keyed: bool() }, { open: true })),
    messages: arr(
      obj(
        {
          index: finiteInt(0),
          role: str(),
          entryIds: arr(str()),
          unmapped: arr(KeyRefSchema),
          ambiguous: arr(
            obj({ key: KeyRefSchema, candidates: arr(str()), outOfOrder: bool() }, { open: true }),
          ),
        },
        { open: true },
      ),
    ),
  },
  { open: true },
);
const WireCaptureSchema = withJsonValueDefs(
  obj(
    {
      schemaVersion: lit(1),
      sessionId: nonEmptyStr(),
      sequence: finiteInt(0),
      capturedAt: nonNegative(),
      provider: nonEmptyStr(),
      modelId: nonEmptyStr(),
      baseUrl: str(),
      endpoint: str(),
      betas: arr(str()),
      status: finiteInt(),
      bodyText: str(),
      body: wireBody,
      mapping: opt(WireMappingSchema),
    },
    { open: true },
  ),
);
const isWireCaptureFields = compile(WireCaptureSchema).check;

export function isWireCapture<T>(value: T): value is T & WireCapture {
  return isWireCaptureFields(value) && hasProperty(value, "mapping");
}

export interface TransportRequest {
  readonly sessionId: string | undefined;
  readonly body: WireBody;
  readonly bodyText: string;
  readonly betas: readonly string[];
}
export type TransportVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string };
type TransportCheck = (request: TransportRequest) => TransportVerdict;
export type TransportResponseObserver = (response: Response) => Promise<void>;

interface TransportCall {
  readonly sessionId: string | undefined;
  readonly checks: TransportCheck[];
  readonly responseObservers: TransportResponseObserver[];
  readonly refusals: string[];
}

interface TransportRefusal {
  readonly sessionId: string | undefined;
  readonly code: string;
  readonly at: number;
}

const RUNTIME_SYMBOL = Symbol.for("choco-pi:anthropic-native-lane");

function runtime(): LaneRuntime<TransportCall, WireCapture, TransportRefusal> {
  return laneRuntime<TransportCall, WireCapture, TransportRefusal>(RUNTIME_SYMBOL, "Anthropic");
}

const MAX_REFUSALS = 64;

export function currentTransportCall(): TransportCall | undefined {
  return runtime().calls.getStore();
}

export function bindSessionProjection(sessionId: string, source: ProjectionSource): () => void {
  const projections = runtime().projections;
  projections.set(sessionId, source);
  return () => {
    if (projections.get(sessionId) === source) projections.delete(sessionId);
  };
}

export function capturesFor(sessionId: string): readonly WireCapture[] {
  return runtime().captures.get(sessionId) ?? [];
}

export function releaseSessionCaptures(sessionId: string): void {
  const state = runtime();
  state.captures.delete(sessionId);
  state.projections.delete(sessionId);
  responseRing().delete(sessionId);
}

export interface RecordedResponse {
  readonly sequence: number;
  readonly status: number;
  readonly capturedAt: number;
  readonly provider: string;
  readonly modelId: string;
  readonly baseUrl: string;
}

const RESPONSES_SYMBOL = Symbol.for("choco-pi:anthropic-native-responses");
const MAX_RESPONSES_PER_SESSION = 8;

function responseRing(): Map<string, RecordedResponse[]> {
  return responseRingSlot<RecordedResponse>(RESPONSES_SYMBOL, "Anthropic");
}

export function recentResponsesFor(sessionId: string): readonly RecordedResponse[] {
  return responseRing().get(sessionId) ?? [];
}

function storeResponse(sessionId: string, response: RecordedResponse): void {
  storeBounded(responseRing(), sessionId, response, MAX_RESPONSES_PER_SESSION);
}

export function transportRefusals(sessionId?: string): readonly TransportRefusal[] {
  const refusals = runtime().refusals;
  return sessionId === undefined
    ? [...refusals]
    : refusals.filter((refusal) => refusal.sessionId === sessionId);
}

export const TRANSPORT_REFUSAL_PREFIX = "choco-pi anthropic native transport refused";
export const OPAQUE_REFUSAL_PREFIX = "choco-pi compaction";
const TRANSPORT_REFUSAL_HEADER = "x-choco-pi-transport-refusal";

export type ProviderStream = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface CapturingProviderOptions {
  readonly delegate?: typeof installedStreamSimple;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly maxCapturesPerSession?: number;
}

function isAnthropicMessagesModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

export function parseBetaHeader(value: string | null): string[] {
  if (value === null) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((beta) => beta.trim())
        .filter((beta) => beta.length > 0),
    ),
  ];
}

export function freezeJson(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
    Object.freeze(value);
  } else if (value instanceof Object) {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
}

function storeCapture(capture: WireCapture, limit: number): void {
  storeBounded(runtime().captures, capture.sessionId, capture, limit);
}

function refuse(call: TransportCall, code: string, now: number, text?: string): Response {
  call.refusals.push(code);
  const refusals = runtime().refusals;
  refusals.push({ sessionId: call.sessionId, code, at: now });
  if (refusals.length > MAX_REFUSALS) refusals.splice(0, refusals.length - MAX_REFUSALS);
  const message = text ?? `${TRANSPORT_REFUSAL_PREFIX}: ${code}`;
  return new Response(
    JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
    {
      status: 400,
      headers: { "content-type": "application/json", [TRANSPORT_REFUSAL_HEADER]: code },
    },
  );
}

const DEFAULT_CAPTURES_PER_SESSION = 4;

export function createCapturingStreamSimple(
  options: CapturingProviderOptions = {},
): ProviderStream {
  const settings: CaptureSettings = {
    delegate: options.delegate ?? installedStreamSimple,
    now: options.now ?? Date.now,
    limit: Math.max(1, options.maxCapturesPerSession ?? DEFAULT_CAPTURES_PER_SESSION),
    fetch: options.fetch,
  };
  return (model, context, streamOptions) =>
    streamWithCapture(settings, model, context, streamOptions);
}

interface CaptureSettings {
  readonly delegate: typeof installedStreamSimple;
  readonly now: () => number;
  readonly limit: number;
  readonly fetch: typeof globalThis.fetch | undefined;
}

interface CaptureCall {
  readonly settings: CaptureSettings;
  readonly model: Model<"anthropic-messages">;
  readonly call: TransportCall;
  readonly base: typeof globalThis.fetch;
}

function streamWithCapture(
  settings: CaptureSettings,
  model: Model<Api>,
  context: TranscriptContext,
  streamOptions: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
  if (!isAnthropicMessagesModel(model)) {
    throw new Error(`Anthropic capture cannot serve api ${model.api}`);
  }
  const call: TransportCall = {
    sessionId: streamOptions?.sessionId,
    checks: [],
    responseObservers: [],
    refusals: [],
  };
  const base = settings.fetch ?? streamOptions?.fetch ?? globalThis.fetch;
  const capture: CaptureCall = { settings, model, call, base };
  const capturingFetch: typeof globalThis.fetch = (input, init) =>
    captureAndForward(capture, input, init);
  return runtime().calls.run(call, () =>
    settings.delegate(model, context, {
      ...streamOptions,
      fetch: capturingFetch,
      disableContinuation: true,
    }),
  );
}

interface ReadRequest {
  readonly bodyText: string | undefined;
  readonly body: WireBody | undefined;
  readonly betas: string[];
}

function readRequest(init: RequestInit | undefined): ReadRequest {
  const bodyText = isString(init?.body) ? init.body : undefined;
  const body = bodyText === undefined ? undefined : parseWireBody(bodyText);
  const betas = parseBetaHeader(new Headers(init?.headers).get("anthropic-beta"));
  return { bodyText, body, betas };
}

function refuseOpaque(capture: CaptureCall): Response | undefined {
  const sessionId = capture.call.sessionId;
  if (sessionId === undefined) return undefined;
  const block = pendingOpaqueBlock(sessionId);
  if (block === undefined) return undefined;
  const text = `${OPAQUE_REFUSAL_PREFIX}: ${OPAQUE_GUARD_NOTICE(opaqueProviderOf(block.owner), block.entryId)}`;
  return refuse(capture.call, "opaque-checkpoint", capture.settings.now(), text);
}

function verifyRequest(capture: CaptureCall, request: ReadRequest): Response | undefined {
  const { call, settings } = capture;
  const opaque = refuseOpaque(capture);
  if (opaque !== undefined) return opaque;
  if (call.checks.length === 0) return undefined;
  const { body, bodyText, betas } = request;
  if (body === undefined || bodyText === undefined)
    return refuse(call, "body-unreadable", settings.now());
  for (const check of call.checks) {
    const verdict = check({ sessionId: call.sessionId, body, bodyText, betas });
    if (!verdict.ok) return refuse(call, verdict.code, settings.now());
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
      : mapWireToEntries(request.body.messages, entries);
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
  const { body, bodyText, betas } = sent.request;
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
      betas,
      status: sent.status,
      bodyText,
      body,
      mapping: sent.mapping,
    },
    settings.limit,
  );
}

export interface NativeProviderLookup {
  getRegisteredNativeProvider(provider: string): Provider | undefined;
}

function capturingNativeProvider(native: Provider, capture: ProviderStream): Provider {
  const wrapper: Provider = {
    get id() {
      return native.id;
    },
    get name() {
      return native.name;
    },
    get auth() {
      return native.auth;
    },
    getModels: () => native.getModels(),
    stream: (model, context, options) => native.stream(model, context, options),
    streamSimple: (model, context, options) =>
      model.api === "anthropic-messages"
        ? capture(model, context, options)
        : native.streamSimple(model, context, options),
  };
  if ("baseUrl" in native) {
    Object.defineProperty(wrapper, "baseUrl", {
      get: () => native.baseUrl,
      enumerable: true,
      configurable: true,
    });
  }
  if ("headers" in native) {
    Object.defineProperty(wrapper, "headers", {
      get: () => native.headers,
      enumerable: true,
      configurable: true,
    });
  }
  if (native.getAllModels !== undefined) wrapper.getAllModels = native.getAllModels.bind(native);
  if (native.refreshModels !== undefined) wrapper.refreshModels = native.refreshModels.bind(native);
  if (native.filterModels !== undefined) wrapper.filterModels = native.filterModels.bind(native);
  if (native.filterAllModels !== undefined) {
    wrapper.filterAllModels = native.filterAllModels.bind(native);
  }
  if (native.fetchDeferred !== undefined) wrapper.fetchDeferred = native.fetchDeferred.bind(native);
  if (native.cancelDeferred !== undefined) {
    wrapper.cancelDeferred = native.cancelDeferred.bind(native);
  }
  if (native.generateImages !== undefined) {
    wrapper.generateImages = native.generateImages.bind(native);
  }
  if (native.classify !== undefined) wrapper.classify = native.classify.bind(native);
  Object.setPrototypeOf(wrapper, native);
  return wrapper;
}

export function registerAnthropicCapture(
  pi: ExtensionAPI,
  provider: string,
  options: CapturingProviderOptions = {},
  registry?: NativeProviderLookup,
): void {
  const capture = createCapturingStreamSimple(options);
  const native = registry?.getRegisteredNativeProvider(provider);
  if (native !== undefined) {
    pi.registerProvider(capturingNativeProvider(native, capture));
    return;
  }
  pi.registerProvider(provider, { api: "anthropic-messages", streamSimple: capture });
}
