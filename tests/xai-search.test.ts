import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
  createEventBus,
  createExtensionRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import {
  bindSearchSession,
  createSearchScope,
  defaultSearchFamilyOrder,
  getSearchScope,
  invalidateSearchSession,
  isSearchError,
  registerSearchAdapter,
  search,
  type SearchError,
  type SearchErrorKind,
  type SearchScope,
} from "../.pi/packages/choco-pi-web-search/index.ts";
import {
  createXaiRegistrationGate,
  createXaiSearchAdapter,
  registerXaiSearchAdapter,
  XAI_SEARCH_ADAPTER_ID,
  XAI_SEARCH_MODEL,
  type XaiFetch,
  type XaiModelRegistry,
  type XaiResolvedAuth,
  type XaiSearchAdapterOptions,
} from "../.pi/extensions/lib/xai-search.ts";
import xaiSearchExtension from "../.pi/extensions/xai-search.ts";

const API_KEY = "xai-secret-fixture-key";

function xaiModel(): Model<Api> {
  return {
    id: XAI_SEARCH_MODEL,
    name: "Grok 4.3",
    provider: "xai",
    api: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 30_000,
  };
}

interface FakeRegistryOptions {
  configured?: boolean;
  oauth?: boolean;
  auth?: XaiResolvedAuth;
}

interface FakeRegistry extends XaiModelRegistry {
  credentialReads: number;
}

function fakeRegistry(options: FakeRegistryOptions = {}): FakeRegistry {
  const model = xaiModel();
  const registry: FakeRegistry = {
    credentialReads: 0,
    getProviderAuthStatus: (provider) => ({
      configured: provider === "xai" && (options.configured ?? true),
    }),
    find: (provider, modelId) =>
      provider === "xai" && modelId === XAI_SEARCH_MODEL ? model : undefined,
    getAll: () => [model],
    getApiKeyAndHeaders: async () => {
      registry.credentialReads += 1;
      return options.auth ?? { ok: true, apiKey: API_KEY, headers: { "x-extra": "1" } };
    },
    getApiKeyForProvider: async () => {
      registry.credentialReads += 1;
      return API_KEY;
    },
    isUsingOAuth: () => options.oauth ?? false,
  };
  return registry;
}

