/**
 * Wire-faithful transport capture for the Anthropic native lane.
 *
 * A provider registered through the public `registerProvider` `streamSimple`
 * hook delegates to the INSTALLED Anthropic adapter and passes a capturing
 * `fetch`. That fetch sees the serialized body after every
 * `before_provider_request` handler, so it is the only trustworthy view of
 * what is sent (a handler-level observer can be overridden by a later handler).
 *
 * Each captured request is mapped to branch entry IDs by aligning wire content
 * keys (text, tool_use id, tool_result id, image data, compaction signature)
 * with the session projection at request time. Keys no entry produced are
 * reported as unmapped and keys several entries could own are reported as
 * ambiguous; neither is silently attributed. Captures hold the request body
 * (conversation content, never credentials): only the `anthropic-beta` header
 * and the endpoint without its query are kept from the request envelope.
 *
 * Transport checks registered for the current provider call (replay
 * verification) run before the request leaves the process; a failed check
 * refuses the request (fail closed) and records a reason code.
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
import { streamSimple as installedStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  convertToLlm,
  type ExtensionAPI,
  type ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { JsonValueSchema, type JsonValue } from "../background/contract.ts";
import { OPAQUE_GUARD_NOTICE, opaqueProviderOf } from "../opaque-checkpoint.ts";
import { pendingOpaqueBlock } from "../opaque-guard.ts";
import { isAnthropicDetails, sha256 } from "./details.ts";

// ---------------------------------------------------------------------------
// Wire model
// ---------------------------------------------------------------------------

const JsonRecordSchema = Type.Record(Type.String(), JsonValueSchema);
/** Wire objects keep every provider field as JSON; only the named fields are required. */
export const WireBlockSchema = Type.Intersect([
  Type.Object({ type: Type.String() }),
  JsonRecordSchema,
]);
const WireMessageSchema = Type.Intersect([
  Type.Object({
    role: Type.String(),
    content: Type.Union([Type.String(), Type.Array(WireBlockSchema)]),
  }),
  JsonRecordSchema,
]);
export const WireBodySchema = Type.Intersect([
  Type.Object({
    model: Type.String({ minLength: 1 }),
    messages: Type.Array(WireMessageSchema),
  }),
  JsonRecordSchema,
]);
export type WireBlock = Static<typeof WireBlockSchema>;
export type WireMessage = Static<typeof WireMessageSchema>;
export type WireBody = Static<typeof WireBodySchema>;

const TextBlockSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const ImageBlockSchema = Type.Object({
  type: Type.Literal("image"),
  source: Type.Object({ data: Type.String() }),
});
const ToolUseBlockSchema = Type.Object({ type: Type.Literal("tool_use"), id: Type.String() });
const ToolResultBlockSchema = Type.Object({
  type: Type.Literal("tool_result"),
  tool_use_id: Type.String(),
});
const SignedBlockSchema = Type.Object({
  type: Type.Literal("compaction"),
  signature: Type.String(),
});
const ThinkingBlockSchema = Type.Object({
  type: Type.Union([Type.Literal("thinking"), Type.Literal("redacted_thinking")]),
});
const StringSchema = Type.String();

export function parseWireBody(text: string): WireBody | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return Value.Check(WireBodySchema, parsed) ? parsed : undefined;
}

export function wireBlocks(message: WireMessage): readonly WireBlock[] {
  return Array.isArray(message.content) ? message.content : [];
}

export function toolUseIds(message: WireMessage): string[] {
  return wireBlocks(message).flatMap((block) =>
    Value.Check(ToolUseBlockSchema, block) ? [block.id] : [],
  );
}

export function toolResultIds(message: WireMessage): string[] {
  return wireBlocks(message).flatMap((block) =>
    Value.Check(ToolResultBlockSchema, block) ? [block.tool_use_id] : [],
  );
}

export function hasThinking(message: WireMessage): boolean {
  return wireBlocks(message).some((block) => Value.Check(ThinkingBlockSchema, block));
}

const DeferredToolSchema = Type.Object({ defer_loading: Type.Literal(true) });

interface BindingDigests {
  readonly systemDigest: string;
  readonly toolsDigest: string;
}

/**
 * Digests of the inputs preserved thinking is bound to: `system` and the tools
 * not marked `defer_loading: true` (compaction-thinking-blocks doc).
 */
