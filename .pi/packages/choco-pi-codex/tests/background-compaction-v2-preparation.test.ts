import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  normalizeContext,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { buildSnapshot, deferred } from "../../choco-pi-compaction/tests/background-fakes.ts";
import type {
  PreparationBudget,
  PreparedCheckpoint,
  PrepareFailure,
  ProviderScope,
} from "../../choco-pi-compaction/src/background/contract.ts";
import {
  createOpenAICodexProviderStream,
  type OpenAICodexProviderOptions,
} from "../src/providers/openai-codex-custom-provider.ts";
import {
  CODEX_TURN_STATE_HEADER,
  createCodexTurnState,
} from "../src/providers/openai-codex/turn-state.ts";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import {
  DAYBREAK_BRIDGE_SYMBOL,
  type DaybreakBridge,
  type DaybreakController,
  type DaybreakState,
} from "../src/providers/openai-codex/daybreak-types.ts";
import { cleanupOpenAICodexTransportSession } from "../src/providers/openai-codex/transport-cleanup.ts";
import { canonicalCompactionPromptInput } from "../src/providers/openai-codex/session-continuity.ts";
import {
  createCodexBackgroundBackend,
  codexBackgroundAccountScope,
  buildCodexBackgroundReplay,
  isCodexBackgroundCapture,
  type CodexBackgroundBackendOptions,
} from "../src/adapter/compaction/background-v2.ts";
import {
  isBackgroundNativeCompactionDetails,
  persistCodexBackgroundDetails,
  resolveLatestNativeCompactionEntry,
} from "../src/adapter/compaction/details-store.ts";
import {
  isNativeCompactionDetails,
  type BackgroundNativeCompactionDetails,
} from "../src/adapter/compaction/types.ts";
import { isResponsesBody, type ResponsesBody } from "../src/providers/openai-codex/types.ts";