const RequestBodySchema = Type.Object({
  model: Type.String(),
  input: Type.Array(Type.Object({ role: Type.String(), content: Type.String() })),
  tools: Type.Array(
    Type.Object({
      type: Type.String(),
      filters: Type.Optional(
        Type.Object({
          allowed_domains: Type.Optional(Type.Array(Type.String())),
          excluded_domains: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    }),
  ),
  store: Type.Boolean(),
  stream: Type.Boolean(),
  max_output_tokens: Type.Number(),
});

interface FetchCall {
  url: string;
  headers: Headers;
  body: Static<typeof RequestBodySchema>;
  signal: AbortSignal | undefined;
}

function recordingFetch(respond: (call: FetchCall) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  const fetch: XaiFetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    if (!Check(RequestBodySchema, body)) throw new Error("unexpected xAI request body");
    const call: FetchCall = {
      url,
      headers: new Headers(init.headers),
      body,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch };
}

interface UncitedPayload {
  output: Array<{ type: string; content: Array<{ type: string; text: string }> }>;
}
type XaiFixturePayload = ReturnType<typeof citedResponse> | UncitedPayload;

function jsonResponse(body: XaiFixturePayload, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ANSWER_TEXT =
  "xAI builds Grok models.[[1]](https://x.ai/company) It is based in Palo Alto.[[2]](https://en.wikipedia.org/wiki/XAI_(company))";

function citedResponse() {
  const first = ANSWER_TEXT.indexOf("[[1]]");
  const second = ANSWER_TEXT.indexOf("[[2]]");
  return {
    id: "resp_1",
    status: "completed",
    output: [
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search" } },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: ANSWER_TEXT,
            annotations: [
              {
                type: "url_citation",
                url: "https://x.ai/company",
                start_index: first,
                end_index: first + 27,
                title: "1",
              },
              {
                type: "url_citation",
                url: "https://en.wikipedia.org/wiki/XAI_(company)",
                start_index: second,
                end_index: second + 50,
                title: "xAI (company) - Wikipedia",
              },
            ],
          },
        ],
      },
    ],
    citations: ["https://x.ai/company", "https://x.ai/news"],
  };
}

interface Harness {
  scope: SearchScope;
  manager: SessionManager;
  registry: FakeRegistry;
}

function setup(
  fetch: XaiFetch,
  registryOptions: FakeRegistryOptions = {},
  timeoutMs?: number,
): Harness {
  const scope = createSearchScope();
  const manager = SessionManager.inMemory("/tmp/choco-pi-xai-search-test");
  bindSearchSession(scope, manager);
  const registry = fakeRegistry(registryOptions);
  const options: XaiSearchAdapterOptions = { fetch, getRegistry: () => registry };
  if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
  registerXaiSearchAdapter(scope, options);
  return { scope, manager, registry };
}

async function expectSearchError(
  promise: Promise<unknown>,
  kind: SearchErrorKind,
): Promise<SearchError> {
  try {
    await promise;
  } catch (cause) {
    assert.equal(isSearchError(cause), true, String(cause));
    if (isSearchError(cause)) {
      assert.equal(cause.kind, kind, cause.message);
      assert.equal(cause.message.includes(API_KEY), false);
      return cause;
    }
  }
  assert.fail(`expected SearchError(${kind})`);
}

test("default family order ends with xai and the adapter declares its contract", () => {
  assert.equal(defaultSearchFamilyOrder.at(-1), "xai");
  const adapter = createXaiSearchAdapter({ getRegistry: () => undefined });
  assert.equal(adapter.id, "xai.responses");
  assert.equal(adapter.family, "xai");
  assert.equal(adapter.transport, "responses");
  assert.deepEqual(adapter.capabilities, {
    actions: ["search"],
    constraints: { numResults: true, domainFilter: true, domainExclusions: true },
  });
});

test("unconfigured xai is unavailable and never reads credentials or fetches", async () => {
  const { calls, fetch } = recordingFetch(() => jsonResponse(citedResponse()));
  const { scope, registry } = setup(fetch, { configured: false });
  const error = await expectSearchError(
    search({ query: "fixture", provider: "xai" }, { scope }),
    "capability",
  );
  assert.deepEqual(
    error.attempts?.map(({ adapterId, outcome }) => ({ adapterId, outcome })),
    [{ adapterId: XAI_SEARCH_ADAPTER_ID, outcome: "unavailable" }],
  );
  assert.match(error.attempts?.[0]?.reason ?? "", /not configured/);
  assert.equal(registry.credentialReads, 0);
  assert.equal(calls.length, 0);
});

test("missing host registry reports unavailable", async () => {
  const scope = createSearchScope();
  bindSearchSession(scope, SessionManager.inMemory("/tmp/choco-pi-xai-search-test"));
  registerXaiSearchAdapter(scope, { getRegistry: () => undefined });
  const error = await expectSearchError(
    search({ query: "fixture", provider: "xai" }, { scope }),
    "capability",
  );
  assert.match(error.attempts?.[0]?.reason ?? "", /model registry/);
});

test("happy path posts a stateless web_search request and parses citations", async () => {
  const { calls, fetch } = recordingFetch(() => jsonResponse(citedResponse()));
  const { scope } = setup(fetch);
  const response = await search({ query: "what is xai", provider: "xai" }, { scope });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, "https://api.x.ai/v1/responses");
  assert.equal(call.headers.get("authorization"), `Bearer ${API_KEY}`);
  assert.equal(call.headers.get("x-extra"), "1");
  assert.deepEqual(call.body, {
    model: XAI_SEARCH_MODEL,
    input: [
      {
        role: "system",
        content:
          "Search the web and answer concisely, grounded only in the web results. Cite sources inline.",
      },
      { role: "user", content: "what is xai" },
    ],
    tools: [{ type: "web_search" }],
    store: false,
    stream: false,
    max_output_tokens: 8192,
  });

  assert.equal(response.provider, "xai");
  assert.equal(response.adapterId, XAI_SEARCH_ADAPTER_ID);
  assert.equal(response.transport, "responses");
  assert.equal(response.billing, "api");
  assert.equal(response.answer, ANSWER_TEXT);
  assert.deepEqual(
    response.results.map(({ title, url }) => ({ title, url })),
    [
      { title: "x.ai", url: "https://x.ai/company" },
      { title: "xAI (company) - Wikipedia", url: "https://en.wikipedia.org/wiki/XAI_(company)" },
      { title: "x.ai", url: "https://x.ai/news" },
    ],
  );
  assert.match(response.results[0]?.snippet ?? "", /xAI builds Grok models/);
  assert.equal(response.results[0]?.snippet.includes("[[1]]"), false);
  assert.equal(JSON.stringify(response).includes(API_KEY), false);
});

