import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { arr, compile, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import {
  bindSearchSession,
  createSearchScope,
  invalidateSearchSession,
  isSearchError,
  registerSearchAdapter,
  search,
  type SearchError,
  type SearchErrorKind,
  type SearchScope,
} from "../../choco-pi-web-search/index.ts";
import type { FetchLike } from "../src/client/http.ts";
import { ANTIGRAVITY_ERROR_KINDS, AntigravityError } from "../src/errors.ts";
import {
  createGoogleSearchAdapter,
  GOOGLE_SEARCH_ADAPTER_ID,
  searchErrorFromAntigravity,
  type GoogleSearchAdapterOptions,
  type GoogleSearchRegistry,
} from "../src/search/adapter.ts";
import { FALLBACK_WEB_SEARCH_MODEL_ID } from "../src/search/request.ts";
import {
  fakeFetch,
  fixture,
  json,
  signInRegistry,
  type GoogleSignIn,
  type Route,
} from "./helpers.ts";

const TOKEN = "fake-access-token-value";
const API_KEY = JSON.stringify({ token: TOKEN, project_id: "aicode-consumers" });
const GEMINI_KEY = "AIzaFAKE-gemini-api-key-for-tests";
const ENDPOINTS = ["https://primary.invalid", "https://secondary.invalid"];
const NOW = Date.parse("2026-11-22T00:00:00.000Z");

interface FakeRegistry extends GoogleSearchRegistry {
  credentialReads: number;
}

function fakeRegistry(
  configured = true,
  apiKey: string | null = API_KEY,
  signIn: GoogleSignIn = configured ? "oauth" : "none",
): FakeRegistry {
  const registry: FakeRegistry = {
    ...signInRegistry(() => signIn),
    credentialReads: 0,
    getApiKeyForProvider: async (provider) => {
      registry.credentialReads += 1;
      return provider === "google" && apiKey !== null ? apiKey : undefined;
    },
  };
  return registry;
}

interface Harness {
  scope: SearchScope;
  manager: SessionManager;
  registry: FakeRegistry;
}

function setup(
  fetch: FetchLike,
  registry = fakeRegistry(),
  extra: GoogleSearchAdapterOptions = {},
): Harness {
  const scope = createSearchScope();
  const manager = SessionManager.inMemory("/tmp/choco-pi-google-search-test");
  bindSearchSession(scope, manager);
  registerSearchAdapter(
    scope,
    createGoogleSearchAdapter({
      fetch,
      endpoints: ENDPOINTS,
      now: () => NOW,
      getModelIds: () => [],
      getRegistry: () => registry,
      ...extra,
    }),
  );
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
      assert.equal(cause.message.includes(TOKEN), false);
      return cause;
    }
  }
  assert.fail(`expected SearchError(${kind})`);
}

const BodySchema = obj(
  {
    project: str(),
    requestId: str(),
    model: str(),
    userAgent: str(),
    requestType: str(),
    request: obj(
      {
        contents: arr(obj({ role: str(), parts: arr(obj({ text: str() })) })),
        tools: arr(obj({ googleSearch: obj({}, { open: true }) })),
        generationConfig: obj({}, { open: true }),
      },
      { open: true },
    ),
    sessionId: opt(unknown()),
  },
  { open: true },
);
const parseBody = (body: string) => {
  const value: unknown = JSON.parse(body);
  assert.ok(compile(BodySchema).check(value), "request body shape");
  return value;
};

const groundingRoute: Route = async () =>
  json(200, await fixture("search/grounding-response.json"));

test("the adapter declares an explicit-only subscription google family without URL support", () => {
  const adapter = createGoogleSearchAdapter({ getRegistry: () => undefined });
  assert.equal(adapter.id, GOOGLE_SEARCH_ADAPTER_ID);
  assert.equal(adapter.family, "google");
  assert.equal(adapter.transport, "v1internal-generate-content");
  assert.equal(adapter.explicitOnly, true);
  assert.equal(adapter.billing, "subscription");
  assert.deepEqual(adapter.capabilities, {
    actions: ["search"],
    constraints: {
      numResults: true,
      domainFilter: true,
      domainExclusions: true,
      recencyFilter: true,
      recencyDays: true,
    },
  });
});

