import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessageEvent, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AntigravityErrorKind } from "../src/errors.ts";
import {
  RETRYABLE_ANTIGRAVITY_ERROR_KINDS,
  antigravityErrorFromHttp,
  antigravityNetworkError,
  formatAntigravityErrorMessage,
  parseAntigravityErrorMessage,
} from "../src/errors.ts";
import { MAX_TRANSPORT_RETRIES, streamGoogleAntigravityWith } from "../src/stream/index.ts";
import type { AntigravityStreamDeps } from "../src/stream/index.ts";
import {
  API_KEY,
  collect,
  hangingSseResponse,
  piFetch,
  sseEvent,
  sseResponse,
  terminalEvents,
  testModel,
  transcript,
} from "./fixtures/stream/harness.ts";
import { fakeFetch, json } from "./helpers.ts";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const context = transcript({
  systemPrompt: "sys",
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
});
const okBody = sseEvent({
  candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
});

interface Run {
  options?: Partial<SimpleStreamOptions>;
  deps?: AntigravityStreamDeps;
}

function start(fetch: typeof globalThis.fetch, run: Run = {}) {
  const sleeps: number[] = [];
  const deps: AntigravityStreamDeps = {
    env: {},
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...run.deps,
  };
  const options: SimpleStreamOptions = { apiKey: API_KEY, reasoning: "low", fetch, ...run.options };
  return { stream: streamGoogleAntigravityWith(testModel(), context, options, deps), sleeps };
}

function rpc(code: number, status: string, message: string, details: object[] = []): string {
  return JSON.stringify({ error: { code, status, message, details } });
}

const errorInfo = (reason: string, metadata: Record<string, string> = {}) => ({
  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
  reason,
  domain: "cloudcode-pa.googleapis.com",
  metadata,
});
const retryInfo = (retryDelay: string) => ({
  "@type": "type.googleapis.com/google.rpc.RetryInfo",
  retryDelay,
});

const HTTP_CASES: readonly (readonly [AntigravityErrorKind, number, string])[] = [
  [
    "quota_exhausted",
    429,
    rpc(429, "RESOURCE_EXHAUSTED", "Quota exhausted.", [
      errorInfo("QUOTA_EXHAUSTED", { quotaResetTimeStamp: "2030-01-01T05:00:00Z" }),
    ]),
  ],
  [
    "credits_exhausted",
    429,
    rpc(429, "RESOURCE_EXHAUSTED", "No credits.", [errorInfo("INSUFFICIENT_G1_CREDITS")]),
  ],
  [
    "rate_limited",
    429,
    rpc(429, "RESOURCE_EXHAUSTED", "Slow down.", [
      errorInfo("RATE_LIMIT_EXCEEDED"),
      retryInfo("30s"),
    ]),
  ],
  [
    "capacity",
    503,
    rpc(503, "UNAVAILABLE", "No capacity.", [
      errorInfo("MODEL_CAPACITY_EXHAUSTED"),
      retryInfo("60s"),
    ]),
  ],
  ["auth", 401, rpc(401, "UNAUTHENTICATED", "Invalid credentials.")],
  [
    "permission",
    403,
    rpc(403, "PERMISSION_DENIED", "Denied.", [errorInfo("SUBSCRIPTION_REQUIRED")]),
  ],
  [
    "validation_required",
    403,
    rpc(403, "PERMISSION_DENIED", "Verify your account.", [errorInfo("VALIDATION_REQUIRED")]),
  ],
  [
    "unsupported_client",
    400,
    rpc(400, "FAILED_PRECONDITION", "Client unsupported.", [errorInfo("UNSUPPORTED_CLIENT")]),
  ],
  ["model_unavailable", 404, rpc(404, "NOT_FOUND", "Requested entity was not found.")],
  ["invalid_request", 400, rpc(400, "INVALID_ARGUMENT", "Invalid JSON payload received.")],
  [
    "context_overflow",
    400,
    rpc(
      400,
      "INVALID_ARGUMENT",
      "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
    ),
  ],
  ["server", 500, rpc(500, "INTERNAL", "Internal error encountered.")],
];

function assertSingleTerminal(events: readonly AssistantMessageEvent[]): void {
  assert.equal(terminalEvents(events).length, 1);
  assert.equal(events.at(-1), terminalEvents(events)[0]);
}