const originalFetch = globalThis.fetch;
let globalFetchCalls = 0;
globalThis.fetch = () => {
  globalFetchCalls++;
  throw new Error("NETWORK FORBIDDEN: use the request-scoped fake fetch");
};
afterEach(() => {
  cleanupOpenAICodexTransportSession("observer-foreground");
  assert.equal(globalFetchCalls, 0);
});
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
// Synthetic unsigned token shape only, never read from a credential store.
const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.fixture`;
const scope: ProviderScope = {
  provider: model.provider,
  model: model.id,
  baseUrl: model.baseUrl,
  authMode: "oauth",
  accountScope: codexBackgroundAccountScope(account),
};
const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const body: ResponsesBody = {
  model: model.id,
  input: [
    user("PREFIX PENDING"),
    { type: "function_call", name: "lookup", call_id: "prefix-call", arguments: "{}" },
    { type: "function_call_output", call_id: "prefix-call", output: "37" },
    user("CUT"),
  ],
  instructions: "Frozen instructions",
  stream: true,
  store: false,
  text: { verbosity: "low" },
  reasoning: { effort: "low" },
  include: ["reasoning.encrypted_content"],
  tool_choice: "none",
  parallel_tool_calls: false,
};
const placeholder = {
  type: "compaction",
  id: "fixture-compaction",
  encrypted_content: "SYNTHETIC-OPAQUE-PLACEHOLDER-NOT-CIPHERTEXT",
};
function budget(overrides: Partial<PreparationBudget> = {}): PreparationBudget {
  return {
    maxInputTokens: 10000,
    maxOutputTokens: 100,
    maxResultBytes: 10000,
    deadlineMs: Date.now() + 5000,
    maxAttempts: 1,
    ...overrides,
  };
}
function frames(
  items: readonly object[],
  terminal = true,
  outputTokens = 7,
  terminalItems: readonly object[] = items,
  inputTokens = 41,
): string {
  return [
    ...items.map((item) => ({ type: "response.output_item.done", item })),
    ...(terminal
      ? [
          {
            type: "response.completed",
            response: {
              id: "fixture-response",
              status: "completed",
              output: terminalItems,
              usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
                input_tokens_details: { cached_tokens: 3 },
              },
            },
          },
        ]
      : []),
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
}
function sse(
  items: readonly object[] = [placeholder],
  terminal = true,
  outputTokens = 7,
): Response {
  return new Response(frames(items, terminal, outputTokens), {
    headers: { "content-type": "text/event-stream" },
  });
}
/** A started SSE response that never completes; it errors only when the request aborts. */
function pendingSse(signal: AbortSignal | null | undefined, started: () => void): Response {
  const created = `data: ${JSON.stringify({ type: "response.created", response: { id: "pending" } })}\n\n`;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode(created));
      signal?.addEventListener("abort", () => stream.error(new Error("aborted")), { once: true });
      started();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
/** Applies a post-hook payload rewrite after the provider's own payload hook. */
function withPostPayload(
  options: SimpleStreamOptions | undefined,
  postPayload: ((payload: ResponsesBody) => ResponsesBody) | undefined,
): SimpleStreamOptions | undefined {
  const streamOptions = options ? { ...options } : undefined;
  if (!postPayload || !streamOptions) return streamOptions;
  const onPayload = streamOptions.onPayload;
  streamOptions.onPayload = async (payload, requestModel) => {
    const selected = await onPayload?.(payload, requestModel);
    assert.ok(isResponsesBody(selected));
    return postPayload(selected);
  };
  return streamOptions;
}
async function fixture(
  fetch: typeof globalThis.fetch,
  current: () => boolean = () => true,
  resolveRuntime?: CodexBackgroundBackendOptions["resolveRuntime"],
  providerOptions: OpenAICodexProviderOptions = { useResponsesLite: () => false },
  postPayload?: (payload: ResponsesBody) => ResponsesBody,
) {
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
        withPostPayload(options, postPayload),
        providerOptions,
      ),
  });
  const backend = createCodexBackgroundBackend({
    modelRegistry: new ModelRegistry(runtime),
    resolveRuntime:
      resolveRuntime ??
      (() =>
        Promise.resolve({
          provider: model.provider,
          api: model.api,
          apiFamily: model.api,
          codexTransport: true,
          model: model.id,
          baseUrl: model.baseUrl,
          apiKey: token,
          currentModel: model,
        })),
    isCurrent: current,
    fetch,
  });
  const snapshot = buildSnapshot({
    ownerKey: "foreground-owner",
    providerScope: scope,
    backendCapture: {
      sessionId: "foreground-session",
      providerScope: scope,
      body: structuredClone(body),
    },
  });
  return { backend, snapshot };
}
function prepared(
  result: PreparedCheckpoint<BackgroundNativeCompactionDetails> | PrepareFailure,
): PreparedCheckpoint<BackgroundNativeCompactionDetails> {
  assert.ok("draft" in result);
  return result;
}

test("isolated SSE lane freezes request before auth await, persists exact native bundle, accounts usage separately", async () => {
  const requests: { sessionId: string; body: ResponsesBody }[] = [];
  const setup = await fixture(async (_url, init) => {
    const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
    const decoded =
      new Headers(init?.headers).get("content-encoding") === "zstd"
        ? await promisify(zstdDecompress)(bytes)
        : bytes;
    const payload: unknown = JSON.parse(decoded.toString("utf8"));
    assert.ok(isResponsesBody(payload));
    requests.push({ sessionId: new Headers(init?.headers).get("session-id") ?? "", body: payload });
    return Promise.resolve(sse());
  });
  const originalCapture = setup.snapshot.backendCapture;
  assert.ok(isCodexBackgroundCapture(originalCapture));
  const before = structuredClone(originalCapture.body);
  const pending = setup.backend.prepare(setup.snapshot, {
    signal: new AbortController().signal,
    budget: budget(),
    candidateId: "candidate-1",
  });
  originalCapture.body.instructions = "MUTATED LIVE SETTINGS";
  originalCapture.body.input.push(user("MOVING TAIL NOT IN PREFIX"));
  const checkpoint = prepared(await pending);
  assert.equal(requests.length, 1);
  assert.notEqual(requests[0]?.sessionId, "foreground-session");
  assert.ok(requests[0]?.sessionId.startsWith("foreground-session:background-compaction:"));
  assert.deepEqual(requests[0]?.body.input, [...before.input, { type: "compaction_trigger" }]);
  assert.equal(requests[0]?.body.instructions, before.instructions);
  assert.deepEqual(requests[0]?.body.reasoning, before.reasoning);
  assert.deepEqual(checkpoint.details.compactedWindow, [
    { ...user("PREFIX PENDING"), type: "message" },
    { ...user("CUT"), type: "message" },
    placeholder,
  ]);
  assert.deepEqual(checkpoint.usage, { input: 41, output: 7 });
  assert.equal(checkpoint.details.schemaVersion, 1);
  assert.deepEqual(persistCodexBackgroundDetails(checkpoint.details), checkpoint.details);
  const session = SessionManager.inMemory();
  session.appendCompaction(
    checkpoint.draft.summary,
    null,
    setup.snapshot.tokenEstimate,
    persistCodexBackgroundDetails(checkpoint.details),
    true,
  );
  const restored = resolveLatestNativeCompactionEntry(session.getEntries());
  assert.ok(restored.ok);
  assert.ok(isBackgroundNativeCompactionDetails(restored.entry.details));
  assert.deepEqual(restored.entry.details, checkpoint.details);
  assert.equal(canonicalCompactionPromptInput("foreground-session", model.id), undefined);
  assert.equal("apiKey" in checkpoint.details, false);
  assert.equal("authorization" in checkpoint.details, false);
  assert.equal("accountId" in checkpoint.details.background, false);
  assert.equal(checkpoint.details.background.providerScope.accountScope?.includes(account), false);
});

test("registered shared foreground turn state is neither read nor mutated; background owns a private state and raw payload", async () => {
  const foreground = createCodexTurnState();
  const originalCurrent = foreground.current;
  const originalCapture = foreground.capture;
  let reads = 0;
  let writes = 0;
  let liteReads = 0;
  foreground.current = () => {
    reads++;
    return originalCurrent();
  };
  foreground.capture = (value) => {
    writes++;
    originalCapture(value);
  };
  const before = { ...foreground };
  const beforeValue = originalCurrent();
  let foregroundKeepalive = structuredClone(body);
  const keepaliveIdentity = foregroundKeepalive;
  const keepaliveBefore = structuredClone(foregroundKeepalive);
  let promptCapturePending = true;
  let sharedPreparedCalls = 0;
  const providerOptions: OpenAICodexProviderOptions = {
    turnState: foreground,
    onPreparedPayload(payload) {
      sharedPreparedCalls++;
      foregroundKeepalive = payload;
      promptCapturePending = false;
    },
    useResponsesLite: () => {
      liteReads++;
      return true;
    },
  };
  const { backend, snapshot } = await fixture(
    async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get(CODEX_TURN_STATE_HEADER), null);
      const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
      const decoded =
        headers.get("content-encoding") === "zstd" ? await promisify(zstdDecompress)(bytes) : bytes;
      const wire: unknown = JSON.parse(decoded.toString("utf8"));
      assert.ok(isResponsesBody(wire));
      assert.equal(wire.client_metadata?.[CODEX_TURN_STATE_HEADER], undefined);
      assert.deepEqual(wire.input, [...body.input, { type: "compaction_trigger" }]);
      const response = sse();
      response.headers.set(CODEX_TURN_STATE_HEADER, "SYNTHETIC-BACKGROUND-TURN-STATE");
      return response;
    },
    () => true,
    () =>
      Promise.resolve({
        provider: model.provider,
        api: model.api,
        apiFamily: model.api,
        codexTransport: true,
        model: model.id,
        baseUrl: model.baseUrl,
        apiKey: token,
        currentModel: {
          ...model,
          headers: { "X-Codex-Turn-State": "SYNTHETIC-MODEL-FOREGROUND-HINT" },
        },
        headers: { "X-Codex-Turn-State": "SYNTHETIC-FOREGROUND-HINT" },
      }),
    providerOptions,
  );
  assert.ok(isCodexBackgroundCapture(snapshot.backendCapture));
  snapshot.backendCapture.body.client_metadata = {
    [CODEX_TURN_STATE_HEADER]: "SYNTHETIC-FOREGROUND-HINT",
  };
  prepared(
    await backend.prepare(snapshot, {
      signal: new AbortController().signal,
      budget: budget(),
      candidateId: "shared-turn-state",
    }),
  );
  assert.equal(providerOptions.turnState, foreground);
  assert.deepEqual(foreground, before);
  assert.deepEqual({ value: originalCurrent() }, { value: beforeValue });
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(liteReads, 0);
  assert.equal(sharedPreparedCalls, 0);
  assert.equal(foregroundKeepalive, keepaliveIdentity);
  assert.deepEqual(foregroundKeepalive, keepaliveBefore);
  assert.equal(promptCapturePending, true);
});

function unexpectedDaybreakCall(name: string): () => never {
  return () => {
    throw new Error(`unexpected Daybreak ${name}`);
  };
}
/** Read-only Daybreak controller that counts reads and rejects every mutation. */
function countingDaybreakController(
  sessionId: string,
  state: () => DaybreakState,
  onRead: () => void,
): DaybreakController {
  return {
    getState() {
      onRead();
      return { ...state(), sessionId };
    },
    subscribe: unexpectedDaybreakCall("subscribe"),
    set: unexpectedDaybreakCall("set"),
    report: unexpectedDaybreakCall("report"),
    dispose: unexpectedDaybreakCall("dispose"),
  };
}
function countingDaybreakBridge(state: () => DaybreakState, onRead: () => void): DaybreakBridge {
  return {
    version: 1,
    register: unexpectedDaybreakCall("registration"),
    createExtension: unexpectedDaybreakCall("extension"),
    get(sessionId) {
      onRead();
      return countingDaybreakController(sessionId, state, onRead);
    },
  };
}

test("fast and Daybreak config flips during auth cannot rewrite frozen background settings", async () => {
  const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
  config.openai.fast = false;
  let configReads = 0;
  let daybreakReads = 0;
  let daybreak: DaybreakState = {
    sessionId: "foreground-session",
    requested: false,
    source: "explicit",
    revision: 0,
    generation: 0,
    outcome: "off",
  };
  const bridge = countingDaybreakBridge(
    () => daybreak,
    () => {
      daybreakReads++;
    },
  );
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, DAYBREAK_BRIDGE_SYMBOL);
  Object.defineProperty(globalThis, DAYBREAK_BRIDGE_SYMBOL, { configurable: true, value: bridge });
  const auth = deferred<void>();
  let wire: ResponsesBody | undefined;
  try {
    const { backend, snapshot } = await fixture(
      async (_url, init) => {
        const headers = new Headers(init?.headers);
        const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
        const decoded =
          headers.get("content-encoding") === "zstd"
            ? await promisify(zstdDecompress)(bytes)
            : bytes;
        const payload: unknown = JSON.parse(decoded.toString("utf8"));
        assert.ok(isResponsesBody(payload));
        wire = payload;
        return sse();
      },
      () => true,
      () =>
        auth.promise.then(() => ({
          provider: model.provider,
          api: model.api,
          apiFamily: model.api,
          codexTransport: true,
          model: model.id,
          baseUrl: model.baseUrl,
          apiKey: token,
          currentModel: model,
        })),
      {
        getConfig: () => {
          configReads++;
          return config;
        },
        useResponsesLite: () => true,
      },
    );
    assert.ok(isCodexBackgroundCapture(snapshot.backendCapture));
    snapshot.backendCapture.body.service_tier = "default";
    const pending = backend.prepare(snapshot, {
      signal: new AbortController().signal,
      budget: budget(),
      candidateId: "frozen-settings",
    });
    config.openai.fast = true;
    daybreak = { ...daybreak, requested: true, revision: 1, outcome: "pending" };
    auth.resolve();
    prepared(await pending);
    assert.equal(wire?.service_tier, "default");
    assert.equal(wire?.access_programs, undefined);
    assert.equal(wire?.instructions, body.instructions);
    assert.deepEqual(wire?.reasoning, body.reasoning);
    assert.equal(configReads, 0);
    assert.equal(daybreakReads, 0);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, DAYBREAK_BRIDGE_SYMBOL, descriptor);
    else Reflect.deleteProperty(globalThis, DAYBREAK_BRIDGE_SYMBOL);
  }
});

test("final-payload drift is typed unsupported before any fetch", async () => {
  let sends = 0;
  const { backend, snapshot } = await fixture(
    () => {
      sends++;
      return Promise.resolve(sse());
    },
    () => true,
    undefined,
    { useResponsesLite: () => false },
    (payload) => ({ ...payload, instructions: "INJECTED LIVE DRIFT" }),
  );
  assert.deepEqual(
    await backend.prepare(snapshot, {
      signal: new AbortController().signal,
      budget: budget(),
      candidateId: "drift",
    }),
    { ok: false, reason: "unsupported", retryable: false, retryAfterMs: 60000 },
  );
  assert.equal(sends, 0);
});

test("captured access_programs are unsupported without auth lookup or network", async () => {
  let sends = 0;
  let authCalls = 0;
  const { backend, snapshot } = await fixture(
    () => {
      sends++;
      return Promise.resolve(sse());
    },
    () => true,
    () => {
      authCalls++;
      return Promise.resolve({ ok: false, reason: "auth", retryable: false });
    },
  );
  assert.ok(isCodexBackgroundCapture(snapshot.backendCapture));
  snapshot.backendCapture.body.access_programs = { cyber: "daybreak_blue" };
  assert.deepEqual(
    await backend.prepare(snapshot, {
      signal: new AbortController().signal,
      budget: budget(),
      candidateId: "programs",
    }),
    { ok: false, reason: "unsupported", retryable: false, retryAfterMs: 60000 },
  );
  assert.equal(authCalls, 0);
  assert.equal(sends, 0);
});

for (const [name, items] of [
  ["zero", []],
  ["two", [placeholder, { ...placeholder, id: "second" }]],
  ["valid plus malformed", [placeholder, { type: "compaction", encrypted_content: "" }]],
] satisfies [string, object[]][]) {
  test(`rejects ${name} native output without touching history`, async () => {
    const { backend, snapshot } = await fixture(() => Promise.resolve(sse(items)));
    const before = structuredClone(snapshot);
    assert.deepEqual(
      await backend.prepare(snapshot, {
        signal: new AbortController().signal,
        budget: budget(),
        candidateId: name,
      }),
      { ok: false, reason: "malformed", retryable: false },
    );
    assert.deepEqual(snapshot, before);
  });
}
for (const [status, reason, retryable, retryAfterMs] of [
  [429, "429", true, 12000],
  [401, "auth", false, 60000],
  [404, "unsupported", false, 60000],
] satisfies [number, string, boolean, number][]) {
  test(`classifies HTTP ${status}; one paid attempt only`, async () => {
    let count = 0;
    const { backend, snapshot } = await fixture(() => {
      count++;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: "fixture", message: "Fixture rejected" } }), {
          status,
          headers: { "retry-after": "12" },
        }),
      );
    });
    const result = await backend.prepare(snapshot, {
      signal: new AbortController().signal,
      budget: budget(),
      candidateId: "http",
    });
    assert.deepEqual(result, { ok: false, reason, retryable, retryAfterMs });
    assert.equal(count, 1);
  });
}
test("HTTP 429 without Retry-After keeps the default one-minute cooldown", async () => {
  const { backend, snapshot } = await fixture(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { code: "fixture", message: "Fixture rejected" } }), {
        status: 429,
      }),
    ),
  );
  assert.deepEqual(
    await backend.prepare(snapshot, {
      signal: new AbortController().signal,
      budget: budget(),
      candidateId: "http-429-default",
    }),
    { ok: false, reason: "429", retryable: true, retryAfterMs: 60000 },
  );
});
for (const [name, apiKey] of [
  ["missing", undefined],
  ["unparseable", "not-a-jwt"],
] satisfies [string, string | undefined][]) {
  test(`${name} runtime credential is an auth failure with a one-minute cooldown`, async () => {
    let sends = 0;
    const { backend, snapshot } = await fixture(
      () => {
        sends++;
        return Promise.resolve(sse());
      },
      () => true,
      () =>
        Promise.resolve({
          provider: model.provider,
          api: model.api,
          apiFamily: model.api,
          codexTransport: true,
          model: model.id,
          baseUrl: model.baseUrl,
          apiKey,
          currentModel: model,
        }),
    );
    assert.deepEqual(
      await backend.prepare(snapshot, {
        signal: new AbortController().signal,
        budget: budget(),
        candidateId: "runtime-auth",
      }),
      { ok: false, reason: "auth", retryable: false, retryAfterMs: 60000 },
    );
    assert.equal(sends, 0);
  });
}
test("pre-flight budget failures keep their reason codes and cooldowns", async () => {
  const { backend, snapshot } = await fixture(() => Promise.reject(new Error("must not send")));
  const attempt = (overrides: Partial<PreparationBudget>, signal = new AbortController().signal) =>
    backend.prepare(snapshot, { signal, budget: budget(overrides), candidateId: "preflight" });
  assert.deepEqual(await attempt({ deadlineMs: Date.now() - 1 }), {
    ok: false,
    reason: "timeout",
    retryable: true,
    retryAfterMs: 1000,
  });
  assert.deepEqual(await attempt({ maxAttempts: 0 }), {
    ok: false,
    reason: "malformed",
    retryable: false,
  });
  assert.deepEqual(await attempt({}, AbortSignal.abort()), {
    ok: false,
    reason: "canceled",
    retryable: false,
  });
  assert.deepEqual(
    await backend.prepare(
      { ...snapshot, backendCapture: undefined },
      {
        signal: new AbortController().signal,
        budget: budget(),
        candidateId: "preflight",
      },
    ),
    { ok: false, reason: "no-legal-cut", retryable: false, detail: "no-capture" },
  );
});
for (const [name, terminalItems] of [
  [
    "two compactions only in terminal output",
    [placeholder, { ...placeholder, id: "terminal-second" }],
  ],
  [
    "terminal differs from done item",
    [{ ...placeholder, encrypted_content: "DIFFERENT-SYNTHETIC-PLACEHOLDER" }],
  ],
] satisfies [string, object[]][]) {
  test(`strict background terminal rejects ${name}`, async () => {
    const { backend, snapshot } = await fixture(() =>
      Promise.resolve(
        new Response(frames([placeholder], true, 7, terminalItems), {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );
    assert.deepEqual(
      await backend.prepare(snapshot, {
        signal: new AbortController().signal,
        budget: budget(),
        candidateId: "terminal-malformed",
      }),
      { ok: false, reason: "malformed", retryable: false },
    );
  });
}
test("public raw-event observer throw cannot fail foreground generation", async () => {
  let observations = 0;
  const result = await createOpenAICodexProviderStream(
    model,
    normalizeContext({ messages: [] }),
    {
      apiKey: token,
      sessionId: "observer-foreground",
      transport: "sse",
      maxRetries: 0,
      fetch: () =>
        Promise.resolve(
          sse([
            {
              type: "message",
              id: "observer-message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "SAFE", annotations: [] }],
            },
          ]),
        ),
      onProviderStreamEvent: () => {
        observations++;
        throw new Error("synthetic advisory observer failure");
      },
    },
    { useResponsesLite: () => false },
  ).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(observations, 2);
});

test("terminal completion without reported usage is malformed, never silently accounted as zero", async () => {
  const events = [
    { type: "response.output_item.done", item: placeholder },
    {
      type: "response.completed",
      response: { id: "fixture-response", status: "completed", output: [placeholder] },
    },
  ];
  const { backend, snapshot } = await fixture(() =>
    Promise.resolve(
      new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      }),
    ),
  );
  assert.deepEqual(
    await backend.prepare(snapshot, {
      signal: new AbortController().signal,
      budget: budget(),
      candidateId: "missing-usage",
    }),
    { ok: false, reason: "malformed", retryable: false },
  );
});
test("reported input usage above the budget is rejected even when the estimate fit", async () => {
  const { backend, snapshot } = await fixture(() =>
    Promise.resolve(
      new Response(frames([placeholder], true, 7, [placeholder], 10001), {
        headers: { "content-type": "text/event-stream" },
      }),
    ),
  );
  assert.deepEqual(
    await backend.prepare(snapshot, {
      signal: new AbortController().signal,
      budget: budget(),
      candidateId: "paid-input-cap",
    }),
    { ok: false, reason: "oversized", retryable: false },
  );
});

test("EOF without terminal completion is not a checkpoint", async () => {
  const { backend, snapshot } = await fixture(() => Promise.resolve(sse([placeholder], false)));
  const result = await backend.prepare(snapshot, {
    signal: new AbortController().signal,
    budget: budget(),
    candidateId: "eof",
  });
  assert.deepEqual(result, { ok: false, reason: "malformed", retryable: false });
});
for (const limit of ["result", "output", "input"] as const) {
  test(`${limit} budget rejects honestly`, async () => {
    const { backend, snapshot } = await fixture(() => Promise.resolve(sse()));
    const limits =
      limit === "result"
        ? { maxResultBytes: 10 }
        : limit === "output"
          ? { maxOutputTokens: 1 }
          : { maxInputTokens: 1 };
    assert.deepEqual(
      await backend.prepare(snapshot, {
        signal: new AbortController().signal,
        budget: budget(limits),
        candidateId: "limit",
      }),
      { ok: false, reason: "oversized", retryable: false },
    );
  });
}
for (const stop of ["canceled", "timeout"] as const) {
  test(`${stop} mid-stream settles without a late candidate`, async () => {
    const started = deferred<void>();
    const controller = new AbortController();
    const { backend, snapshot } = await fixture((_url, init) =>
      Promise.resolve(pendingSse(init?.signal, () => started.resolve())),
    );
    const pending = backend.prepare(snapshot, {
      signal: controller.signal,
      budget: budget(stop === "timeout" ? { deadlineMs: Date.now() + 25 } : {}),
      candidateId: "stop",
    });
    await started.promise;
    if (stop === "canceled") controller.abort();
    const result = await pending;
    assert.deepEqual(
      result,
      stop === "canceled"
        ? { ok: false, reason: "canceled", retryable: false }
        : { ok: false, reason: "timeout", retryable: true, retryAfterMs: 1000 },
    );
  });
}
test("model/account change during preparation invalidates; committed checkpoint is explicit incompatibility", async () => {
  const received = deferred<void>();
  const response = deferred<Response>();
  let current = true;
  const { backend, snapshot } = await fixture(
    () => {
      received.resolve();
      return response.promise;
    },
    () => current,
  );
  const pending = backend.prepare(snapshot, {
    signal: new AbortController().signal,
    budget: budget(),
    candidateId: "stale",
  });
  await received.promise;
  current = false;
  response.resolve(sse());
  assert.deepEqual(await pending, { ok: false, reason: "incompatible", retryable: false });
  const valid = await fixture(() => Promise.resolve(sse()));
  const checkpoint = prepared(
    await valid.backend.prepare(valid.snapshot, {
      signal: new AbortController().signal,
      budget: budget(),
      candidateId: "valid",
    }),
  );
  for (const mismatch of [
    { model: "other-model" },
    { accountScope: codexBackgroundAccountScope("other-account") },
    { baseUrl: "https://api.openai.com/v1" },
    { authMode: "api_key" },
  ]) {
    assert.throws(
      () => buildCodexBackgroundReplay(checkpoint.details, { ...scope, ...mismatch }, []),
      /incompatible/,
    );
  }
  const tail = [
    user("COMPLETE"),
    { type: "function_call", name: "lookup", call_id: "tail-call", arguments: "{}" },
    { type: "function_call_output", call_id: "tail-call", output: "Kyoto" },
  ];
  const replay = buildCodexBackgroundReplay(checkpoint.details, scope, tail);
  assert.deepEqual(replay, [...checkpoint.details.compactedWindow, ...tail]);
  assert.equal(
    replay.filter((item) => "call_id" in item && item.call_id === "tail-call").length,
    2,
  );
  const legacy = { ...checkpoint.details, strategy: "openai-native-compact-v1" };
  assert.ok(isNativeCompactionDetails(legacy));
  assert.equal(isBackgroundNativeCompactionDetails(legacy), false);
  // The websocket stream copies its continuation decision into the usage
  // diagnostic; a native-steering request produced "native_steering_full",
  // which the validator once rejected, hiding a real checkpoint (live probe
  // sol-server-side-1792063683).
  const steered = {
    ...checkpoint.details,
    usage: {
      ...checkpoint.details.usage,
      diagnostic: { ...checkpoint.details.usage?.diagnostic, continuation: "native_steering_full" },
    },
  };
  assert.ok(isNativeCompactionDetails(steered));
});
for (const stop of ["canceled", "timeout"] as const) {
  test(`${stop} while auth ignores AbortSignal still settles exactly once`, async () => {
    const pendingAuth =
      deferred<Awaited<ReturnType<CodexBackgroundBackendOptions["resolveRuntime"]>>>();
    let sends = 0;
    const { backend, snapshot } = await fixture(
      () => {
        sends++;
        return Promise.resolve(sse());
      },
      () => true,
      () => pendingAuth.promise,
    );
    const controller = new AbortController();
    const pending = backend.prepare(snapshot, {
      signal: controller.signal,
      budget: budget(stop === "timeout" ? { deadlineMs: Date.now() + 15 } : {}),
      candidateId: "blocked-auth",
    });
    if (stop === "canceled") controller.abort();
    const result = await pending;
    assert.ok("ok" in result);
    assert.equal(result.reason, stop);
    pendingAuth.resolve({ ok: false, reason: "auth", retryable: false });
    await Promise.resolve();
    assert.equal(sends, 0);
  });
}
test("resolved credential account mismatch rejects before provider execution", async () => {
  const { backend, snapshot } = await fixture(
    () => Promise.reject(new Error("must not send")),
    () => true,
    () =>
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
  );
  const otherScope = { ...scope, accountScope: codexBackgroundAccountScope("different-account") };
  assert.deepEqual(
    await backend.prepare(
      {
        ...snapshot,
        providerScope: otherScope,
        backendCapture: { sessionId: "foreground", providerScope: otherScope, body },
      },
      { signal: new AbortController().signal, budget: budget(), candidateId: "account-mismatch" },
    ),
    { ok: false, reason: "incompatible", retryable: false },
  );
});
test("versioned persisted checkpoint rejects invalid bundle, version and model identity", async () => {
  const { backend, snapshot } = await fixture(() => Promise.resolve(sse()));
  const checkpoint = prepared(
    await backend.prepare(snapshot, {
      signal: new AbortController().signal,
      budget: budget(),
      candidateId: "persisted",
    }),
  );
  assert.equal(
    isBackgroundNativeCompactionDetails({ ...checkpoint.details, schemaVersion: 2 }),
    false,
  );
  assert.equal(
    isBackgroundNativeCompactionDetails({
      ...checkpoint.details,
      compactedWindow: [...checkpoint.details.compactedWindow, "not-a-replay-item"],
    }),
    false,
  );
  assert.equal(
    isBackgroundNativeCompactionDetails({
      ...checkpoint.details,
      background: { ...checkpoint.details.background, retentionPolicyVersion: 2 },
    }),
    false,
  );
  assert.equal(
    isBackgroundNativeCompactionDetails({ ...checkpoint.details, model: "mismatch" }),
    false,
  );
});

test("unsupported public endpoint and no legal tool cut never send", async () => {
  let requests = 0;
  const { backend, snapshot } = await fixture(() => {
    requests++;
    return Promise.resolve(sse());
  });
  assert.deepEqual(
    await backend.capability({
      ...scope,
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    }),
    { supported: false, reason: "unsupported" },
  );
  const capture = {
    sessionId: "foreground",
    providerScope: scope,
    body: { ...body, input: [body.input[1]] },
  };
  assert.equal(backend.isLegalCut({ ...snapshot, backendCapture: capture }).legal, false);
  assert.equal(requests, 0);
});