test("a signed-out provider is unavailable with no credential read and no network", async () => {
  const fake = fakeFetch(groundingRoute);
  const { scope, registry } = setup(fake.fetch, fakeRegistry(false));
  const error = await expectSearchError(
    search({ query: "fixture", provider: "google" }, { scope }),
    "capability",
  );
  assert.deepEqual(
    error.attempts?.map(({ adapterId, outcome }) => ({ adapterId, outcome })),
    [{ adapterId: GOOGLE_SEARCH_ADAPTER_ID, outcome: "unavailable" }],
  );
  assert.match(error.attempts?.[0]?.reason ?? "", /not signed in/);
  assert.equal(registry.credentialReads, 0);
  assert.equal(fake.calls.length, 0);
});

test("a Gemini API key configuring google leaves the adapter unconfigured", async () => {
  for (const signIn of ["stored_api_key", "env_api_key"] as const) {
    const fake = fakeFetch(groundingRoute);
    const { scope, registry } = setup(fake.fetch, fakeRegistry(true, GEMINI_KEY, signIn));
    const error = await expectSearchError(
      search({ query: "fixture", provider: "google" }, { scope }),
      "capability",
    );
    assert.deepEqual(
      error.attempts?.map(({ adapterId, outcome }) => ({ adapterId, outcome })),
      [{ adapterId: GOOGLE_SEARCH_ADAPTER_ID, outcome: "unavailable" }],
      signIn,
    );
    assert.match(error.attempts?.[0]?.reason ?? "", /Google Antigravity OAuth/u);
    assert.match(
      error.attempts?.[0]?.reason ?? "",
      /\/login google and choose Google Antigravity/u,
    );
    assert.equal(registry.credentialReads, 0, signIn);
    assert.equal(fake.calls.length, 0, signIn);
  }
});

test("a missing host registry is unavailable", async () => {
  const scope = createSearchScope();
  bindSearchSession(scope, SessionManager.inMemory("/tmp/choco-pi-google-search-test"));
  registerSearchAdapter(scope, createGoogleSearchAdapter({ getRegistry: () => undefined }));
  const error = await expectSearchError(
    search({ query: "fixture", provider: "google" }, { scope }),
    "capability",
  );
  assert.match(error.attempts?.[0]?.reason ?? "", /model registry/);
});

test("auto and all skip the explicit-only adapter; provider google and routing select it", async () => {
  const fake = fakeFetch(groundingRoute);
  const { scope, registry } = setup(fake.fetch);
  const autoError = await expectSearchError(search({ query: "fixture" }, { scope }), "capability");
  assert.deepEqual(
    autoError.attempts?.map(({ adapterId, outcome, reason }) => ({ adapterId, outcome, reason })),
    [
      {
        adapterId: GOOGLE_SEARCH_ADAPTER_ID,
        outcome: "disabled",
        reason: "explicit selection only",
      },
    ],
  );
  await expectSearchError(search({ query: "fixture", provider: "all" }, { scope }), "config");
  assert.equal(fake.calls.length, 0);
  assert.equal(registry.credentialReads, 0);

  const explicit = await search({ query: "fixture", provider: "google" }, { scope });
  assert.equal(explicit.provider, "google");
  assert.equal(explicit.adapterId, GOOGLE_SEARCH_ADAPTER_ID);
  assert.equal(explicit.billing, "subscription");
  const routed = await search({ query: "fixture" }, { scope, routing: { providers: ["google"] } });
  assert.equal(routed.provider, "google");
  assert.equal(fake.calls.length, 2);
});

