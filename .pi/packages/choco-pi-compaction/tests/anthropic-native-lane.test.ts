/**
 * Anthropic native isolated lane request (INSTALLED Anthropic adapter, fake
 * fetch, no network).
 *
 * The lane must send exactly the frozen prefix with the compaction beta and
 * trigger, read the block from raw provider stream events even though the
 * adapter drops it and errors on `stop_reason: "compaction"`, count
 * `usage.iterations`, and turn every failure into a typed value.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject, Model } from "@earendil-works/pi-ai";

import { parseBetaHeader, parseWireBody, type WireBody } from "../src/anthropic/capture.ts";
import { COMPACT_BETA, isCompactionBlock, sameBlock } from "../src/anthropic/details.ts";
import {
  buildLanePayload,
  type LaneFailure,
  type LaneRequest,
  type LaneResult,
  runLaneRequest,
} from "../src/anthropic/lane-client.ts";

const MODEL: Model<"anthropic-messages"> = {
  id: "claude-haiku-5-5",
  name: "Synthetic Haiku",
  api: "anthropic-messages",
  provider: "native-lane",
  baseUrl: "https://native.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4_096,
};
const API_KEY = "native-non-secret-placeholder-key";
/** Synthetic signed block with an unknown field; the signature is a placeholder. */
const BLOCK = {
  type: "compaction",
  content: "NATIVE synthetic prefix facts",
  signature: "native-synthetic-signature-placeholder",
  tool_changes: { added: ["step"] },
};

type Frame = JsonObject & { readonly type: string };

/** Every key path in insertion order, so added or reordered fields are visible. */
function keyPaths<T>(value: T, prefix = ""): string[] {
  if (!(value instanceof Object)) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    `${prefix}${key}`,
    ...keyPaths(child, `${prefix}${key}.`),
  ]);
}

