import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { Recorder } from "./artifacts.ts";
import { RUNAWAY_FACTOR, type Expectation } from "./budget.ts";

export type RequestKind = "foreground" | "summary" | "lane" | "other";

const Count = Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]));
const CountsSchema = Type.Object(
  {
    input_tokens: Count,
    output_tokens: Count,
    cache_read_input_tokens: Count,
    cache_creation_input_tokens: Count,
  },
  { additionalProperties: true },
);
const DeltaUsageSchema = Type.Object(
  { ...CountsSchema.properties, iterations: Type.Optional(Type.Array(CountsSchema)) },
  { additionalProperties: true },
);
const StartSchema = Type.Object(
  {
    type: Type.Literal("message_start"),
    message: Type.Object({ usage: CountsSchema }, { additionalProperties: true }),
  },
  { additionalProperties: true },
);
const DeltaSchema = Type.Object(
  {
    type: Type.Literal("message_delta"),
    delta: Type.Optional(
      Type.Object(
        { stop_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])) },
        { additionalProperties: true },
      ),
    ),
    usage: Type.Optional(DeltaUsageSchema),
  },
  { additionalProperties: true },
);
const StreamErrorSchema = Type.Object(
  {
    type: Type.Literal("error"),
    error: Type.Object({ type: Type.String() }, { additionalProperties: true }),
  },
  { additionalProperties: true },
);
type Counts = Static<typeof CountsSchema>;
const SseEventSchema = Type.Union([StartSchema, DeltaSchema, StreamErrorSchema]);
type SseEvent = Static<typeof SseEventSchema>;
/** Anthropic errors carry `type`; OpenAI-compatible errors carry `type` and/or `code`. */
const ErrorObjectSchema = Type.Object(
  {
    type: Type.Optional(Type.String()),
    code: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
    message: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
const ErrorBodySchema = Type.Object({ error: ErrorObjectSchema }, { additionalProperties: true });

/**
 * OpenAI-compatible chat-completions usage (Synthetic). pi-ai requests it with
 * `stream_options: { include_usage: true }`; it arrives on the final chunk
 * (often with `choices: []`), or on a non-stream JSON body. Cache-read counts
 * sit in `prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens` or a
 * top-level `cached_tokens` depending on the upstream (pi-ai parseChunkUsage).
 */
const OpenAIUsageSchema = Type.Object(
  {
    prompt_tokens: Type.Integer({ minimum: 0 }),
    completion_tokens: Count,
    cached_tokens: Count,
    prompt_cache_hit_tokens: Count,
    prompt_tokens_details: Type.Optional(
      Type.Union([
        Type.Object(
          { cached_tokens: Count, cache_write_tokens: Count },
          { additionalProperties: true },
        ),
        Type.Null(),
      ]),
    ),
  },
  { additionalProperties: true },
);
const OpenAIChoiceSchema = Type.Object(
  { finish_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])) },
  { additionalProperties: true },
);
/** One chat-completions chunk or non-stream body; `usage` is null until the final chunk. */
const OpenAIChunkSchema = Type.Object(
  {
    choices: Type.Optional(Type.Array(OpenAIChoiceSchema)),
    usage: Type.Optional(Type.Union([OpenAIUsageSchema, Type.Null()])),
  },
  { additionalProperties: true },
);
/** Anthropic non-stream message body. */
const AnthropicBodySchema = Type.Object(
  {
    type: Type.Literal("message"),
    usage: CountsSchema,
    stop_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
);
const ERROR_MESSAGE_LIMIT = 300;

/** Real provider-reported usage for one request. */
export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Native compaction iterations, each counted with cache reads/writes. */
  iterations?: { input: number; output: number }[];
  stopReason?: string;
  streamError?: string;
}

function count(value: number | null | undefined): number {
  return value ?? 0;
}

function merge(target: Usage, counts: Counts): void {
  if (counts.input_tokens !== undefined && counts.input_tokens !== null)
    target.input = counts.input_tokens;
  if (counts.output_tokens !== undefined && counts.output_tokens !== null)
    target.output = counts.output_tokens;
  if (counts.cache_read_input_tokens !== undefined && counts.cache_read_input_tokens !== null)
    target.cacheRead = counts.cache_read_input_tokens;
  if (
    counts.cache_creation_input_tokens !== undefined &&
    counts.cache_creation_input_tokens !== null
  )
    target.cacheWrite = counts.cache_creation_input_tokens;
}

function applyEvent(usage: Usage, event: SseEvent): void {
  if (event.type === "message_start") merge(usage, event.message.usage);
  else if (event.type === "message_delta") applyDelta(usage, event);
  else usage.streamError = event.error.type;
}

function applyDelta(usage: Usage, data: Static<typeof DeltaSchema>): void {
  const stop = data.delta?.stop_reason;
  if (stop !== undefined && stop !== null) usage.stopReason = stop;
  if (!data.usage) return;
  merge(usage, data.usage);
  if (!data.usage.iterations) return;
  usage.iterations = data.usage.iterations.map((item) => ({
    input:
      count(item.input_tokens) +
      count(item.cache_read_input_tokens) +
      count(item.cache_creation_input_tokens),
    output: count(item.output_tokens),
  }));
}