test("the grounding fixture becomes cited results through one generateContent call", async () => {
  const fake = fakeFetch(groundingRoute);
  const { scope } = setup(fake.fetch);
  const response = await search(
    { query: "what is google antigravity", provider: "google" },
    { scope },
  );

  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.ok(call);
  assert.equal(call.url, "https://primary.invalid/v1internal:generateContent");
  assert.equal(call.headers.get("authorization"), `Bearer ${TOKEN}`);
  const body = parseBody(call.body);
  assert.equal(body.project, "aicode-consumers");
  assert.equal(body.model, FALLBACK_WEB_SEARCH_MODEL_ID);
  assert.equal(body.userAgent, "antigravity");
  assert.equal(body.requestType, "agent");
  assert.equal(body.sessionId, undefined);
  assert.equal("labels" in body.request, false);
  assert.deepEqual(body.request.tools, [{ googleSearch: {} }]);
  assert.match(body.request.contents[0]?.parts[0]?.text ?? "", /Query: what is google antigravity/);

  const redirectA =
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/FAKE-REDIRECT-A";
  const redirectB =
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/FAKE-REDIRECT-B";
  assert.deepEqual(response.results, [
    {
      title: "antigravity.example",
      url: redirectA,
      snippet:
        "Antigravity is a Google agent IDE. It runs Gemini models through Cloud Code Assist.",
    },
    {
      title: "Cloud Code Assist overview",
      url: redirectB,
      snippet: "It runs Gemini models through Cloud Code Assist.",
    },
  ]);
  assert.equal(
    response.answer,
    [
      "Antigravity is a Google agent IDE.[1] It runs Gemini models through Cloud Code Assist.[2][1]",
      "",
      "Sources:",
      `[1] antigravity.example: ${redirectA}`,
      `[2] Cloud Code Assist overview: ${redirectB}`,
    ].join("\n"),
  );
  assert.doesNotMatch(response.answer, /Planning the search/);
  assert.deepEqual(response.native, {
    backend: GOOGLE_SEARCH_ADAPTER_ID,
    providerFamily: "google",
    model: FALLBACK_WEB_SEARCH_MODEL_ID,
    webSearchQueries: ["what is google antigravity"],
    citations: [
      { text: "Antigravity is a Google agent IDE.", sources: [1] },
      { text: "It runs Gemini models through Cloud Code Assist.", sources: [2, 1] },
    ],
  });
  assert.deepEqual(response.warnings ?? [], []);
});

test("catalog web-search model ids, filters and numResults shape the request and response", async () => {
  const fake = fakeFetch(groundingRoute);
  const { scope } = setup(fake.fetch, fakeRegistry(), {
    getModelIds: () => ["gemini-9-search-lite"],
  });
  const response = await search(
    {
      queries: ["first", "second"],
      provider: "google",
      domainFilter: ["Example.com", "-spam.example", "example.com"],
      recencyFilter: "week",
      numResults: 1,
    },
    { scope },
  );
  const body = parseBody(fake.calls[0]?.body ?? "");
  assert.equal(body.model, "gemini-9-search-lite");
  assert.deepEqual(body.request.tools, [
    {
      googleSearch: {
        includedDomains: ["example.com"],
        excludeDomains: ["spam.example"],
        timeRangeFilter: {
          startTime: "2026-11-15T00:00:00.000Z",
          endTime: "2026-11-22T00:00:00.000Z",
        },
      },
    },
  ]);
  assert.match(body.request.contents[0]?.parts[0]?.text ?? "", /- first\n- second/);
  assert.equal(response.results.length, 1);
  assert.deepEqual(response.warnings, ["Google returned 2 sources; limited to 1."]);

  await search({ query: "q", provider: "google", recencyDays: 3 }, { scope });
  const recency = parseBody(fake.calls[1]?.body ?? "");
  assert.deepEqual(recency.request.tools, [
    {
      googleSearch: {
        timeRangeFilter: {
          startTime: "2026-11-19T00:00:00.000Z",
          endTime: "2026-11-22T00:00:00.000Z",
        },
      },
    },
  ]);
});

test("an ungrounded answer is returned with a warning; empty or blocked responses fail", async () => {
  let payload = JSON.stringify({
    response: {
      candidates: [{ content: { parts: [{ text: "plain answer" }] }, finishReason: "MAX_TOKENS" }],
    },
  });
  const fake = fakeFetch(() => json(200, payload));
  const { scope } = setup(fake.fetch);
  const ungrounded = await search({ query: "q", provider: "google" }, { scope });
  assert.equal(ungrounded.answer, "plain answer");
  assert.deepEqual(ungrounded.results, []);
  assert.equal(ungrounded.warnings?.length, 2);

  payload = JSON.stringify({ response: { promptFeedback: { blockReason: "SAFETY" } } });
  const blocked = await expectSearchError(
    search({ query: "q", provider: "google" }, { scope }),
    "invalid-response",
  );
  assert.match(blocked.message, /blocked \(SAFETY\)/);
  assert.equal(blocked.retryable, false);

  payload = JSON.stringify({ response: { candidates: [{ finishReason: "SAFETY" }] } });
  const empty = await expectSearchError(
    search({ query: "q", provider: "google" }, { scope }),
    "invalid-response",
  );
  assert.equal(empty.retryable, true);

  payload = JSON.stringify({ unexpected: true });
  await expectSearchError(
    search({ query: "q", provider: "google" }, { scope }),
    "invalid-response",
  );
});