export function bindingDigests(body: WireBody): BindingDigests {
  const tools = Array.isArray(body.tools)
    ? body.tools.filter((tool) => !Value.Check(DeferredToolSchema, tool))
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

// ---------------------------------------------------------------------------
// Key alignment (wire message <-> projected entry)
// ---------------------------------------------------------------------------

export type WireKeyKind = "text" | "tool_use" | "tool_result" | "image" | "compaction";
/** Non-secret reference to a wire key: kind plus digest prefix, never raw content. */
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

/** The installed adapter's tool-call ID normalization (Anthropic ID pattern and length). */
function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64);
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/** Keys of one transport message. Thinking and system content are deliberately unkeyed. */
function wireMessageKeys(message: WireMessage): WireKey[] {
  if (message.role === "system") return [];
  if (!Array.isArray(message.content)) {
    return isBlank(message.content) ? [] : [key("text", message.content)];
  }
  return message.content.flatMap((block): WireKey[] => {
    if (Value.Check(TextBlockSchema, block))
      return isBlank(block.text) ? [] : [key("text", block.text)];
    if (Value.Check(ToolUseBlockSchema, block)) return [key("tool_use", block.id)];
    if (Value.Check(ToolResultBlockSchema, block)) return [key("tool_result", block.tool_use_id)];
    if (Value.Check(ImageBlockSchema, block)) return [key("image", block.source.data)];
    if (Value.Check(SignedBlockSchema, block)) return [key("compaction", block.signature)];
    return [];
  });
}

/** Keys the installed adapter derives from one model-visible message. */
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
  // Only the newest compaction is projected with messages (and sent as a block);
  // an older one retained in the kept range is invisible and absent from the wire.
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
  /** The entry contributes at least one model-visible message. */
  readonly visible: boolean;
  /** At least one of its messages produces an alignment key. */
  readonly keyed: boolean;
}

interface AmbiguousKey {
  readonly key: WireKeyRef;
  /** Entries that could own the key at this position; empty owner order means out of order. */
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

/** One transport message (or item) reduced to its role and alignment keys. */
export interface KeyedWireMessage {
  readonly role: string;
  readonly keys: readonly WireKey[];
  /**
   * This wire message continues the previous one's source turn (Responses
   * input splits one assistant turn into reasoning, message and call items),
   * so it may map to the same projected entry instead of a strictly later one.
   */
  readonly continuesPrevious?: boolean;
}

/** One projected entry reduced to its identity, visibility and alignment keys. */
export interface KeyedProjection {
  readonly entryId: string;
  readonly visible: boolean;
  readonly keys: readonly WireKey[];
}

/**
 * Order-preserving alignment. Each keyed wire message is owned by projected
 * entries after the previous message's owners; within a message, owners never
 * move backwards. A key with several viable owners takes the earliest one.
 *
 * Repeated identical content (for example a persona message appended every
 * turn) resolves by position: when the wire messages carrying a key claim
 * every projected owner of that key exactly once, the monotone assignment of
 * two equally long ordered sequences is unique, so those choices are not
 * ambiguous. Any other multi-owner choice (an owner left unclaimed, so the
 * wire could have skipped a different one) stays reported, and a key with no
 * owner at or after the floor stays out of order.
 */
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

/** {@link mapWireToEntries} over pre-keyed wire messages and projected entries (any wire format). */
export function alignKeyedWire(
  messages: readonly KeyedWireMessage[],
  entries: readonly KeyedProjection[],
): WireMapping {
  const owners = indexKeyOwners(entries);
  let floor = 0;
  // Floor at the start of the current run of continuing messages.
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

/**
 * Keys whose every projected owner was claimed, in order, by the wire. Picks
 * of distinct messages strictly increase (the floor moves past each message's
 * owners), so claiming all owners means a bijection between the key's wire
 * occurrences and its owners. A key that also went out of order is excluded.
 */
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

/** Projection refs plus, per wire key, the ascending projection indexes that produce it. */
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

/** An ambiguity record plus the internal key it belongs to. */
interface KeyedAmbiguity extends AmbiguousKey {
  readonly keyId: string;
}

interface MessageAlignment {
  readonly entryIndexes: number[];
  readonly unmapped: WireKeyRef[];
  readonly ambiguous: KeyedAmbiguity[];
  /** Owner chosen for each placed key occurrence. */
  readonly picks: { readonly keyId: string; readonly pick: number }[];
}

/** Align one wire message's keys to owners at or after `floor`, never moving backwards. */
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

// ---------------------------------------------------------------------------
// Captures and the per-call transport context
// ---------------------------------------------------------------------------

export interface WireCapture {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly sequence: number;
  readonly capturedAt: number;
  readonly provider: string;
  readonly modelId: string;
  readonly baseUrl: string;
  /** Request URL origin and path; the query is dropped. */
  readonly endpoint: string;
  readonly betas: readonly string[];
  /** HTTP status of the response to this exact request. */
  readonly status: number;
  readonly bodyText: string;
  /** Deep-frozen parse of bodyText. */
  readonly body: WireBody;
  /** Undefined when no projection source was bound for the session. */
  readonly mapping: WireMapping | undefined;
}

const KeyRefSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("text"),
    Type.Literal("tool_use"),
    Type.Literal("tool_result"),
    Type.Literal("image"),
    Type.Literal("compaction"),
  ]),
  digest: Type.String(),
});
export const WireMappingSchema = Type.Object({
  projection: Type.Array(
    Type.Object({ entryId: Type.String(), visible: Type.Boolean(), keyed: Type.Boolean() }),
  ),
  messages: Type.Array(
    Type.Object({
      index: Type.Integer({ minimum: 0 }),
      role: Type.String(),
      entryIds: Type.Array(Type.String()),
      unmapped: Type.Array(KeyRefSchema),
      ambiguous: Type.Array(
        Type.Object({
          key: KeyRefSchema,
          candidates: Type.Array(Type.String()),
          outOfOrder: Type.Boolean(),
        }),
      ),
    }),
  ),
});
const WireCaptureSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  sessionId: Type.String({ minLength: 1 }),
  sequence: Type.Integer({ minimum: 0 }),
  capturedAt: Type.Number({ minimum: 0 }),
  provider: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
  baseUrl: Type.String(),
  endpoint: Type.String(),
  betas: Type.Array(Type.String()),
  status: Type.Integer(),
  bodyText: Type.String(),
  body: WireBodySchema,
  mapping: Type.Union([WireMappingSchema, Type.Undefined()]),
});

