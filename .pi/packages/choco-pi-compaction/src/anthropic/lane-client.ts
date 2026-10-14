/**
 * Isolated Anthropic on-demand compaction request (the native lane).
 *
 * The lane sends the frozen prefix of an actually transmitted request (the
 * captured wire messages before the cut, unchanged) with the captured
 * envelope (`model`, `system`, `tools`, `thinking`, metadata), the compaction
 * beta and `compaction: {type: "summarize"}`. Only compaction-incompatible
 * top-level parameters are dropped. The request runs through the INSTALLED
 * Anthropic adapter so endpoint, auth and Claude Code identity headers match
 * the foreground; its payload is replaced through the adapter's `onPayload`.
 *
 * The installed adapter drops the `compaction` block and reports
 * "Unhandled stop reason: compaction". That terminal error is the expected
 * adapter outcome here. The block, stop reason and `usage.iterations` are read
 * from the raw provider stream events instead. Nothing here touches the
 * foreground session; every failure is returned as a typed value.
 */
import { type Model, normalizeContext, type ProviderHeaders } from "@earendil-works/pi-ai";
import { stream as installedStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import {
  type BackgroundUsage,
  type FailureReason,
  type JsonValue,
  JsonValueSchema,
} from "../background/contract.ts";
import { type WireBody, WireBlockSchema } from "./capture.ts";
import { COMPACT_BETA, type CompactionBlock, isCompactionBlock } from "./details.ts";

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/** Top-level keys the lane always sets itself or the API rejects with `compaction`. */
const REPLACED_KEYS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "stream",
  "max_tokens",
  "betas",
  "compaction",
  "stop_sequences",
  "context_management",
]);
const ForcedToolChoiceSchema = Type.Object({
  type: Type.Union([Type.Literal("any"), Type.Literal("tool")]),
});
const JsonRecordSchema = Type.Record(Type.String(), JsonValueSchema);

interface LanePayloadOptions {
  /** Betas the captured request was sent with (from its `anthropic-beta` header). */
  readonly betas: readonly string[];
  readonly maxOutputTokens: number;
  /**
   * Summarization prompt replacing the API's own (`compaction.instructions`).
   * Blank text is omitted; callers keep it within MAX_COMPACTION_INSTRUCTIONS.
   */
  readonly instructions?: string;
}

/** Documented upper bound of `compaction.instructions`, in characters. */
export const MAX_COMPACTION_INSTRUCTIONS = 16_384;

/** Character count as the API counts it (code points, not UTF-16 units). */
export function instructionLength(text: string): number {
  return [...text].length;
}

interface LanePayload {
  readonly payload: WireBody;
  /** Betas sent with the compaction request (captured betas plus COMPACT_BETA). */
  readonly betas: readonly string[];
  /** Top-level parameters dropped because the API rejects them on a compaction request. */
  readonly removed: readonly string[];
}