describe("HTTP errors", () => {
  for (const [kind, status, body] of HTTP_CASES) {
    it(`${kind}: G1 message, Pi retry/overflow predicates, transport retry policy`, async () => {
      const fake = fakeFetch(() => json(status, body));
      const { stream, sleeps } = start(piFetch(fake), { options: { maxRetries: 2 } });
      const { events, result } = await collect(stream);
      assertSingleTerminal(events);
      const expected = antigravityErrorFromHttp(status, body, null, NOW);
      assert.equal(expected.kind, kind, "fixture classifies as intended");
      assert.equal(result.stopReason, "error");
      assert.equal(result.errorMessage, expected.message);
      assert.equal(parseAntigravityErrorMessage(result.errorMessage ?? "")?.kind, kind);
      const retryable = RETRYABLE_ANTIGRAVITY_ERROR_KINDS.has(kind);
      assert.equal(isRetryableAssistantError(result), retryable);
      assert.equal(isContextOverflow(result), kind === "context_overflow");
      const retriedHere = kind === "server";
      assert.equal(fake.calls.length, retriedHere ? 3 : 1);
      assert.deepEqual(sleeps, retriedHere ? [1000, 2000] : []);
    });
  }

  it("retries a 503 without a delay and succeeds without surfacing the failure", async () => {
    let calls = 0;
    const fake = fakeFetch(() => {
      calls += 1;
      return calls === 1 ? json(503, rpc(503, "UNAVAILABLE", "busy")) : sseResponse([okBody]);
    });
    const { stream, sleeps } = start(piFetch(fake));
    const { events, result } = await collect(stream);
    assertSingleTerminal(events);
    assert.equal(result.stopReason, "stop");
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(sleeps, [1000]);
  });

  it("caps transport retries even when Pi asks for more", async () => {
    const fake = fakeFetch(() => json(500, rpc(500, "INTERNAL", "boom")));
    const { stream } = start(piFetch(fake), { options: { maxRetries: 10 } });
    await collect(stream);
    assert.equal(fake.calls.length, MAX_TRANSPORT_RETRIES + 1);
  });

  it("does not retry when maxRetries is 0", async () => {
    const fake = fakeFetch(() => json(500, rpc(500, "INTERNAL", "boom")));
    const { stream } = start(piFetch(fake), { options: { maxRetries: 0 } });
    const { result } = await collect(stream);
    assert.equal(fake.calls.length, 1);
    assert.equal(isRetryableAssistantError(result), true);
  });

  it("classifies an in-stream google.rpc error after partial output, without retrying", async () => {
    const fake = fakeFetch(() =>
      sseResponse([
        sseEvent({ candidates: [{ content: { parts: [{ text: "part" }] } }] }),
        `data: ${rpc(429, "RESOURCE_EXHAUSTED", "Quota exhausted.", [errorInfo("QUOTA_EXHAUSTED")])}\r\n\r\n`,
      ]),
    );
    const { stream } = start(piFetch(fake));
    const { events, result } = await collect(stream);
    assertSingleTerminal(events);
    assert.equal(fake.calls.length, 1);
    assert.equal(parseAntigravityErrorMessage(result.errorMessage ?? "")?.kind, "quota_exhausted");
    assert.equal(isRetryableAssistantError(result), false);
    assert.deepEqual(result.content, [{ type: "text", text: "part" }]);
  });

  it("classifies an HTTP 200 JSON error body", async () => {
    const body = rpc(400, "INVALID_ARGUMENT", "Invalid JSON payload received.");
    const fake = fakeFetch(() => json(200, body));
    const { stream } = start(piFetch(fake));
    const { result } = await collect(stream);
    assert.equal(parseAntigravityErrorMessage(result.errorMessage ?? "")?.kind, "invalid_request");
  });

  it("maps fetch failures to a retryable network error", async () => {
    const failing: typeof globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const { stream, sleeps } = start(failing, { options: { maxRetries: 1 } });
    const { result } = await collect(stream);
    assert.equal(result.errorMessage, antigravityNetworkError("fetch failed").message);
    assert.equal(isRetryableAssistantError(result), true);
    assert.deepEqual(sleeps, [1000]);
  });

  it("reports a missing credential as auth, without a request", async () => {
    const fake = fakeFetch(() => sseResponse([okBody]));
    const { stream } = start(piFetch(fake), { options: { apiKey: "" } });
    const { result } = await collect(stream);
    assert.equal(parseAntigravityErrorMessage(result.errorMessage ?? "")?.kind, "auth");
    assert.equal(fake.calls.length, 0);
  });

  it("refuses a raw Gemini API key as auth, without a request, a retry or echoing the key", async () => {
    const rawKey = "AIzaFAKE-gemini-api-key-for-tests";
    const fake = fakeFetch(() => sseResponse([okBody]));
    const { stream, sleeps } = start(piFetch(fake), { options: { apiKey: rawKey, maxRetries: 3 } });
    const { events, result } = await collect(stream);
    assert.deepEqual(
      terminalEvents(events).map((event) => event.type),
      ["error"],
    );
    const message = result.errorMessage ?? "";
    assert.equal(parseAntigravityErrorMessage(message)?.kind, "auth");
    assert.match(message, /Google Antigravity OAuth/u);
    assert.match(message, /\/login google and choose Google Antigravity/u);
    assert.doesNotMatch(message, /AIza/u);
    assert.equal(isRetryableAssistantError(result), false);
    assert.deepEqual(sleeps, []);
    assert.equal(fake.calls.length, 0);
  });

  it("rejects a model whose api is not google-generative-ai", async () => {
    const fake = fakeFetch(() => sseResponse([okBody]));
    const model = { ...testModel(), api: "openai-completions" };
    const { result } = await collect(
      streamGoogleAntigravityWith(
        model,
        context,
        { apiKey: API_KEY, fetch: piFetch(fake) },
        { env: {} },
      ),
    );
    assert.equal(
      result.errorMessage,
      formatAntigravityErrorMessage({
        kind: "invalid_request",
        detail: "model api openai-completions is not served by the Google Antigravity transport",
      }),
    );
    assert.equal(fake.calls.length, 0);
  });
});

