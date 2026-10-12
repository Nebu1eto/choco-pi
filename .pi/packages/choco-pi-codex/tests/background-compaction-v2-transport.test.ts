import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { JsonValueSchema } from "../../choco-pi-compaction/src/background/contract.ts";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, normalizeContext, type Model } from "@earendil-works/pi-ai";
import { buildSnapshot, deferred } from "../../choco-pi-compaction/tests/background-fakes.ts";
import type { ProviderScope } from "../../choco-pi-compaction/src/background/contract.ts";
import { createOpenAICodexProviderStream } from "../src/providers/openai-codex-custom-provider.ts";
import {
  canonicalCompactionPromptInput,
  canonicalCompactionRequestBody,
} from "../src/providers/openai-codex/session-continuity.ts";
import { cleanupOpenAICodexTransportSession } from "../src/providers/openai-codex/transport-cleanup.ts";
import { isWebSocketSseFallbackActive } from "../src/providers/openai-codex/websocket-session-cache.ts";
import {
  codexBackgroundAccountScope,
  captureCodexBackgroundRequest,
  createCodexBackgroundBackend,
  installCodexBackgroundCheckpoint,
  buildCodexBackgroundReplay,
} from "../src/adapter/compaction/background-v2.ts";
import {
  isResponsesBody,
  type CodexDiagnosticsEvent,
  type ResponsesBody,
  type WebSocketEvent,
  type WebSocketLike,
} from "../src/providers/openai-codex/types.ts";
import type { AdapterState } from "../src/adapter/activation/state.ts";