function sse(frames: readonly Frame[]): Response {
  const body = frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  return new Response(body.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function start(): Frame {
  return {
    type: "message_start",
    message: {
      id: "native-compact",
      type: "message",
      role: "assistant",
      model: MODEL.id,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}

const ITERATIONS = [
  { type: "compaction", input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
];

function compactionFrames(
  options: {
    readonly blocks?: readonly JsonObject[];
    readonly stopReason?: string;
    readonly deltaOnBlock?: boolean;
  } = {},
): Frame[] {
  const blocks = options.blocks ?? [BLOCK];
  const frames: Frame[] = [start(), { type: "ping" }];
  blocks.forEach((block, index) => {
    frames.push({ type: "content_block_start", index, content_block: block });
    if (options.deltaOnBlock === true) {
      frames.push({
        type: "content_block_delta",
        index,
        delta: { type: "compaction_delta", content: "more" },
      });
    }
    frames.push({ type: "content_block_stop", index });
  });
  frames.push({
    type: "message_delta",
    delta: { stop_reason: options.stopReason ?? "compaction", stop_sequence: null },
    usage: { input_tokens: 0, output_tokens: 0, iterations: ITERATIONS },
  });
  frames.push({ type: "message_stop" });
  return frames;
}

function errorResponse(
  status: number,
  error: JsonObject,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ type: "error", error }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Captured-style body: five messages, compaction-rejected parameters present. */
function capturedBody(): WireBody {
  const body = parseWireBody(
    JSON.stringify({
      model: MODEL.id,
      max_tokens: 1,
      stream: true,
      system: [{ type: "text", text: "NATIVE system" }],
      tools: [{ name: "step", description: "step", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
      stop_sequences: ["STOP"],
      context_management: { edits: [] },
      output_config: {
        effort: "high",
        format: { type: "json" },
        task_budget: { total: 9, remaining: 3 },
      },
      metadata: { user_id: "native-user" },
      messages: [
        { role: "user", content: "NATIVE-A" },
        { role: "assistant", content: [{ type: "text", text: "NATIVE-B" }] },
        {
          role: "user",
          content: [{ type: "text", text: "NATIVE-C", cache_control: { type: "ephemeral" } }],
        },
        { role: "assistant", content: [{ type: "text", text: "NATIVE-POST-CUT-D" }] },
        { role: "user", content: "NATIVE-POST-CUT-E" },
      ],
    }),
  );
  assert.ok(body);
  return body;
}

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: WireBody | undefined;
}

interface LaneHarness {
  readonly sent: Sent[];
  run(): Promise<LaneResult>;
}

function lane(
  respond: (init: RequestInit | undefined) => Response | Promise<Response>,
  overrides: Partial<LaneRequest> = {},
): LaneHarness {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    sent.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
      body: parseWireBody(String(init?.body ?? "")),
    });
    return respond(init);
  };
  const { payload } = buildLanePayload(capturedBody(), 3, {
    betas: ["captured-beta-1"],
    maxOutputTokens: 2048,
  });
  return {
    sent,
    run: () =>
      runLaneRequest({
        model: MODEL,
        auth: { apiKey: API_KEY },
        payload,
        signal: new AbortController().signal,
        deadlineMs: Date.now() + 10_000,
        maxResultBytes: 1_048_576,
        fetch,
        ...overrides,
      }),
  };
}

function expectFailure(result: LaneResult): LaneFailure {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(!result.ok);
  return result;
}

test("lane payload is the frozen prefix plus beta and trigger, with rejected parameters dropped", () => {
  const body = capturedBody();
  const before = structuredClone(body);
  const lanePayload = buildLanePayload(body, 3, {
    betas: ["captured-beta-1", "captured-beta-2"],
    maxOutputTokens: 2048,
  });
  const payload = lanePayload.payload;
  assert.deepEqual(payload.messages, body.messages.slice(0, 3), "prefix copied unchanged");
  assert.equal(JSON.stringify(payload).includes("NATIVE-POST-CUT"), false, "no post-cut items");
  assert.deepEqual(payload.compaction, { type: "summarize" });
  assert.deepEqual(payload.betas, ["captured-beta-1", "captured-beta-2", COMPACT_BETA]);
  assert.deepEqual(lanePayload.betas, payload.betas);
  assert.equal(payload.max_tokens, 2048);
  assert.deepEqual(payload.system, body.system, "same system");
  assert.deepEqual(payload.tools, body.tools, "same tools");
  assert.deepEqual(payload.metadata, body.metadata);
  assert.deepEqual(payload.output_config, { effort: "high", task_budget: { total: 9 } });
  for (const name of ["stream", "stop_sequences", "context_management", "tool_choice"]) {
    assert.equal(name in payload, false, name);
  }
  assert.deepEqual([...lanePayload.removed].sort(), [
    "context_management",
    "output_config.format",
    "output_config.task_budget.remaining",
    "stop_sequences",
    "tool_choice",
  ]);
  assert.deepEqual(body, before, "the captured body is not mutated");
  assert.throws(() => buildLanePayload(body, 0, { betas: [], maxOutputTokens: 1 }), RangeError);
});

test("block is read from raw stream events despite the adapter's stop-reason error", async () => {
  const run = lane(() => sse(compactionFrames()));
  const result = await run.run();
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(
    result.adapterOutcome,
    "unhandled-stop-reason",
    "the installed adapter rejects the compaction stop reason",
  );
  assert.ok(isCompactionBlock(BLOCK));
  assert.ok(sameBlock(result.block, BLOCK), "exact block including unknown fields");
  assert.deepEqual(result.block, BLOCK, "no added fields");
  assert.deepEqual(keyPaths(result.block), keyPaths(BLOCK), "no reordered fields");
  assert.deepEqual(result.usage, {
    input: 105,
    output: 20,
    iterations: [{ input: 105, output: 20 }],
  });
  assert.equal(result.requests, 1);
  const [request] = run.sent;
  assert.ok(request?.body);
  assert.deepEqual(request.body.messages, capturedBody().messages.slice(0, 3));
  assert.equal(JSON.stringify(request.body).includes("NATIVE-POST-CUT"), false);
  assert.deepEqual(request.body.compaction, { type: "summarize" });
  const betas = parseBetaHeader(request.headers.get("anthropic-beta"));
  assert.ok(betas.includes(COMPACT_BETA) && betas.includes("captured-beta-1"), betas.join(","));
  assert.equal("betas" in request.body, false, "the SDK moved betas to the header");
  assert.ok(request.url.startsWith("https://native.invalid/v1/messages"));
});

test("transport failures map to typed codes", async () => {
  const cases: {
    readonly name: string;
    readonly response: () => Response;
    readonly code: string;
    readonly reason: string;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
    readonly errorCode?: string;
  }[] = [
    {
      name: "529 compaction_unavailable",
      response: () =>
        errorResponse(
          529,
          {
            type: "overloaded_error",
            message: "busy",
            details: { error_code: "compaction_unavailable" },
          },
          { "retry-after-ms": "250" },
        ),
      code: "http-529",
      reason: "529",
      retryable: true,
      retryAfterMs: 250,
      errorCode: "compaction_unavailable",
    },
    {
      name: "429",
      response: () =>
        errorResponse(429, { type: "rate_limit_error", message: "slow" }, { "retry-after": "7" }),
      code: "http-429",
      reason: "429",
      retryable: true,
      retryAfterMs: 7000,
    },
    {
      name: "401",
      response: () => errorResponse(401, { type: "authentication_error", message: "no" }),
      code: "auth",
      reason: "auth",
      retryable: false,
    },
    {
      name: "404",
      response: () => errorResponse(404, { type: "not_found_error", message: "no model" }),
      code: "unsupported",
      reason: "unsupported",
      retryable: false,
    },
    {
      name: "400 missing beta",
      response: () =>
        errorResponse(400, {
          type: "invalid_request_error",
          message: "compaction requires anthropic-beta: compact-2026-09-04",
        }),
      code: "unsupported",
      reason: "unsupported",
      retryable: false,
    },
    {
      name: "400 misplaced",
      response: () =>
        errorResponse(400, {
          type: "invalid_request_error",
          message: "misplaced",
          details: { error_code: "compaction_block_misplaced" },
        }),
      code: "incompatible",
      reason: "incompatible",
      retryable: false,
      errorCode: "compaction_block_misplaced",
    },
    {
      name: "413",
      response: () => errorResponse(413, { type: "request_too_large", message: "big" }),
      code: "oversized",
      reason: "oversized",
      retryable: false,
    },
    {
      name: "500",
      response: () => errorResponse(500, { type: "api_error", message: "boom" }),
      code: "server-error",
      reason: "529",
      retryable: true,
    },
  ];
  for (const item of cases) {
    const run = lane(item.response);
    const failure = expectFailure(await run.run());
    assert.equal(failure.code, item.code, item.name);
    assert.equal(failure.reason, item.reason, item.name);
    assert.equal(failure.retryable, item.retryable, item.name);
    assert.equal(failure.retryAfterMs, item.retryAfterMs, item.name);
    assert.equal(failure.errorCode, item.errorCode, item.name);
    assert.equal(run.sent.length, 1, `${item.name}: no automatic retry`);
  }
});

test("200 responses without exactly one intact summary are failures with usage counted", async () => {
  const cases: {
    readonly name: string;
    readonly frames: Frame[];
    readonly code: string;
    readonly reason: string;
    readonly stopReason?: string;
  }[] = [
    {
      name: "end_turn without summary",
      frames: compactionFrames({ blocks: [], stopReason: "end_turn" }),
      code: "no-summary",
      reason: "malformed",
      stopReason: "end_turn",
    },
    {
      name: "refusal",
      frames: compactionFrames({ blocks: [], stopReason: "refusal" }),
      code: "no-summary",
      reason: "malformed",
      stopReason: "refusal",
    },
    {
      name: "tool_use",
      frames: compactionFrames({ blocks: [], stopReason: "tool_use" }),
      code: "no-summary",
      reason: "malformed",
      stopReason: "tool_use",
    },
    {
      name: "max_tokens",
      frames: compactionFrames({ blocks: [], stopReason: "max_tokens" }),
      code: "oversized",
      reason: "oversized",
      stopReason: "max_tokens",
    },
    {
      name: "context window",
      frames: compactionFrames({ blocks: [], stopReason: "model_context_window_exceeded" }),
      code: "oversized",
      reason: "oversized",
      stopReason: "model_context_window_exceeded",
    },
    {
      name: "two blocks",
      frames: compactionFrames({ blocks: [BLOCK, BLOCK] }),
      code: "malformed",
      reason: "malformed",
      stopReason: "compaction",
    },
    {
      name: "delta on the block",
      frames: compactionFrames({ deltaOnBlock: true }),
      code: "malformed",
      reason: "malformed",
      stopReason: "compaction",
    },
    {
      name: "unsigned block",
      frames: compactionFrames({ blocks: [{ type: "compaction", content: "x" }] }),
      code: "malformed",
      reason: "malformed",
      stopReason: "compaction",
    },
    {
      name: "extra text block",
      frames: compactionFrames({ blocks: [BLOCK, { type: "text", text: "reply" }] }),
      code: "malformed",
      reason: "malformed",
      stopReason: "compaction",
    },
  ];
  for (const item of cases) {
    const failure = expectFailure(await lane(() => sse(item.frames)).run());
    assert.equal(failure.code, item.code, item.name);
    assert.equal(failure.reason, item.reason, item.name);
    assert.equal(failure.stopReason, item.stopReason, item.name);
    assert.equal(failure.httpStatus, 200, item.name);
    assert.deepEqual(
      failure.usage,
      { input: 105, output: 20, iterations: [{ input: 105, output: 20 }] },
      `${item.name}: billed usage still counted`,
    );
  }
  // A stream that ends before any stop reason is malformed, not a summary.
  const truncated = expectFailure(await lane(() => sse([start()])).run());
  assert.equal(truncated.code, "malformed");
});

test("oversized results abort the lane", async () => {
  const run = lane(() => sse(compactionFrames()), { maxResultBytes: 200 });
  const failure = expectFailure(await run.run());
  assert.equal(failure.code, "oversized");
});

test("missing auth and network errors fail without a transmitted request", async () => {
  const missing = lane(() => sse(compactionFrames()), { auth: {} });
  const failure = expectFailure(await missing.run());
  assert.equal(failure.code, "auth");
  assert.equal(missing.sent.length, 0);
  assert.equal(failure.requests, 0);
  const headerAuth = lane(() => sse(compactionFrames()), {
    auth: { headers: { authorization: "Bearer native-placeholder" } },
  });
  assert.ok((await headerAuth.run()).ok, "header-owned auth is accepted");
  const network = lane(() => {
    throw new TypeError("fetch failed");
  });
  const networkFailure = expectFailure(await network.run());
  assert.equal(networkFailure.code, "network");
  assert.equal(networkFailure.reason, "timeout");
  assert.equal(networkFailure.retryable, true);
});

function hangUntilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
      once: true,
    });
  });
}

test(
  "deadline expiry is a timeout; caller abort is a cancellation",
  { timeout: 10_000 },
  async () => {
    const timeout = lane(hangUntilAborted, { deadlineMs: Date.now() + 50 });
    const timedOut = expectFailure(await timeout.run());
    assert.equal(timedOut.code, "timeout");
    assert.equal(timedOut.retryable, true);

    const controller = new AbortController();
    const canceled = lane(
      (init) => {
        queueMicrotask(() => controller.abort());
        return hangUntilAborted(init);
      },
      { signal: controller.signal },
    );
    const canceledFailure = expectFailure(await canceled.run());
    assert.equal(canceledFailure.code, "canceled");
    assert.equal(canceledFailure.retryable, false);

    const preAborted = new AbortController();
    preAborted.abort();
    const never = lane(() => sse(compactionFrames()), { signal: preAborted.signal });
    assert.equal(expectFailure(await never.run()).code, "canceled");
    assert.equal(never.sent.length, 0, "pre-aborted: no request");
    const expired = lane(() => sse(compactionFrames()), { deadlineMs: Date.now() - 1 });
    assert.equal(expectFailure(await expired.run()).code, "timeout");
    assert.equal(expired.sent.length, 0, "expired deadline: no request");
  },
);