describe("abort and stalls", () => {
  it("settles once as aborted when aborted before the request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeFetch(() => sseResponse([okBody]));
    const { stream } = start(piFetch(fake), { options: { signal: controller.signal } });
    const { events, result } = await collect(stream);
    assertSingleTerminal(events);
    assert.equal(result.stopReason, "aborted");
    assert.equal(fake.calls.length, 0);
  });

  it("settles once as aborted mid-stream and keeps partial output", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      calls += 1;
      return hangingSseResponse(
        sseEvent({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }),
        init?.signal,
      );
    };
    const { stream } = start(fetch, { options: { signal: controller.signal, maxRetries: 2 } });
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === "text_delta") controller.abort();
    }
    const result = await stream.result();
    assertSingleTerminal(events);
    assert.equal(result.stopReason, "aborted");
    assert.equal(result.errorMessage, "Request was aborted");
    assert.deepEqual(result.content, [{ type: "text", text: "partial" }]);
    assert.equal(calls, 1, "an abort is never retried");
    assert.equal(isRetryableAssistantError(result), false);
  });

  it("settles once as aborted when aborted during a retry delay", async () => {
    const controller = new AbortController();
    const fake = fakeFetch(() => json(500, rpc(500, "INTERNAL", "boom")));
    const { stream } = start(piFetch(fake), {
      options: { signal: controller.signal, maxRetries: 2 },
      deps: {
        sleep: async () => {
          controller.abort();
        },
      },
    });
    const { events, result } = await collect(stream);
    assertSingleTerminal(events);
    assert.equal(result.stopReason, "aborted");
    assert.equal(fake.calls.length, 1);
  });

  it("ends a stalled stream with a retryable network error and does not retry after output", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      calls += 1;
      return hangingSseResponse(
        sseEvent({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }),
        init?.signal,
      );
    };
    const { stream } = start(fetch, { options: { maxRetries: 2 }, deps: { idleTimeoutMs: 20 } });
    const { events, result } = await collect(stream);
    assertSingleTerminal(events);
    assert.equal(result.stopReason, "error");
    assert.equal(parseAntigravityErrorMessage(result.errorMessage ?? "")?.kind, "network");
    assert.equal(isRetryableAssistantError(result), true);
    assert.equal(calls, 1);
  });

  it("times out waiting for response headers as a network error", async () => {
    const fetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    const { stream } = start(fetch, { options: { maxRetries: 0 }, deps: { headerTimeoutMs: 20 } });
    const { result } = await collect(stream);
    assert.equal(result.stopReason, "error");
    assert.equal(parseAntigravityErrorMessage(result.errorMessage ?? "")?.kind, "network");
  });

  for (const [label, status, contentType] of [
    ["a 503 error body", 503, "application/json"],
    ["an HTTP 200 JSON body", 200, "application/json"],
  ] as const) {
    it(`ends ${label} that never sends or closes at the idle deadline as a retryable network error`, async () => {
      let cancelled = false;
      let calls = 0;
      const fetch: typeof globalThis.fetch = async () => {
        calls += 1;
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        });
        return new Response(body, { status, headers: { "Content-Type": contentType } });
      };
      const { stream } = start(fetch, { options: { maxRetries: 0 }, deps: { idleTimeoutMs: 20 } });
      let guard: ReturnType<typeof setTimeout> | undefined;
      const hung = new Promise<never>((_resolve, reject) => {
        guard = setTimeout(() => reject(new Error("the turn is still pending after 2s")), 2_000);
      });
      try {
        const { events, result } = await Promise.race([collect(stream), hung]);
        assertSingleTerminal(events);
        assert.equal(result.stopReason, "error");
        assert.equal(parseAntigravityErrorMessage(result.errorMessage ?? "")?.kind, "network");
        assert.equal(isRetryableAssistantError(result), true);
        assert.equal(cancelled, true, "the stalled body is cancelled");
        assert.equal(calls, 1);
      } finally {
        clearTimeout(guard);
      }
    });
  }
});