const originalFetch = globalThis.fetch;
let globalFetchCalls = 0;
globalThis.fetch = () => {
  globalFetchCalls++;
  throw new Error("NETWORK FORBIDDEN: use request-scoped fake fetch");
};
afterEach(() => assert.equal(globalFetchCalls, 0));
after(() => {
  globalThis.fetch = originalFetch;
});
const model: Model<"openai-codex-responses"> = {
  id: "gpt-6-luna",
  name: "Fixture Luna",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 2048,
};
const account = "synthetic-account-not-a-credential";
const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.fixture`;
const scope: ProviderScope = {
  provider: model.provider,
  model: model.id,
  baseUrl: model.baseUrl,
  authMode: "oauth",
  accountScope: codexBackgroundAccountScope(account),
};
const opaque = {
  type: "compaction",
  id: "fixture-compaction",
  encrypted_content: "SYNTHETIC-OPAQUE-PLACEHOLDER-NOT-CIPHERTEXT",
};
function message(id: string, text: string) {
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}
function completion(id: string, items: readonly object[]) {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: items,
      usage: { input_tokens: 41, output_tokens: 7, total_tokens: 48 },
    },
  };
}
function sse(items: readonly object[]): Response {
  return new Response(
    [
      ...items.map((item) => ({ type: "response.output_item.done", item })),
      completion("sse-fixture", items),
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
class FixtureSocket implements WebSocketLike {
  static sockets: FixtureSocket[] = [];
  static sent: ResponsesBody[] = [];
  static holdNext = false;
  static failNext = false;
  static held: FixtureSocket | undefined;
  static announced = deferred<void>();
  readyState = 0;
  readonly listeners = new Map<string, Set<(event: WebSocketEvent) => void>>();
  pendingBody: ResponsesBody | undefined;
  constructor() {
    FixtureSocket.sockets.push(this);
    queueMicrotask(() => {
      if (FixtureSocket.failNext) {
        FixtureSocket.failNext = false;
        this.emit("error", { error: new Error("Unexpected server response: 426") });
        return;
      }
      this.readyState = 1;
      this.emit("open", {});
    });
  }
  send(data: string) {
    const body: unknown = JSON.parse(data);
    assert.ok(isResponsesBody(body));
    FixtureSocket.sent.push(body);
    this.pendingBody = body;
    if (FixtureSocket.holdNext) {
      FixtureSocket.holdNext = false;
      FixtureSocket.held = this;
      FixtureSocket.announced.resolve();
      return;
    }
    this.finish();
  }
  finish() {
    setImmediate(() => {
      const index = FixtureSocket.sent.length;
      const item = message(`fixture-message-${index}`, `COMPLETED-${index}`);
      this.emit("message", { data: JSON.stringify({ type: "response.output_item.done", item }) });
      this.emit("message", {
        data: JSON.stringify(completion(`fixture-response-${index}`, [item])),
      });
    });
  }
  close() {
    this.readyState = 3;
    this.emit("close", { code: 1000 });
  }
  addEventListener(type: string, listener: (event: WebSocketEvent) => void) {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }
  removeEventListener(type: string, listener: (event: WebSocketEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: WebSocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const withoutResponsesLite = { useResponsesLite: () => false };

/** Decode a fake-fetch request body, inflating zstd when the request declares it. */
async function decodeRequestBody(init: RequestInit | undefined): Promise<ResponsesBody> {
  const headers = new Headers(init?.headers);
  const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
  const decoded =
    headers.get("content-encoding") === "zstd" ? await promisify(zstdDecompress)(bytes) : bytes;
  const body: unknown = JSON.parse(decoded.toString("utf8"));
  assert.ok(isResponsesBody(body));
  return body;
}

/** A cached-WebSocket foreground turn whose payload hook replaces the input and instructions. */
function foregroundTurn(
  input: readonly unknown[],
  turn: {
    readonly sessionId: string;
    readonly diagnostics: CodexDiagnosticsEvent[];
    readonly capturePayload?: ((payload: ResponsesBody) => void) | undefined;
  },
) {
  return createOpenAICodexProviderStream(
    model,
    normalizeContext({ messages: [] }),
    {
      apiKey: token,
      sessionId: turn.sessionId,
      transport: "websocket-cached",
      maxRetries: 0,
      timeoutMs: 1000,
      env: {},
      onPayload: (payload) => {
        assert.ok(isResponsesBody(payload));
        return { ...payload, instructions: "FROZEN INSTRUCTIONS", input };
      },
    },
    {
      useResponsesLite: () => false,
      getDiagnostics: () => (event) => turn.diagnostics.push(event),
      onPreparedPayload: (payload) => turn.capturePayload?.(payload),
    },
  ).result();
}

test("isolated SSE preparation cannot corrupt concurrent cached-WebSocket foreground history; targeted adoption restores full replay", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FixtureSocket });
  const lane = "target-session";
  const other = "unrelated-session";
  const diagnostics: CodexDiagnosticsEvent[] = [];
  const identity = { url: "wss://chatgpt.com/backend-api/codex/responses", accountId: account };
  let foregroundBody: ResponsesBody | undefined;
  const stream = (input: readonly unknown[], sessionId = lane) =>
    foregroundTurn(input, {
      sessionId,
      diagnostics,
      capturePayload:
        sessionId === lane
          ? (payload) => {
              foregroundBody = structuredClone(payload);
            }
          : undefined,
    });
  try {
    const prefix = [
      { role: "user", content: [{ type: "input_text", text: "PREFIX PENDING" }] },
      { type: "function_call", name: "lookup", call_id: "prefix-call", arguments: "{}" },
      { type: "function_call_output", call_id: "prefix-call", output: "37" },
      { role: "user", content: [{ type: "input_text", text: "CUT" }] },
    ];
    const first = await stream(prefix);
    assert.equal(
      first.stopReason,
      "stop",
      first.errorMessage ?? "foreground fixture must complete",
    );
    assert.ok(foregroundBody);
    const canonicalAtCut = canonicalCompactionPromptInput(lane, model.id, identity);
    assert.ok(canonicalAtCut);
    const before = canonicalAtCut.map((item) => {
      assert.ok(Value.Check(Type.Record(Type.String(), JsonValueSchema), item));
      return structuredClone(item);
    });
    const capture = captureCodexBackgroundRequest({
      sessionId: lane,
      providerScope: scope,
      accountId: account,
      reconstructedInput: before,
    });
    assert.ok(capture);
    assert.equal(capture.body.instructions, "FROZEN INSTRUCTIONS");
    assert.equal(
      captureCodexBackgroundRequest({
        sessionId: lane,
        providerScope: scope,
        accountId: account,
        reconstructedInput: [],
      }),
      undefined,
    );
    assert.equal(
      captureCodexBackgroundRequest({
        sessionId: lane,
        providerScope: scope,
        accountId: "wrong-account",
        reconstructedInput: before,
      }),
      undefined,
    );
    await stream([{ role: "user", content: [{ type: "input_text", text: "UNRELATED" }] }], other);
    const otherBefore = structuredClone(canonicalCompactionPromptInput(other, model.id, identity));
    const otherSocket = FixtureSocket.sockets.at(-1);
    const received = deferred<void>();
    const response = deferred<Response>();
    let backgroundBody: ResponsesBody | undefined;
    let backgroundSession = "";
    const fakeFetch: typeof fetch = async (_url, init) => {
      backgroundSession = new Headers(init?.headers).get("session-id") ?? "";
      backgroundBody = await decodeRequestBody(init);
      received.resolve();
      return response.promise;
    };
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      refreshOnCreate: false,
      modelsPath: null,
    });
    runtime.registerProvider(model.provider, {
      api: model.api,
      models: [model],
      streamSimple: (m, context, options) =>
        createOpenAICodexProviderStream(
          m,
          normalizeContext(context),
          options,
          withoutResponsesLite,
        ),
    });
    const backend = createCodexBackgroundBackend({
      modelRegistry: new ModelRegistry(runtime),
      resolveRuntime: () =>
        Promise.resolve({
          provider: model.provider,
          api: model.api,
          apiFamily: model.api,
          codexTransport: true,
          model: model.id,
          baseUrl: model.baseUrl,
          apiKey: token,
          currentModel: model,
        }),
      isCurrent: () => true,
      fetch: fakeFetch,
    });
    const snapshot = buildSnapshot({
      ownerKey: lane,
      providerScope: scope,
      backendCapture: capture,
    });
    const preparation = backend.prepare(snapshot, {
      signal: new AbortController().signal,
      budget: {
        maxInputTokens: 10000,
        maxOutputTokens: 100,
        maxResultBytes: 10000,
        deadlineMs: Date.now() + 5000,
        maxAttempts: 1,
      },
      candidateId: "candidate-1",
    });
    await received.promise;
    assert.notEqual(backgroundSession, lane);
    assert.deepEqual(canonicalCompactionPromptInput(lane, model.id, identity), before);
    const afterCut = [
      { type: "function_call", name: "lookup", call_id: "tail-call", arguments: "{}" },
      { type: "function_call_output", call_id: "tail-call", output: "Kyoto" },
      { role: "user", content: [{ type: "input_text", text: "COMPLETE" }] },
    ];
    FixtureSocket.holdNext = true;
    const foreground = stream([...before, ...afterCut]);
    await FixtureSocket.announced.promise;
    assert.ok(FixtureSocket.held);
    assert.equal(FixtureSocket.held, FixtureSocket.sockets[0]);
    const wireConcurrent = FixtureSocket.sent.at(-1);
    assert.ok(wireConcurrent?.previous_response_id);
    assert.deepEqual(wireConcurrent.input, afterCut);
    response.resolve(sse([opaque]));
    const candidate = await preparation;
    assert.ok("draft" in candidate);
    assert.deepEqual(canonicalCompactionPromptInput(lane, model.id, identity), before);
    assert.deepEqual(backgroundBody?.input, [
      ...capture.body.input,
      { type: "compaction_trigger" },
    ]);
    assert.equal(backgroundBody?.instructions, capture.body.instructions);
    assert.equal(backgroundBody?.client_metadata?.["session_id"], backgroundSession);
    assert.equal(backgroundBody?.client_metadata?.["thread_id"], backgroundSession);
    FixtureSocket.held.finish();
    const foregroundResult = await foreground;
    assert.equal(foregroundResult.stopReason, "stop");
    const canonicalAfterForeground = canonicalCompactionPromptInput(lane, model.id, identity);
    assert.ok(canonicalAfterForeground);
    const exactTail = canonicalAfterForeground.slice(before.length).map((item) => {
      assert.ok(Value.Check(Type.Record(Type.String(), JsonValueSchema), item));
      return structuredClone(item);
    });
    assert.deepEqual(exactTail.slice(0, afterCut.length), afterCut);
    const targetState: Pick<AdapterState, "pendingPiCompactionNativeWindow"> = {};
    const unrelatedState: Pick<AdapterState, "pendingPiCompactionNativeWindow"> = {};
    assert.throws(
      () =>
        installCodexBackgroundCheckpoint({
          sessionId: other,
          committedEntryId: "committed-1",
          candidateId: candidate.candidateId,
          fingerprint: snapshot.prefixFingerprint,
          ownerKey: snapshot.ownerKey,
          ownerGeneration: snapshot.ownerGeneration,
          currentScope: scope,
          details: candidate.details,
          state: unrelatedState,
        }),
      /incompatible/,
    );
    assert.deepEqual(
      canonicalCompactionPromptInput(lane, model.id, identity),
      canonicalAfterForeground,
    );
    assert.equal(otherSocket?.readyState, 1);
    installCodexBackgroundCheckpoint({
      sessionId: lane,
      committedEntryId: "committed-1",
      candidateId: candidate.candidateId,
      fingerprint: snapshot.prefixFingerprint,
      ownerKey: snapshot.ownerKey,
      ownerGeneration: snapshot.ownerGeneration,
      currentScope: scope,
      details: candidate.details,
      state: targetState,
    });
    assert.equal(
      targetState.pendingPiCompactionNativeWindow?.sourceCompactionEntryId,
      "committed-1",
    );
    assert.deepEqual(unrelatedState, {});
    assert.deepEqual(canonicalCompactionPromptInput(other, model.id, identity), otherBefore);
    assert.equal(otherSocket?.readyState, 1);
    assert.equal(canonicalCompactionRequestBody(lane, model.id, identity), undefined);
    const replay = buildCodexBackgroundReplay(candidate.details, scope, exactTail);
    const replayResult = await stream(replay);
    assert.equal(replayResult.stopReason, "stop");
    const replayWire = FixtureSocket.sent.at(-1);
    assert.deepEqual(replayWire?.input, replay);
    assert.equal(replayWire?.previous_response_id, undefined);
    assert.deepEqual(
      replay.slice(0, candidate.details.compactedWindow.length),
      candidate.details.compactedWindow,
    );
    assert.equal(
      replay.filter((item) => "call_id" in item && item.call_id === "tail-call").length,
      2,
    );
    assert.equal(
      diagnostics.some(
        (event) =>
          event.type === "request" && event.transport === "websocket" && event.socketReused,
      ),
      true,
    );
    assert.equal(
      diagnostics.some((event) => event.type === "fallback" || event.type === "retry"),
      false,
    );
    assert.equal(FixtureSocket.sockets[0]?.readyState, 3);
    // SSE fallback remains scoped and sticky across adoption; unrelated cache stays reusable.
    FixtureSocket.failNext = true;
    installCodexBackgroundCheckpoint({
      sessionId: lane,
      committedEntryId: "committed-1",
      candidateId: candidate.candidateId,
      fingerprint: snapshot.prefixFingerprint,
      ownerKey: snapshot.ownerKey,
      ownerGeneration: snapshot.ownerGeneration,
      currentScope: scope,
      details: candidate.details,
      state: targetState,
    });
    assert.equal(isWebSocketSseFallbackActive(lane), false);
    let fallbackInput: unknown;
    const fallback = await createOpenAICodexProviderStream(
      model,
      normalizeContext({ messages: [] }),
      {
        apiKey: token,
        sessionId: lane,
        transport: "auto",
        maxRetries: 0,
        env: {},
        fetch: async (_url, init) => {
          fallbackInput = (await decodeRequestBody(init)).input;
          return sse([message("fallback-message", "COMPLETE")]);
        },
        onPayload: (payload) => {
          assert.ok(isResponsesBody(payload));
          return { ...payload, input: replay };
        },
      },
      { useResponsesLite: () => false },
    ).result();
    assert.equal(fallback.stopReason, "stop");
    assert.deepEqual(fallbackInput, replay);
    assert.equal(isWebSocketSseFallbackActive(lane), true);
    installCodexBackgroundCheckpoint({
      sessionId: lane,
      committedEntryId: "committed-1",
      candidateId: candidate.candidateId,
      fingerprint: snapshot.prefixFingerprint,
      ownerKey: snapshot.ownerKey,
      ownerGeneration: snapshot.ownerGeneration,
      currentScope: scope,
      details: candidate.details,
      state: targetState,
    });
    assert.equal(isWebSocketSseFallbackActive(lane), true);
    assert.equal(otherSocket?.readyState, 1);
    assert.throws(
      () =>
        installCodexBackgroundCheckpoint({
          sessionId: lane,
          committedEntryId: "commit",
          candidateId: candidate.candidateId,
          fingerprint: snapshot.prefixFingerprint,
          ownerKey: "wrong-owner",
          ownerGeneration: snapshot.ownerGeneration,
          currentScope: scope,
          details: candidate.details,
          state: targetState,
        }),
      /incompatible/,
    );
    assert.equal(otherSocket?.readyState, 1);
  } finally {
    cleanupOpenAICodexTransportSession(lane);
    cleanupOpenAICodexTransportSession(other);
    if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  }
});

async function sseRequestAttempts(sessionId: string, lane: { backgroundCompactionLane: boolean }) {
  let calls = 0;
  const output = await createOpenAICodexProviderStream(
    model,
    normalizeContext({ messages: [] }),
    {
      apiKey: token,
      sessionId,
      transport: "sse",
      maxRetries: 0,
      env: {},
      backgroundCompactionLane: lane.backgroundCompactionLane,
      validateBackgroundCompactionPayload: () => true,
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("overloaded", { status: 503 })
          : sse([message("retry-message", "COMPLETE")]);
      },
    },
    { useResponsesLite: () => false },
  ).result();
  cleanupOpenAICodexTransportSession(sessionId);
  return { calls, stopReason: output.stopReason };
}

test("SSE request retries keep the foreground budget; only the background lane honors maxRetries", async () => {
  // The SDK always passes retry.provider.maxRetries; foreground 5xx request retries predate it.
  assert.deepEqual(
    await sseRequestAttempts("foreground-retry-lane", { backgroundCompactionLane: false }),
    {
      calls: 2,
      stopReason: "stop",
    },
  );
  assert.deepEqual(
    await sseRequestAttempts("background-retry-lane", { backgroundCompactionLane: true }),
    {
      calls: 1,
      stopReason: "error",
    },
  );
});