test("OAuth credentials report subscription billing", async () => {
  const { fetch } = recordingFetch(() => jsonResponse(citedResponse()));
  const { scope } = setup(fetch, { oauth: true });
  const response = await search({ query: "fixture", provider: "xai" }, { scope });
  assert.equal(response.billing, "subscription");
});

test("numResults limits sources and domain filters map to xAI filters", async () => {
  const { calls, fetch } = recordingFetch(() => jsonResponse(citedResponse()));
  const { scope } = setup(fetch);
  const limited = await search(
    { query: "fixture", provider: "xai", numResults: 1, domainFilter: ["X.ai", "wikipedia.org"] },
    { scope },
  );
  assert.equal(limited.results.length, 1);
  assert.ok(limited.warnings?.some((warning) => /limited to 1/.test(warning)));
  assert.deepEqual(calls[0]?.body.tools[0], {
    type: "web_search",
    filters: { allowed_domains: ["x.ai", "wikipedia.org"] },
  });

  await search({ query: "fixture", provider: "xai", domainFilter: ["-reddit.com"] }, { scope });
  assert.deepEqual(calls[1]?.body.tools[0], {
    type: "web_search",
    filters: { excluded_domains: ["reddit.com"] },
  });

  await expectSearchError(
    search({ query: "fixture", provider: "xai", domainFilter: ["x.ai", "-reddit.com"] }, { scope }),
    "capability",
  );
  await expectSearchError(
    search(
      {
        query: "fixture",
        provider: "xai",
        domainFilter: ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"],
      },
      { scope },
    ),
    "capability",
  );
  assert.equal(calls.length, 2);
});

test("an answer without citations succeeds with empty results", async () => {
  const { fetch } = recordingFetch(() =>
    jsonResponse({
      output: [{ type: "message", content: [{ type: "output_text", text: "No sources needed." }] }],
    }),
  );
  const { scope } = setup(fetch);
  const response = await search({ query: "fixture", provider: "xai" }, { scope });
  assert.equal(response.answer, "No sources needed.");
  assert.deepEqual(response.results, []);
});

test("HTTP failures map to typed errors without leaking credentials", async () => {
  const cases: Array<[number, SearchErrorKind, boolean]> = [
    [401, "auth", false],
    [403, "auth", false],
    [429, "quota", true],
    [503, "transient", true],
    [400, "invalid-request", false],
  ];
  for (const [status, kind, retryable] of cases) {
    const { fetch } = recordingFetch(
      () => new Response(`{"error":"bad key ${API_KEY}"}`, { status }),
    );
    const { scope } = setup(fetch);
    const error = await expectSearchError(
      search({ query: "fixture", provider: "xai" }, { scope }),
      kind,
    );
    assert.equal(error.status, status);
    assert.equal(error.retryable, retryable);
    assert.equal(error.family, "xai");
    assert.match(error.message, /\[redacted\]/);
    assert.equal(JSON.stringify(error.attempts).includes(API_KEY), false);
  }
});

