import {
  arr,
  int,
  lit,
  nul,
  nullable,
  num,
  obj,
  opt,
  str,
  union,
  type Static,
} from "@earendil-works/pi-schema";
import { matches } from "./schema-check.ts";
import type { Recorder } from "./artifacts.ts";
import { RUNAWAY_FACTOR, type Expectation } from "./budget.ts";

export type RequestKind = "foreground" | "summary" | "lane" | "other";

const Count = opt(nullable(int({ minimum: 0 })));
const countProperties = {
  input_tokens: Count,
  output_tokens: Count,
  cache_read_input_tokens: Count,
  cache_creation_input_tokens: Count,
};
const CountsSchema = obj(countProperties, { open: true });
const DeltaUsageSchema = obj(
  { ...countProperties, iterations: opt(arr(CountsSchema)) },
  { open: true },
);
const StartSchema = obj(
  {
    type: lit("message_start"),
    message: obj({ usage: CountsSchema }, { open: true }),
  },
  { open: true },
);
const DeltaSchema = obj(
  {
    type: lit("message_delta"),
    delta: opt(obj({ stop_reason: opt(nullable(str())) }, { open: true })),
    usage: opt(DeltaUsageSchema),
  },
  { open: true },
);
const StreamErrorSchema = obj(
  {
    type: lit("error"),
    error: obj({ type: str() }, { open: true }),
  },
  { open: true },
);
type Counts = Static<typeof CountsSchema>;
const SseEventSchema = union([StartSchema, DeltaSchema, StreamErrorSchema]);
type SseEvent = Static<typeof SseEventSchema>;
const ErrorObjectSchema = obj(
  {
    type: opt(str()),
    code: opt(union([str(), num(), nul()])),
    message: opt(str()),
  },
  { open: true },
);
const ErrorBodySchema = obj({ error: ErrorObjectSchema }, { open: true });

const OpenAIUsageSchema = obj(
  {
    prompt_tokens: int({ minimum: 0 }),
    completion_tokens: Count,
    cached_tokens: Count,
    prompt_cache_hit_tokens: Count,
    prompt_tokens_details: opt(
      nullable(obj({ cached_tokens: Count, cache_write_tokens: Count }, { open: true })),
    ),
  },
  { open: true },
);
const OpenAIChoiceSchema = obj({ finish_reason: opt(nullable(str())) }, { open: true });
const OpenAIChunkSchema = obj(
  {
    choices: opt(arr(OpenAIChoiceSchema)),
    usage: opt(nullable(OpenAIUsageSchema)),
  },
  { open: true },
);
const AnthropicBodySchema = obj(
  {
    type: lit("message"),
    usage: CountsSchema,
    stop_reason: opt(nullable(str())),
  },
  { open: true },
);
const ERROR_MESSAGE_LIMIT = 300;

export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
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
  usage.output = raw.completion_tokens ?? 0;
}

type WireObject =
  | { readonly kind: "anthropic-event"; readonly event: SseEvent }
  | { readonly kind: "anthropic-body"; readonly body: Static<typeof AnthropicBodySchema> }
  | { readonly kind: "error"; readonly error: Static<typeof ErrorObjectSchema> }
  | { readonly kind: "openai"; readonly chunk: Static<typeof OpenAIChunkSchema> };

function parseWireObject(text: string): WireObject | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (matches(ErrorBodySchema, parsed)) return { kind: "error", error: parsed.error };
  if (matches(SseEventSchema, parsed)) return { kind: "anthropic-event", event: parsed };
  if (matches(AnthropicBodySchema, parsed)) return { kind: "anthropic-body", body: parsed };
  if (matches(OpenAIChunkSchema, parsed)) return { kind: "openai", chunk: parsed };
  return undefined;
}

function applyOpenAIChunk(usage: Usage, chunk: Static<typeof OpenAIChunkSchema>): boolean {
  for (const choice of chunk.choices ?? [])
    if (choice.finish_reason !== undefined && choice.finish_reason !== null)
      usage.stopReason = choice.finish_reason;
  if (chunk.usage === undefined || chunk.usage === null) return false;
  applyOpenAIUsage(usage, chunk.usage);
  return true;
}

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

export function usageFromBody(text: string): Usage | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return usageFromSse(text);
  const wire = parseWireObject(trimmed);
  const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  return wire !== undefined && applyWireObject(usage, wire) ? usage : undefined;
}

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
  "rate_limit_exceeded",
]);

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
