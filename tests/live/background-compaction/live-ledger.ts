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
const ErrorBodySchema = Type.Object(
  {
    error: Type.Object(
      { type: Type.String(), message: Type.Optional(Type.String()) },
      { additionalProperties: true },
    ),
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

/** Anthropic SSE usage: message_start counts, overridden by message_delta counts. */
export function usageFromSse(text: string): Usage | undefined {
  const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let seen = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw.startsWith("{")) continue;
    const event: unknown = JSON.parse(raw);
    if (!Value.Check(SseEventSchema, event)) continue;
    applyEvent(usage, event);
    seen = true;
  }
  return seen ? usage : undefined;
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
const UNAVAILABLE_STREAM_ERRORS = new Set(["overloaded_error", "rate_limit_error"]);

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
          ? this.#settle(entry, usageFromSse(text), onUsage)
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
    const parsed: unknown = text.trim().startsWith("{") ? JSON.parse(text) : undefined;
    const error = Value.Check(ErrorBodySchema, parsed) ? parsed.error : undefined;
    if (error && UNAVAILABLE_STREAM_ERRORS.has(error.type)) this.#markUnavailable(error.type);
    this.#recorder.record("live-error", {
      id: entry.id,
      kind: entry.kind,
      status: entry.status ?? null,
      type: error?.type ?? "unparsed",
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