test("malformed bodies and empty outputs are invalid responses", async () => {
  for (const body of [
    "not json",
    JSON.stringify({ output: "nope" }),
    JSON.stringify({ output: [] }),
  ]) {
    const { fetch } = recordingFetch(() => new Response(body, { status: 200 }));
    const { scope } = setup(fetch);
    await expectSearchError(
      search({ query: "fixture", provider: "xai" }, { scope }),
      "invalid-response",
    );
  }
});

test("network failures are retryable network errors", async () => {
  const fetch: XaiFetch = async () => {
    throw new TypeError(`fetch failed for ${API_KEY}`);
  };
  const { scope } = setup(fetch);
  const error = await expectSearchError(
    search({ query: "fixture", provider: "xai" }, { scope }),
    "network",
  );
  assert.equal(error.retryable, true);
});

test("credential resolution failures are auth errors", async () => {
  const { calls, fetch } = recordingFetch(() => jsonResponse(citedResponse()));
  const { scope } = setup(fetch, { auth: { ok: false, error: "token expired" } });
  await expectSearchError(search({ query: "fixture", provider: "xai" }, { scope }), "auth");
  assert.equal(calls.length, 0);
});

function hangingFetch() {
  let observed: AbortSignal | undefined;
  const fetch: XaiFetch = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      observed = init.signal ?? undefined;
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  return { fetch, signal: () => observed };
}