function sseThenFail(pieces: readonly string[], failure: Error): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces[index];
      index += 1;
      if (piece === undefined) controller.error(failure);
      else controller.enqueue(encoder.encode(piece));
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("attempt isolation", () => {
  it("a retry never inherits the finish reason, usage or ids of a failed attempt", async () => {
    let calls = 0;
    const fake = fakeFetch(() => {
      calls += 1;
      if (calls === 1) {
        return sseThenFail(
          [
            sseEvent({
              responseId: "stale-response",
              modelVersion: "stale-model",
              candidates: [{ finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
            }),
          ],
          new TypeError("connection reset"),
        );
      }
      return sseResponse([]);
    });
    const { stream, sleeps } = start(piFetch(fake), { options: { maxRetries: 1 } });
    const { events, result } = await collect(stream);
    assertSingleTerminal(events);
    assert.equal(fake.calls.length, 2, "the pre-content failure is retried once");
    assert.deepEqual(sleeps, [1000]);
    assert.equal(result.stopReason, "error");
    assert.equal(parseAntigravityErrorMessage(result.errorMessage ?? "")?.kind, "network");
    assert.match(result.errorMessage ?? "", /ended before a finish reason/u);
    assert.equal(isRetryableAssistantError(result), true);
    assert.equal(result.responseId, undefined);
    assert.equal(result.responseModel, undefined);
    assert.equal(result.usage.totalTokens, 0);
  });
});

describe("leaving an attempt early", () => {
  function openBody(first: string, signal: AbortSignal | null | undefined) {
    const seen = { cancelled: false, aborted: false };
    signal?.addEventListener(
      "abort",
      () => {
        seen.aborted = true;
      },
      { once: true },
    );
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(first));
      },
      cancel() {
        seen.cancelled = true;
      },
    });
    return {
      seen,
      response: new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    };
  }

  it("cancels the open body and aborts the request when an event is not JSON", async () => {
    const opened: { cancelled: boolean; aborted: boolean }[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const { seen, response } = openBody("data: not-json\r\n\r\n", init?.signal);
      opened.push(seen);
      return response;
    };
    const { stream } = start(fetch, { options: { maxRetries: 0 } });
    const { events, result } = await collect(stream);
    assertSingleTerminal(events);
    assert.equal(result.stopReason, "error");
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0], { cancelled: true, aborted: true });
  });

  it("cancels the body and aborts the request when onResponse throws", async () => {
    const opened: { cancelled: boolean; aborted: boolean }[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const { seen, response } = openBody(okBody, init?.signal);
      opened.push(seen);
      return response;
    };
    const { stream } = start(fetch, {
      options: {
        maxRetries: 0,
        onResponse: () => {
          throw new Error("hook failed");
        },
      },
    });
    const { events, result } = await collect(stream);
    assertSingleTerminal(events);
    assert.equal(result.stopReason, "error");
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0], { cancelled: true, aborted: true });
  });
});