/** Narrow an opaque `FrozenSnapshot.backendCapture` produced by this module. */
export function isWireCapture<T>(value: T): value is T & WireCapture {
  return Value.Check(WireCaptureSchema, value);
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
/**
 * Observes the provider's response to a transmitted request before the
 * adapter reads it. Observers must read a clone and must not throw.
 */
export type TransportResponseObserver = (response: Response) => Promise<void>;

/** Per provider-call context, visible to before_provider_request handlers of that call. */
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

type ProjectionSource = () => readonly ProjectedSessionEntry[];

interface LaneRuntime {
  readonly schemaVersion: 1;
  readonly calls: AsyncLocalStorage<TransportCall>;
  readonly captures: Map<string, WireCapture[]>;
  readonly projections: Map<string, ProjectionSource>;
  readonly refusals: TransportRefusal[];
  readonly counter: { value: number };
}

const RUNTIME_SYMBOL = Symbol.for("choco-pi:anthropic-native-lane");
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
    if (!isRuntime(found)) throw new Error("Invalid Anthropic native lane runtime slot");
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

/** The transport call a before_provider_request handler is running for, if any. */
export function currentTransportCall(): TransportCall | undefined {
  return runtime().calls.getStore();
}

/**
 * Bind the projection the capture maps against (the host binds it at session start:
 * `() => ctx.sessionManager.buildSessionProjection().entries`). Returns an
 * unbind that only removes this exact source.
 */
export function bindSessionProjection(sessionId: string, source: ProjectionSource): () => void {
  const projections = runtime().projections;
  projections.set(sessionId, source);
  return () => {
    if (projections.get(sessionId) === source) projections.delete(sessionId);
  };
}

/** Captures for a session, oldest first. */
export function capturesFor(sessionId: string): readonly WireCapture[] {
  return runtime().captures.get(sessionId) ?? [];
}

export function releaseSessionCaptures(sessionId: string): void {
  const state = runtime();
  state.captures.delete(sessionId);
  state.projections.delete(sessionId);
  responseRing().delete(sessionId);
}

// ---------------------------------------------------------------------------
// Responses that left no usable capture (diagnostics only)
// ---------------------------------------------------------------------------

/** A transmitted session request whose response was not HTTP 200 or whose body could not be mapped. */
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

/**
 * Process-wide ring of unusable responses per session, kept apart from the
 * capture ring so a host retry burst (non-200 answers) never evicts the last
 * usable capture. Its own slot, so the capture runtime's shape is unchanged.
 */
function responseRing(): Map<string, RecordedResponse[]> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, RESPONSES_SYMBOL);
  const found: unknown = descriptor?.value;
  if (found instanceof Map) return found;
  if (descriptor !== undefined) throw new Error("Invalid Anthropic native response ring slot");
  const created = new Map<string, RecordedResponse[]>();
  Object.defineProperty(globalThis, RESPONSES_SYMBOL, { value: created, configurable: true });
  return created;
}

/** Unusable responses of a session, oldest first (at most 8). */
export function recentResponsesFor(sessionId: string): readonly RecordedResponse[] {
  return responseRing().get(sessionId) ?? [];
}