function errorCode(error: Static<typeof ErrorObjectSchema>): string {
  if (error.type !== undefined) return error.type;
  if (error.code !== undefined && error.code !== null) return String(error.code);
  return "error";
}

/** Replaces the counts with one OpenAI-compatible usage object (input excludes cache reads/writes). */
function applyOpenAIUsage(usage: Usage, raw: Static<typeof OpenAIUsageSchema>): void {
  const cacheRead =
    raw.prompt_tokens_details?.cached_tokens ??
    raw.prompt_cache_hit_tokens ??
    raw.cached_tokens ??
    0;
  const cacheWrite = raw.prompt_tokens_details?.cache_write_tokens ?? 0;
  usage.input = Math.max(0, raw.prompt_tokens - cacheRead - cacheWrite);
  usage.cacheRead = cacheRead;
  usage.cacheWrite = cacheWrite;
  // completion_tokens already includes reasoning tokens.
  usage.output = raw.completion_tokens ?? 0;
}

/** One parsed wire object: an Anthropic event or message, an OpenAI chunk, or an error. */
type WireObject =
  | { readonly kind: "anthropic-event"; readonly event: SseEvent }
  | { readonly kind: "anthropic-body"; readonly body: Static<typeof AnthropicBodySchema> }
  | { readonly kind: "error"; readonly error: Static<typeof ErrorObjectSchema> }
  | { readonly kind: "openai"; readonly chunk: Static<typeof OpenAIChunkSchema> };

/** Parses one JSON text at the I/O boundary; undefined for malformed or unrecognized input. */
function parseWireObject(text: string): WireObject | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  // First: Anthropic error events/bodies (`type: "error"`) and OpenAI error bodies alike.
  if (Value.Check(ErrorBodySchema, parsed)) return { kind: "error", error: parsed.error };
  if (Value.Check(SseEventSchema, parsed)) return { kind: "anthropic-event", event: parsed };
  if (Value.Check(AnthropicBodySchema, parsed)) return { kind: "anthropic-body", body: parsed };
  if (Value.Check(OpenAIChunkSchema, parsed)) return { kind: "openai", chunk: parsed };
  return undefined;
}

/**
 * Applies one OpenAI-compatible chunk. Returns true only when it carried usage:
 * a stream whose chunks never report usage stays unreported, so the ledger
 * never mistakes a blind stream for a zero-token one.
 */
function applyOpenAIChunk(usage: Usage, chunk: Static<typeof OpenAIChunkSchema>): boolean {
  for (const choice of chunk.choices ?? [])
    if (choice.finish_reason !== undefined && choice.finish_reason !== null)
      usage.stopReason = choice.finish_reason;
  if (chunk.usage === undefined || chunk.usage === null) return false;
  applyOpenAIUsage(usage, chunk.usage);
  return true;
}

/** Applies one wire object; true when it reported usage, an error or an Anthropic event. */
function applyWireObject(usage: Usage, wire: WireObject): boolean {
  switch (wire.kind) {
    case "anthropic-event":
      applyEvent(usage, wire.event);
      return true;
    case "anthropic-body":
      merge(usage, wire.body.usage);
      if (wire.body.stop_reason !== undefined && wire.body.stop_reason !== null)
        usage.stopReason = wire.body.stop_reason;
      return true;
    case "error":
      usage.streamError = errorCode(wire.error);
      return true;
    case "openai":
      return applyOpenAIChunk(usage, wire.chunk);
  }
}

/**
 * Streamed usage from either wire format: Anthropic events (message_start
 * counts, overridden by message_delta counts) or OpenAI-compatible
 * chat-completions chunks (usage on the final chunk). Unparsable lines and
 * `[DONE]` are skipped.
 */
export function usageFromSse(text: string): Usage | undefined {
  const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let seen = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw.startsWith("{")) continue;
    const wire = parseWireObject(raw);
    if (wire !== undefined && wire.kind !== "anthropic-body" && applyWireObject(usage, wire))
      seen = true;
  }
  return seen ? usage : undefined;
}

/** Usage from a response body: SSE (either format) or a non-stream JSON message/completion. */
export function usageFromBody(text: string): Usage | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return usageFromSse(text);
  const wire = parseWireObject(trimmed);
  const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  return wire !== undefined && applyWireObject(usage, wire) ? usage : undefined;
}

/** Every token the provider processed: iterations when reported, else top-level counts. */
export function billedInput(usage: Usage): number {
  if (usage.iterations?.length) return usage.iterations.reduce((sum, item) => sum + item.input, 0);
  return usage.input + usage.cacheRead + usage.cacheWrite;
}
export function billedOutput(usage: Usage): number {
  if (usage.iterations?.length) return usage.iterations.reduce((sum, item) => sum + item.output, 0);
  return usage.output;
}

interface LedgerEntry {
  readonly id: number;
  readonly kind: RequestKind;
  readonly estimate: number;
  status?: number;
  usage?: Usage;
}