/** Copy of `output_config` without structured-output `format` or task-budget `remaining`. */
function compactionOutputConfig(value: JsonValue, removed: string[]): JsonValue | undefined {
  if (!Value.Check(JsonRecordSchema, value)) return structuredClone(value);
  const result: JsonObject = {};
  for (const [name, item] of Object.entries(value)) {
    if (name === "format") {
      removed.push("output_config.format");
      continue;
    }
    if (name === "task_budget" && Value.Check(JsonRecordSchema, item) && "remaining" in item) {
      removed.push("output_config.task_budget.remaining");
      result[name] = copyWithout(item, "remaining");
      continue;
    }
    result[name] = structuredClone(item);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Mutable JSON object built while copying captured request fields. */
interface JsonObject {
  [key: string]: JsonValue;
}

function copyWithout(record: Readonly<JsonObject>, omitted: string): JsonObject {
  const copy: JsonObject = {};
  for (const [field, value] of Object.entries(record))
    if (field !== omitted) copy[field] = structuredClone(value);
  return copy;
}

/**
 * Build the compaction request from a captured body. `prefixLength` wire
 * messages are copied unchanged; nothing after the cut is included.
 */
export function buildLanePayload(
  body: WireBody,
  prefixLength: number,
  options: LanePayloadOptions,
): LanePayload {
  if (prefixLength < 1 || prefixLength > body.messages.length) {
    throw new RangeError(`prefix length ${prefixLength} outside captured request`);
  }
  const removed: string[] = [];
  const payload: WireBody = {
    model: body.model,
    messages: structuredClone(body.messages.slice(0, prefixLength)),
  };
  for (const [name, value] of Object.entries(body)) {
    if (REPLACED_KEYS.has(name)) {
      if (name === "stop_sequences" || name === "context_management") removed.push(name);
      continue;
    }
    if (name === "tool_choice" && Value.Check(ForcedToolChoiceSchema, value)) {
      removed.push("tool_choice");
      continue;
    }
    if (name === "output_config" && Value.Check(JsonValueSchema, value)) {
      const config = compactionOutputConfig(value, removed);
      if (config !== undefined) payload[name] = config;
      continue;
    }
    if (Value.Check(JsonValueSchema, value)) payload[name] = structuredClone(value);
  }
  payload.max_tokens = options.maxOutputTokens;
  const instructions = options.instructions;
  if (instructions !== undefined && instructions.trim().length > 0) {
    if (instructionLength(instructions) > MAX_COMPACTION_INSTRUCTIONS) {
      throw new RangeError(
        `compaction instructions exceed ${MAX_COMPACTION_INSTRUCTIONS} characters`,
      );
    }
    payload.compaction = { type: "summarize", instructions };
  } else {
    payload.compaction = { type: "summarize" };
  }
  const betas = [...new Set([...options.betas, COMPACT_BETA])];
  payload.betas = [...betas];
  return { payload, betas, removed };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

type LaneFailureCode =
  | "http-429"
  | "http-529"
  | "server-error"
  | "auth"
  | "timeout"
  | "network"
  | "canceled"
  | "malformed"
  | "no-summary"
  | "oversized"
  | "unsupported"
  | "incompatible";

interface LaneAuth {
  readonly apiKey?: string;
  readonly headers?: ProviderHeaders;
  readonly env?: Record<string, string>;
}

export type LaneStream = typeof installedStream;

export interface LaneRequest {
  readonly model: Model<"anthropic-messages">;
  readonly auth: LaneAuth;
  readonly payload: WireBody;
  readonly signal: AbortSignal;
  /** Absolute epoch milliseconds. */
  readonly deadlineMs: number;
  readonly maxResultBytes: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly stream?: LaneStream;
  readonly now?: () => number;
}

interface LaneSuccess {
  readonly ok: true;
  readonly block: CompactionBlock;
  readonly usage: BackgroundUsage;
  /** "unhandled-stop-reason" is the installed adapter's expected outcome for a compaction stop. */
  readonly adapterOutcome: "unhandled-stop-reason" | "done";
  readonly requests: number;
}

export interface LaneFailure {
  readonly ok: false;
  readonly code: LaneFailureCode;
  readonly reason: FailureReason;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  readonly stopReason?: string;
  /** Provider `error.details.error_code` when present (e.g. `compaction_unavailable`). */
  readonly errorCode?: string;
  readonly usage?: BackgroundUsage;
  readonly requests: number;
}

export type LaneResult = LaneSuccess | LaneFailure;

const NullableCount = Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()]));
const UsageCountsSchema = Type.Object({
  input_tokens: NullableCount,
  output_tokens: NullableCount,
  cache_creation_input_tokens: NullableCount,
  cache_read_input_tokens: NullableCount,
});
const IterationSchema = Type.Object({
  type: Type.Optional(Type.String()),
  input_tokens: NullableCount,
  output_tokens: NullableCount,
  cache_creation_input_tokens: NullableCount,
  cache_read_input_tokens: NullableCount,
});
const MessageStartSchema = Type.Object({
  type: Type.Literal("message_start"),
  message: Type.Object({ usage: Type.Optional(UsageCountsSchema) }),
});
const BlockStartSchema = Type.Object({
  type: Type.Literal("content_block_start"),
  index: Type.Integer({ minimum: 0 }),
  content_block: WireBlockSchema,
});
const IndexedEventSchema = Type.Object({
  type: Type.Union([Type.Literal("content_block_delta"), Type.Literal("content_block_stop")]),
  index: Type.Integer({ minimum: 0 }),
});
const MessageDeltaSchema = Type.Object({
  type: Type.Literal("message_delta"),
  delta: Type.Object({ stop_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
  usage: Type.Optional(
    Type.Object({
      input_tokens: NullableCount,
      output_tokens: NullableCount,
      cache_creation_input_tokens: NullableCount,
      cache_read_input_tokens: NullableCount,
      iterations: Type.Optional(Type.Array(IterationSchema)),
    }),
  ),
});
const KnownEventSchema = Type.Object({
  type: Type.Union([
    Type.Literal("message_start"),
    Type.Literal("content_block_start"),
    Type.Literal("content_block_delta"),
    Type.Literal("content_block_stop"),
    Type.Literal("message_delta"),
    Type.Literal("message_stop"),
  ]),
});
const ErrorBodySchema = Type.Object({
  error: Type.Object({
    type: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
    details: Type.Optional(Type.Object({ error_code: Type.Optional(Type.String()) })),
  }),
});

interface UsageCounts {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}

/** Input counts include cache reads/writes: every token the summarizer processed. */
function inputOf(counts: UsageCounts): number {
  return (
    (counts.input_tokens ?? 0) +
    (counts.cache_creation_input_tokens ?? 0) +
    (counts.cache_read_input_tokens ?? 0)
  );
}

interface StreamState {
  compactionBlocks: number;
  block: CompactionBlock | undefined;
  blockIndex: number | undefined;
  blockStopped: boolean;
  otherBlocks: number;
  deltaOnBlock: boolean;
  invalidEvent: boolean;
  stopReason: string | undefined;
  topInput: number;
  topOutput: number;
  iterations: { input: number; output: number }[] | undefined;
  bytes: number;
  oversized: boolean;
}

interface HttpObservation {
  requests: number;
  status: number | undefined;
  retryAfterMs: number | undefined;
  errorType: string | undefined;
  errorCode: string | undefined;
  mentionsBeta: boolean;
}

/** Placeholder transcript; the adapter-built params are replaced through onPayload. */
const LANE_CONTEXT = normalizeContext({
  messages: [{ role: "user", content: "choco-pi anthropic native compaction lane", timestamp: 0 }],
});
const ERROR_BODY_LIMIT = 65_536;

async function readBounded(response: Response, limit: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, limit);
}

function retryAfter(headers: Headers, now: number): number | undefined {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function hasAuth(auth: LaneAuth): boolean {
  if (auth.apiKey !== undefined && auth.apiKey.length > 0) return true;
  return Object.entries(auth.headers ?? {}).some(
    ([name, value]) =>
      ["authorization", "x-api-key"].includes(name.toLowerCase()) &&
      value !== null &&
      value.trim().length > 0,
  );
}

function usageOf(state: StreamState): BackgroundUsage {
  if (state.iterations !== undefined && state.iterations.length > 0) {
    return {
      input: state.iterations.reduce((sum, item) => sum + item.input, 0),
      output: state.iterations.reduce((sum, item) => sum + item.output, 0),
      iterations: state.iterations.map((item) => ({ ...item })),
    };
  }
  return { input: state.topInput, output: state.topOutput };
}

interface FailureInit {
  readonly code: LaneFailureCode;
  readonly reason: FailureReason;
  readonly retryable: boolean;
}

interface FailureExtra {
  readonly stopReason?: string;
  readonly retryAfterMs?: number;
}

/** Optional fields are present with undefined when unknown; billed 200 responses carry usage. */
function failure(
  init: FailureInit,
  http: HttpObservation,
  state: StreamState,
  extra: FailureExtra = {},
): LaneFailure {
  return {
    ok: false,
    code: init.code,
    reason: init.reason,
    retryable: init.retryable,
    requests: http.requests,
    retryAfterMs: extra.retryAfterMs,
    httpStatus: http.status,
    stopReason: extra.stopReason,
    errorCode: http.errorCode,
    usage: http.status === 200 ? usageOf(state) : undefined,
  };
}

function classifyHttp(http: HttpObservation, state: StreamState): LaneFailure {
  const status = http.status ?? 0;
  if (status === 401 || status === 403) {
    return failure({ code: "auth", reason: "auth", retryable: false }, http, state);
  }
  if (status === 429) {
    return failure({ code: "http-429", reason: "429", retryable: true }, http, state, {
      retryAfterMs: http.retryAfterMs,
    });
  }
  if (status === 529) {
    return failure({ code: "http-529", reason: "529", retryable: true }, http, state, {
      retryAfterMs: http.retryAfterMs,
    });
  }
  if (status === 404 || (status === 400 && http.mentionsBeta)) {
    return failure({ code: "unsupported", reason: "unsupported", retryable: false }, http, state);
  }
  if (status === 413) {
    return failure({ code: "oversized", reason: "oversized", retryable: false }, http, state);
  }
  if (status >= 500) {
    return failure({ code: "server-error", reason: "529", retryable: true }, http, state, {
      retryAfterMs: http.retryAfterMs,
    });
  }
  return failure({ code: "incompatible", reason: "incompatible", retryable: false }, http, state);
}

/** 200 responses: success requires stop_reason "compaction" and exactly one intact block. */
function classifyStream(
  http: HttpObservation,
  state: StreamState,
  terminal: { readonly kind: "done" } | { readonly kind: "error"; readonly message: string },
): LaneResult {
  const stopReason = state.stopReason;
  if (stopReason === undefined) {
    return failure({ code: "malformed", reason: "malformed", retryable: true }, http, state);
  }
  if (stopReason !== "compaction") {
    const oversized = stopReason === "max_tokens" || stopReason === "model_context_window_exceeded";
    return failure(
      oversized
        ? { code: "oversized", reason: "oversized", retryable: false }
        : { code: "no-summary", reason: "malformed", retryable: false },
      http,
      state,
      { stopReason },
    );
  }
  const expectedTerminal =
    terminal.kind === "done" || /Unhandled stop reason: compaction/u.test(terminal.message);
  const block = state.block;
  if (
    block === undefined ||
    !expectedTerminal ||
    state.invalidEvent ||
    state.compactionBlocks !== 1 ||
    state.otherBlocks > 0 ||
    state.deltaOnBlock ||
    !state.blockStopped
  ) {
    return failure({ code: "malformed", reason: "malformed", retryable: false }, http, state, {
      stopReason,
    });
  }
  return {
    ok: true,
    block,
    usage: usageOf(state),
    adapterOutcome: terminal.kind === "done" ? "done" : "unhandled-stop-reason",
    requests: http.requests,
  };
}

function collect<T>(state: StreamState, data: T, maxResultBytes: number): void {
  state.bytes += Buffer.byteLength(JSON.stringify(data) ?? "");
  if (state.bytes > maxResultBytes) state.oversized = true;
  if (!Value.Check(KnownEventSchema, data)) return;
  if (Value.Check(MessageStartSchema, data)) {
    const usage = data.message.usage;
    if (usage !== undefined) {
      state.topInput = inputOf(usage);
      state.topOutput = usage.output_tokens ?? 0;
    }
  } else if (Value.Check(BlockStartSchema, data)) {
    const block = data.content_block;
    if (block.type !== "compaction") {
      state.otherBlocks += 1;
      return;
    }
    state.compactionBlocks += 1;
    const copy = structuredClone(block);
    if (isCompactionBlock(copy)) {
      state.block = copy;
      state.blockIndex = data.index;
    } else {
      state.invalidEvent = true;
    }
  } else if (Value.Check(IndexedEventSchema, data)) {
    if (data.index !== state.blockIndex) return;
    if (data.type === "content_block_delta") state.deltaOnBlock = true;
    else state.blockStopped = true;
  } else if (Value.Check(MessageDeltaSchema, data)) {
    if (data.delta.stop_reason !== undefined && data.delta.stop_reason !== null) {
      state.stopReason = data.delta.stop_reason;
    }
    const usage = data.usage;
    if (usage === undefined) return;
    if (usage.input_tokens !== undefined && usage.input_tokens !== null) {
      state.topInput = inputOf(usage);
    }
    if (usage.output_tokens !== undefined && usage.output_tokens !== null) {
      state.topOutput = usage.output_tokens;
    }
    if (usage.iterations !== undefined) {
      state.iterations = usage.iterations.map((iteration) => ({
        input: inputOf(iteration),
        output: iteration.output_tokens ?? 0,
      }));
    }
  } else if (data.type !== "message_stop" && data.type !== "content_block_delta") {
    // A known event type that failed its schema is a malformed provider stream.
    state.invalidEvent = true;
  }
}

type LaneTerminal =
  | { readonly kind: "done" }
  | { readonly kind: "error"; readonly message: string };

const CANCELED: FailureInit = { code: "canceled", reason: "canceled", retryable: false };
const TIMED_OUT: FailureInit = { code: "timeout", reason: "timeout", retryable: true };
const NO_AUTH: FailureInit = { code: "auth", reason: "auth", retryable: false };
const OVERSIZED: FailureInit = { code: "oversized", reason: "oversized", retryable: false };
const NETWORK: FailureInit = { code: "network", reason: "timeout", retryable: true };

function emptyHttpObservation(): HttpObservation {
  return {
    requests: 0,
    status: undefined,
    retryAfterMs: undefined,
    errorType: undefined,
    errorCode: undefined,
    mentionsBeta: false,
  };
}

function emptyStreamState(): StreamState {
  return {
    compactionBlocks: 0,
    block: undefined,
    blockIndex: undefined,
    blockStopped: false,
    otherBlocks: 0,
    deltaOnBlock: false,
    invalidEvent: false,
    stopReason: undefined,
    topInput: 0,
    topOutput: 0,
    iterations: undefined,
    bytes: 0,
    oversized: false,
  };
}

function preflightFailure(request: LaneRequest, now: () => number): FailureInit | undefined {
  if (request.signal.aborted) return CANCELED;
  if (request.deadlineMs <= now()) return TIMED_OUT;
  return hasAuth(request.auth) ? undefined : NO_AUTH;
}

/** Forwards the caller's abort and the absolute deadline into one lane controller. */
class LaneAbortScope {
  readonly controller = new AbortController();
  private expired = false;
  private readonly signal: AbortSignal;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly forwardAbort = (): void => this.controller.abort();

  constructor(signal: AbortSignal, remainingMs: number) {
    this.signal = signal;
    this.signal.addEventListener("abort", this.forwardAbort, { once: true });
    this.timer = setTimeout(() => this.expire(), remainingMs);
  }

  get timedOut(): boolean {
    return this.expired;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.signal.removeEventListener("abort", this.forwardAbort);
  }

  private expire(): void {
    this.expired = true;
    this.controller.abort();
  }
}

/** Provider error body, or undefined when the bounded text is not a recognized error JSON. */
function parseErrorBody(text: string): Static<typeof ErrorBodySchema> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return Value.Check(ErrorBodySchema, parsed) ? parsed : undefined;
}

/** Record status, retry hints, and the bounded provider error body of one HTTP response. */
async function observeResponse(
  http: HttpObservation,
  response: Response,
  now: () => number,
): Promise<void> {
  http.status = response.status;
  http.retryAfterMs = retryAfter(response.headers, now());
  if (response.status < 400) return;
  const parsed = parseErrorBody(await readBounded(response.clone(), ERROR_BODY_LIMIT));
  if (!parsed) return;
  http.errorType = parsed.error.type;
  http.errorCode = parsed.error.details?.error_code;
  http.mentionsBeta = (parsed.error.message ?? "").includes("anthropic-beta");
}

function observingFetch(
  request: LaneRequest,
  http: HttpObservation,
  now: () => number,
): typeof globalThis.fetch {
  const baseFetch = request.fetch ?? globalThis.fetch;
  return async (input, init) => {
    http.requests += 1;
    const response = await baseFetch(input, init);
    await observeResponse(http, response, now);
    return response;
  };
}

interface LaneStreamContext {
  readonly http: HttpObservation;
  readonly state: StreamState;
  readonly controller: AbortController;
  readonly now: () => number;
}

/** Account one raw provider event; abort the lane once the result budget is exceeded. */
function collectStreamEvent<T>(context: LaneStreamContext, data: T, maxResultBytes: number): void {
  collect(context.state, data, maxResultBytes);
  if (context.state.oversized) context.controller.abort();
}

/** Stream through the installed adapter; resolve to its terminal event, never reject. */
async function streamLane(request: LaneRequest, context: LaneStreamContext): Promise<LaneTerminal> {
  const { controller } = context;
  const payload = request.payload;
  let terminal: LaneTerminal = {
    kind: "error",
    message: "lane stream ended without a terminal event",
  };
  try {
    const events = (request.stream ?? installedStream)(request.model, LANE_CONTEXT, {
      apiKey: request.auth.apiKey,
      headers: request.auth.headers,
      env: request.auth.env,
      fetch: observingFetch(request, context.http, context.now),
      signal: controller.signal,
      maxRetries: 0,
      onPayload: () => structuredClone(payload),
      onProviderStreamEvent: (data) => collectStreamEvent(context, data, request.maxResultBytes),
    });
    for await (const event of events) {
      if (event.type === "done") terminal = { kind: "done" };
      else if (event.type === "error")
        terminal = { kind: "error", message: event.error.errorMessage ?? "" };
    }
  } catch (error) {
    terminal = { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  return terminal;
}

function classifyLaneOutcome(
  request: LaneRequest,
  context: {
    readonly http: HttpObservation;
    readonly state: StreamState;
    readonly timedOut: boolean;
  },
  terminal: LaneTerminal,
): LaneResult {
  const { http, state } = context;
  if (request.signal.aborted) return failure(CANCELED, http, state);
  if (context.timedOut) return failure(TIMED_OUT, http, state);
  if (state.oversized) return failure(OVERSIZED, http, state);
  if (http.status === undefined) {
    const missingKey = terminal.kind === "error" && /No API key/u.test(terminal.message);
    return failure(missingKey ? NO_AUTH : NETWORK, http, state);
  }
  if (http.status !== 200) return classifyHttp(http, state);
  return classifyStream(http, state, terminal);
}

/** Run one lane request. Never throws for provider/transport failures. */
export async function runLaneRequest(request: LaneRequest): Promise<LaneResult> {
  const now = request.now ?? Date.now;
  const http = emptyHttpObservation();
  const state = emptyStreamState();
  const refused = preflightFailure(request, now);
  if (refused) return failure(refused, http, state);
  const scope = new LaneAbortScope(request.signal, Math.max(0, request.deadlineMs - now()));
  let terminal: LaneTerminal;
  try {
    terminal = await streamLane(request, { http, state, controller: scope.controller, now });
  } finally {
    scope.dispose();
  }
  return classifyLaneOutcome(request, { http, state, timedOut: scope.timedOut }, terminal);
}