function storeResponse(sessionId: string, response: RecordedResponse): void {
  const ring = responseRing();
  const list = ring.get(sessionId) ?? [];
  ring.delete(sessionId);
  ring.set(sessionId, [...list, response].slice(-MAX_RESPONSES_PER_SESSION));
  while (ring.size > MAX_SESSIONS) {
    const oldest = ring.keys().next();
    if (oldest.done === true) break;
    ring.delete(oldest.value);
  }
}

export function transportRefusals(sessionId?: string): readonly TransportRefusal[] {
  const refusals = runtime().refusals;
  return sessionId === undefined
    ? [...refusals]
    : refusals.filter((refusal) => refusal.sessionId === sessionId);
}

export const TRANSPORT_REFUSAL_PREFIX = "choco-pi anthropic native transport refused";
/** Prefix of the local answer to a request refused by the opaque-history guard. */
export const OPAQUE_REFUSAL_PREFIX = "choco-pi compaction";
/** Marks a locally answered (never transmitted) refusal response. */
const TRANSPORT_REFUSAL_HEADER = "x-choco-pi-transport-refusal";

export type ProviderStream = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface CapturingProviderOptions {
  /** Defaults to the installed Anthropic adapter's streamSimple. */
  readonly delegate?: typeof installedStreamSimple;
  /** Base transport; defaults to the host-provided fetch, then globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly maxCapturesPerSession?: number;
}

function isAnthropicMessagesModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
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

function storeCapture(capture: WireCapture, limit: number): void {
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

/**
 * A refused request is answered locally and never transmitted. The answer is a
 * non-retryable 400 whose message carries the reason code, so the foreground
 * turn fails visibly instead of looping through transport-error retries.
 */
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

/**
 * Provider `streamSimple` that runs the installed adapter with a capturing,
 * verifying fetch. Captures are keyed by the host's `options.sessionId`;
 * requests without a session ID (host summaries, other lanes) are verified but
 * not captured.
 */
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

/** One provider call: its model, transport call context, and base transport. */
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
    settings.delegate(model, context, { ...streamOptions, fetch: capturingFetch }),
  );
}

interface ReadRequest {
  readonly bodyText: string | undefined;
  readonly body: WireBody | undefined;
  readonly betas: string[];
}

function readRequest(init: RequestInit | undefined): ReadRequest {
  const bodyText = Value.Check(StringSchema, init?.body) ? init.body : undefined;
  const body = bodyText === undefined ? undefined : parseWireBody(bodyText);
  const betas = parseBetaHeader(new Headers(init?.headers).get("anthropic-beta"));
  return { bodyText, body, betas };
}

/**
 * Refuse a session request while the session's newest checkpoint is an
 * opaque record this request cannot carry (D2): sending it would give the
 * model placeholder-only context. The xAI replay handler sets the block (and
 * already notified and journaled it); the request is answered locally here,
 * because a `before_provider_request` handler cannot stop a request.
 */
function refuseOpaque(capture: CaptureCall): Response | undefined {
  const sessionId = capture.call.sessionId;
  if (sessionId === undefined) return undefined;
  const block = pendingOpaqueBlock(sessionId);
  if (block === undefined) return undefined;
  const text = `${OPAQUE_REFUSAL_PREFIX}: ${OPAQUE_GUARD_NOTICE(opaqueProviderOf(block.owner), block.entryId)}`;
  return refuse(capture.call, "opaque-checkpoint", capture.settings.now(), text);
}

/** Run every registered transport check; returns the local refusal when one fails. */
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
  // Map against the branch as it is when this request is sent.
  const entries = projectionFor(capture.call.sessionId);
  const mapping =
    request.body === undefined || entries === undefined
      ? undefined
      : mapWireToEntries(request.body.messages, entries);
  const response = await capture.base(input, init);
  recordCapture(capture, { url, request, mapping, status: response.status });
  for (const observe of capture.call.responseObservers) await observe(response);
  return response;
}

/**
 * Store the sent body for a session-bound call; calls without a session ID are
 * not captured. Only an HTTP 200 answer to a mapped body is a usable capture;
 * any other response goes to the diagnostics ring, so the host's retries of a
 * failing request never evict the last usable capture (D8).
 */
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

/**
 * Override `provider`'s Anthropic stream with the capturing wrapper (keeps the
 * provider's models and auth). Register for every provider the capability
 * allow-list admits.
 */
export function registerAnthropicCapture(
  pi: ExtensionAPI,
  provider: string,
  options: CapturingProviderOptions = {},
): void {
  pi.registerProvider(provider, {
    api: "anthropic-messages",
    streamSimple: createCapturingStreamSimple(options),
  });
}