test("caller cancellation aborts the in-flight request", async () => {
  const hanging = hangingFetch();
  const { scope } = setup(hanging.fetch);
  const controller = new AbortController();
  const pending = search(
    { query: "fixture", provider: "xai" },
    { scope, signal: controller.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await expectSearchError(pending, "cancelled");
  assert.equal(hanging.signal()?.aborted, true);
});

test("adapter timeout yields a retryable attempt deadline", async () => {
  const hanging = hangingFetch();
  const { scope } = setup(hanging.fetch, {}, 10);
  const error = await expectSearchError(
    search({ query: "fixture", provider: "xai" }, { scope }),
    "deadline",
  );
  assert.equal(error.deadlineKind, "attempt");
  assert.equal(hanging.signal()?.aborted, true);
});

test("a session change during the request is stale-context", async () => {
  const hanging = hangingFetch();
  const { scope, manager } = setup(hanging.fetch);
  const pending = search({ query: "fixture", provider: "xai" }, { scope });
  await new Promise((resolve) => setTimeout(resolve, 5));
  invalidateSearchSession(scope, manager);
  await expectSearchError(pending, "stale-context");
  assert.equal(hanging.signal()?.aborted, true);
});

test("explicit xai selection routes to the adapter even when earlier families are available", async () => {
  const { calls, fetch } = recordingFetch(() => jsonResponse(citedResponse()));
  const { scope } = setup(fetch);
  let openaiCalls = 0;
  registerSearchAdapter(scope, {
    id: "fixture.openai",
    family: "openai",
    transport: "fixture",
    capabilities: { actions: ["search"] },
    availability: () => ({ status: "available" }),
    execute: async () => {
      openaiCalls += 1;
      return { answer: "openai", results: [] };
    },
  });
  const auto = await search({ query: "fixture" }, { scope });
  assert.equal(auto.provider, "openai");
  assert.equal(calls.length, 0);

  const explicit = await search({ query: "fixture", provider: "xai" }, { scope });
  assert.equal(explicit.provider, "xai");
  assert.equal(explicit.adapterId, XAI_SEARCH_ADAPTER_ID);
  assert.equal(openaiCalls, 1);
  assert.equal(calls.length, 1);
});

test("auto and all never route to xai even when it is the only available adapter", async () => {
  const { calls, fetch } = recordingFetch(() => jsonResponse(citedResponse()));
  const { scope } = setup(fetch);
  // Unregistered families make auto report the router's existing route-miss error.
  const autoError = await expectSearchError(search({ query: "fixture" }, { scope }), "capability");
  assert.deepEqual(
    autoError.attempts?.map(({ adapterId, outcome, reason }) => ({ adapterId, outcome, reason })),
    [{ adapterId: XAI_SEARCH_ADAPTER_ID, outcome: "disabled", reason: "explicit selection only" }],
  );
  await expectSearchError(search({ query: "fixture", provider: "all" }, { scope }), "config");
  assert.equal(calls.length, 0);
});

test("registration gate follows the configured auth status and never reads credentials", () => {
  const scope = createSearchScope();
  const gate = createXaiRegistrationGate(scope);
  let configured = false;
  let credentialReads = 0;
  const registry = {
    getProviderAuthStatus: (provider: string) => ({ configured: provider === "xai" && configured }),
    getApiKeyForProvider: async () => {
      credentialReads += 1;
      return API_KEY;
    },
  };
  assert.equal(gate.sync(registry), false);
  assert.equal(scope.adapters.has(XAI_SEARCH_ADAPTER_ID), false);
  configured = true;
  assert.equal(gate.sync(registry), true);
  assert.equal(gate.sync(registry), true);
  assert.equal(scope.adapters.get(XAI_SEARCH_ADAPTER_ID)?.explicitOnly, true);
  configured = false;
  assert.equal(gate.sync(registry), false);
  assert.equal(scope.adapters.has(XAI_SEARCH_ADAPTER_ID), false);
  assert.equal(gate.sync(undefined), false);
  const throwing = {
    getProviderAuthStatus: (): { configured: boolean } => {
      throw new Error("registry unavailable");
    },
  };
  configured = true;
  gate.sync(registry);
  assert.equal(gate.sync(throwing), false);
  assert.equal(scope.adapters.has(XAI_SEARCH_ADAPTER_ID), false);
  gate.sync(registry);
  gate.dispose();
  assert.equal(scope.adapters.has(XAI_SEARCH_ADAPTER_ID), false);
  assert.equal(credentialReads, 0);
});

test("the extension entry registers only while xai is configured", async () => {
  const bus = createEventBus();
  let scope: SearchScope | undefined;
  const extension = await loadExtensionFromFactory(
    xaiSearchExtension,
    "/tmp/choco-pi-xai-search-test",
    bus,
    createExtensionRuntime(),
    "<inline:xai-search>",
  );
  await loadExtensionFromFactory(
    (pi) => {
      scope = getSearchScope(pi.events);
    },
    "/tmp/choco-pi-xai-search-test",
    bus,
    createExtensionRuntime(),
    "<inline:observer>",
  );
  assert.ok(scope);
  assert.equal(scope.adapters.has(XAI_SEARCH_ADAPTER_ID), false);

  let configured = false;
  const ctx = {
    modelRegistry: {
      getProviderAuthStatus: (provider: string) => ({
        configured: provider === "xai" && configured,
      }),
    },
  };
  const emit = async (event: string) => {
    for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event }, ctx);
  };
  await emit("session_start");
  assert.equal(scope.adapters.has(XAI_SEARCH_ADAPTER_ID), false);
  configured = true;
  await emit("model_select");
  assert.equal(scope.adapters.get(XAI_SEARCH_ADAPTER_ID)?.family, "xai");
  configured = false;
  await emit("session_tree");
  assert.equal(scope.adapters.has(XAI_SEARCH_ADAPTER_ID), false);
  configured = true;
  await emit("session_start");
  assert.equal(scope.adapters.has(XAI_SEARCH_ADAPTER_ID), true);
  await emit("session_shutdown");
  assert.equal(scope.adapters.has(XAI_SEARCH_ADAPTER_ID), false);
});