const UNAVAILABLE_STATUS = new Set([429, 529]);
const UNAVAILABLE_STREAM_ERRORS = new Set([
  "overloaded_error",
  "rate_limit_error",
  // OpenAI-compatible spelling.
  "rate_limit_exceeded",
]);

/**
 * Per-request real-usage ledger with the runaway safety stop. Not a tuning cap:
 * it refuses only past RUNAWAY_FACTOR x the expected usage, or after the
 * provider reported unavailability (no paid retry loops).
 */
export class LiveLedger {
  readonly #entries: LedgerEntry[] = [];
  readonly #pending = new Set<Promise<void>>();
  readonly #recorder: Recorder;
  readonly #limit: Expectation;
  unavailable: string | undefined;
  constructor(recorder: Recorder, expected: Expectation) {
    this.#recorder = recorder;
    this.#limit = {
      requests: expected.requests * RUNAWAY_FACTOR,
      inputTokens: expected.inputTokens * RUNAWAY_FACTOR,
      outputTokens: expected.outputTokens * RUNAWAY_FACTOR,
    };
  }
  /** Reserve before send; throws on runaway or after provider unavailability. */
  reserve(kind: RequestKind, estimate: number): number {
    if (this.unavailable !== undefined)
      throw new Error(`provider-unavailable (${this.unavailable}); no retry`);
    const totals = this.totals();
    if (
      totals.requests + 1 > this.#limit.requests ||
      totals.input + estimate > this.#limit.inputTokens
    )
      throw new Error("runaway-guard: request refused past 10x expected usage");
    if (totals.output > this.#limit.outputTokens)
      throw new Error("runaway-guard: output past 10x expected usage");
    const id = this.#entries.length;
    this.#entries.push({ id, kind, estimate });
    return id;
  }
  /** Reads usage from a clone of the response stream without delaying the caller. */
  observe(id: number, response: Response, onUsage?: (usage: Usage) => void): void {
    const entry = this.#entries[id];
    if (!entry) throw new Error("Unknown ledger entry");
    entry.status = response.status;
    this.#recorder.record("live-response", { id, kind: entry.kind, status: response.status });
    if (UNAVAILABLE_STATUS.has(response.status)) this.#markUnavailable(`http-${response.status}`);
    const task = response
      .clone()
      .text()
      .then((text) =>
        response.ok
          ? this.#settle(entry, usageFromBody(text), onUsage)
          : this.#rejected(entry, text),
      )
      .catch(() => {
        this.#recorder.record("live-usage-unreadable", { id });
      });
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
  }
  async drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled(this.#pending);
  }
  totals() {
    let input = 0;
    let output = 0;
    for (const entry of this.#entries) {
      input += entry.usage ? billedInput(entry.usage) : entry.estimate;
      output += entry.usage ? billedOutput(entry.usage) : 0;
    }
    return { requests: this.#entries.length, input, output };
  }
  /** Real usage only; requests without reported usage are listed, not estimated. */
  report() {
    const requests = this.#entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      status: entry.status ?? null,
      input: entry.usage ? billedInput(entry.usage) : null,
      output: entry.usage ? billedOutput(entry.usage) : null,
      cacheRead: entry.usage?.cacheRead ?? null,
      cacheWrite: entry.usage?.cacheWrite ?? null,
    }));
    const reported = requests.filter((item) => item.input !== null);
    return {
      requests: requests.length,
      inputTokens: reported.reduce((sum, item) => sum + (item.input ?? 0), 0),
      outputTokens: reported.reduce((sum, item) => sum + (item.output ?? 0), 0),
      unreported: requests.length - reported.length,
      unavailable: this.unavailable ?? null,
      perRequest: requests,
    };
  }
  #markUnavailable(reason: string): void {
    this.unavailable ??= reason;
    this.#recorder.record("provider-unavailable", { reason });
  }
  /** Provider error bodies carry no credential; type and a bounded message are recorded. */
  #rejected(entry: LedgerEntry, text: string): void {
    const wire = text.trim().startsWith("{") ? parseWireObject(text) : undefined;
    const error = wire?.kind === "error" ? wire.error : undefined;
    const type = error === undefined ? "unparsed" : errorCode(error);
    if (UNAVAILABLE_STREAM_ERRORS.has(type)) this.#markUnavailable(type);
    this.#recorder.record("live-error", {
      id: entry.id,
      kind: entry.kind,
      status: entry.status ?? null,
      type,
      message: (error?.message ?? "").slice(0, ERROR_MESSAGE_LIMIT),
    });
  }
  #settle(entry: LedgerEntry, usage: Usage | undefined, onUsage?: (usage: Usage) => void): void {
    if (!usage) return;
    entry.usage = usage;
    if (usage.streamError && UNAVAILABLE_STREAM_ERRORS.has(usage.streamError))
      this.#markUnavailable(usage.streamError);
    this.#recorder.record("live-usage", {
      id: entry.id,
      kind: entry.kind,
      status: entry.status ?? null,
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      output: usage.output,
      billedInput: billedInput(usage),
      billedOutput: billedOutput(usage),
      estimate: entry.estimate,
      stopReason: usage.stopReason ?? null,
    });
    onUsage?.(usage);
  }
}