test("every Antigravity error kind maps to a router kind and retry policy", () => {
  const expected = {
    quota_exhausted: ["quota", false],
    credits_exhausted: ["quota", false],
    rate_limited: ["quota", true],
    capacity: ["transient", true],
    server: ["transient", true],
    network: ["network", true],
    auth: ["auth", false],
    permission: ["entitlement", false],
    validation_required: ["entitlement", false],
    unsupported_client: ["entitlement", false],
    model_unavailable: ["entitlement", false],
    invalid_request: ["invalid-request", false],
    context_overflow: ["invalid-request", false],
    malformed_response: ["invalid-response", true],
  } as const;
  for (const kind of ANTIGRAVITY_ERROR_KINDS) {
    const mapped = searchErrorFromAntigravity(new AntigravityError({ kind, status: 400 }));
    assert.deepEqual([mapped.kind, mapped.retryable], [...expected[kind]], kind);
    assert.equal(mapped.family, "google");
    assert.equal(mapped.adapterId, GOOGLE_SEARCH_ADAPTER_ID);
    assert.equal(mapped.status, 400);
  }
});

test("HTTP failures map through the shared client without leaking the token", async () => {
  let status = 401;
  const fake = fakeFetch(() =>
    json(
      status,
      JSON.stringify({
        error: { code: status, message: `denied Bearer ${TOKEN}`, status: "UNAUTHENTICATED" },
      }),
    ),
  );
  const { scope } = setup(fake.fetch);
  await expectSearchError(search({ query: "q", provider: "google" }, { scope }), "auth");
  assert.equal(fake.calls.length, 1);

  status = 503;
  fake.calls.length = 0;
  const transient = await expectSearchError(
    search({ query: "q", provider: "google" }, { scope }),
    "transient",
  );
  assert.equal(transient.retryable, true);
  assert.deepEqual(
    fake.calls.map(({ url }) => new URL(url).host),
    ["primary.invalid", "secondary.invalid"],
  );
});

test("a missing or malformed credential is an auth error before any request", async () => {
  const fake = fakeFetch(groundingRoute);
  const missing = setup(fake.fetch, fakeRegistry(true, null));
  await expectSearchError(
    search({ query: "q", provider: "google" }, { scope: missing.scope }),
    "auth",
  );
  const malformed = setup(fake.fetch, fakeRegistry(true, "not-json"));
  const error = await expectSearchError(
    search({ query: "q", provider: "google" }, { scope: malformed.scope }),
    "auth",
  );
  assert.doesNotMatch(error.message, /not-json/);
  const raw = setup(fake.fetch, fakeRegistry(true, GEMINI_KEY, "oauth"));
  const rawError = await expectSearchError(
    search({ query: "q", provider: "google" }, { scope: raw.scope }),
    "auth",
  );
  assert.doesNotMatch(rawError.message, /AIza/u);
  assert.match(rawError.message, /\/login google and choose Google Antigravity/u);
  assert.equal(fake.calls.length, 0);
});

function hangingFetch() {
  let observed: AbortSignal | undefined;
  const fetch: FetchLike = (_url, init) =>
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
  const pending = search({ query: "q", provider: "google" }, { scope, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await expectSearchError(pending, "cancelled");
  assert.equal(hanging.signal()?.aborted, true);
});

test("a session change during the request is stale-context", async () => {
  const hanging = hangingFetch();
  const { scope, manager } = setup(hanging.fetch);
  const pending = search({ query: "q", provider: "google" }, { scope });
  await new Promise((resolve) => setTimeout(resolve, 5));
  invalidateSearchSession(scope, manager);
  await expectSearchError(pending, "stale-context");
  assert.equal(hanging.signal()?.aborted, true);
});

test("the adapter attempt timeout surfaces as a retryable network error", async () => {
  const hanging = hangingFetch();
  const { scope } = setup(hanging.fetch, fakeRegistry(), {
    timeoutMs: 10,
    endpoints: [ENDPOINTS[0] ?? ""],
  });
  const error = await expectSearchError(
    search({ query: "q", provider: "google" }, { scope }),
    "network",
  );
  assert.equal(error.retryable, true);
});
