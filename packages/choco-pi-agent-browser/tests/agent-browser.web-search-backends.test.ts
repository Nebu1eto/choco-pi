import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { registerAgentBrowserExtension } from "../extensions/agent-browser/index.ts";
import { loadAgentBrowserConfig } from "../extensions/agent-browser/lib/config.ts";
import { hasRuntimeType, isRecord } from "../extensions/agent-browser/lib/parsing.ts";
import {
  AgentBrowserSearchError,
  WebSearchRequestGate,
  executeAgentBrowserSearchBackend,
  fetchExaSearchJson,
  getAgentBrowserSearchBackendAvailability,
} from "../extensions/agent-browser/lib/web-search.ts";
import unifiedSearchCore from "../../choco-pi-web-search/extension.ts";
import { registeredCanonicalSearchFrontend } from "../../choco-pi-web-search/tests/fixtures/registered-canonical-tool.ts";
import { bindSearchSession, getSearchScope, search } from "../../choco-pi-web-search/index.ts";

async function configWithEnv(env: NodeJS.ProcessEnv) {
  return loadAgentBrowserConfig({
    cwd: "/tmp/choco-pi-agent-browser-search-test/project",
    env: { HOME: "/tmp/choco-pi-agent-browser-search-test/home", ...env },
  });
}

const baseRequest = {
  count: 3,
  offset: 2,
  query: "typed web search",
} as const;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("availability distinguishes disabled, config errors, and missing credentials without resolving commands", async () => {
  const missing = await configWithEnv({});
  assert.equal(getAgentBrowserSearchBackendAvailability(missing, "brave").status, "unavailable");

  const available = await configWithEnv({ BRAVE_API_KEY: "fixture-secret" });
  assert.equal(getAgentBrowserSearchBackendAvailability(available, "brave").status, "available");

  const disabled = {
    ...available,
    webSearchEnabled: false,
  };
  assert.equal(getAgentBrowserSearchBackendAvailability(disabled, "brave").status, "disabled");

  const invalid = { ...available, errors: ["fixture config error"] };
  const invalidAvailability = getAgentBrowserSearchBackendAvailability(invalid, "brave");
  assert.equal(invalidAvailability.status, "error");
  assert.match(invalidAvailability.reason, /fixture config error/);
});

test("Brave backend forwards locale, pagination, safety, and freshness through production fetch", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let capturedUrl: URL | undefined;
  let capturedInit: RequestInit | undefined;
  const fixtureFetch: typeof fetch = async (input, init) => {
    capturedUrl = new URL(input instanceof Request ? input.url : input.toString());
    capturedInit = init;
    return new Response(
      JSON.stringify({
        query: { altered: "typed search" },
        web: {
          results: [
            {
              age: "2 hours ago",
              description: "A <b>fixture</b> result",
              language: "en",
              profile: { name: "Fixture Source" },
              title: "Fixture result",
              url: "https://example.test/result",
            },
          ],
        },
      }),
      { headers: { "content-type": "application/json" }, status: 200 },
    );
  };
  globalThis.fetch = fixtureFetch;

  const response = await executeAgentBrowserSearchBackend({
    configState: await configWithEnv({ BRAVE_API_KEY: "fixture-secret" }),
    env: { BRAVE_API_KEY: "fixture-secret" },
    provider: "brave",
    request: {
      ...baseRequest,
      country: "us",
      freshness: "pw",
      safesearch: "strict",
      searchLang: "en-US",
    },
    requestGate: new WebSearchRequestGate(),
  });

  assert.equal(capturedUrl?.searchParams.get("count"), "3");
  assert.equal(capturedUrl?.searchParams.get("offset"), "2");
  assert.equal(capturedUrl?.searchParams.get("country"), "US");
  assert.equal(capturedUrl?.searchParams.get("search_lang"), "en-US");
  assert.equal(capturedUrl?.searchParams.get("safesearch"), "strict");
  assert.equal(capturedUrl?.searchParams.get("freshness"), "pw");
  assert.equal(new Headers(capturedInit?.headers).get("X-Subscription-Token"), "fixture-secret");
  assert.equal(response.provider, "brave");
  assert.equal(response.returnedQuery, "typed search");
  assert.deepEqual(response.results[0], {
    age: "2 hours ago",
    description: "A fixture result",
    language: "en",
    source: "Fixture Source",
    title: "Fixture result",
    url: "https://example.test/result",
  });
});

test("Exa backend forwards advanced type and constraints once", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requestCount = 0;
  let capturedBody = "";
  const fixtureFetch: typeof fetch = async (_input, init) => {
    requestCount += 1;
    capturedBody = hasRuntimeType(init?.body, "string") ? init.body : "";
    return new Response(
      JSON.stringify({
        requestId: "fixture-request",
        searchType: "deep",
        results: [
          { title: "Skipped", url: "https://example.test/0" },
          { title: "Selected", url: "https://example.test/1", highlights: ["Useful"] },
        ],
      }),
      { status: 200 },
    );
  };
  globalThis.fetch = fixtureFetch;

  const response = await executeAgentBrowserSearchBackend({
    configState: await configWithEnv({ EXA_API_KEY: "fixture-secret" }),
    env: { EXA_API_KEY: "fixture-secret" },
    provider: "exa",
    request: {
      ...baseRequest,
      count: 1,
      offset: 1,
      country: "gb",
      freshness: "pd",
      safesearch: "moderate",
      searchType: "deep",
    },
    requestGate: new WebSearchRequestGate(),
  });

  const body: unknown = JSON.parse(capturedBody);
  assert.ok(isRecord(body));
  assert.deepEqual(body.contents, { highlights: true });
  assert.equal(body.moderation, true);
  assert.equal(body.numResults, 2);
  assert.equal(body.query, "typed web search");
  assert.equal(hasRuntimeType(body.startPublishedDate, "string"), true);
  assert.equal(body.type, "deep");
  assert.equal(body.userLocation, "GB");
  assert.equal(requestCount, 1);
  assert.equal(response.extraDetails?.requestId, "fixture-request");
  assert.equal(response.results[0]?.title, "Selected");
});

test("unsupported hard constraints are typed invalid requests", async () => {
  await assert.rejects(
    executeAgentBrowserSearchBackend({
      configState: await configWithEnv({ EXA_API_KEY: "fixture-secret" }),
      env: { EXA_API_KEY: "fixture-secret" },
      provider: "exa",
      request: { ...baseRequest, searchLang: "en" },
      requestGate: new WebSearchRequestGate(),
    }),
    (error: Error) => error instanceof AgentBrowserSearchError && error.kind === "invalid-request",
  );
});

test("HTTP, invalid JSON, and network failures have typed categories without retries", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const configState = await configWithEnv({ BRAVE_API_KEY: "fixture-secret" });

  async function expectFailure(options: {
    expectedKind: AgentBrowserSearchError["kind"];
    expectedRetryable: boolean;
    expectedStatus?: number;
    fixture: () => Promise<Response>;
  }): Promise<void> {
    let requestCount = 0;
    const fixtureFetch: typeof fetch = async () => {
      requestCount += 1;
      return options.fixture();
    };
    globalThis.fetch = fixtureFetch;
    await assert.rejects(
      executeAgentBrowserSearchBackend({
        configState,
        env: { BRAVE_API_KEY: "fixture-secret" },
        provider: "brave",
        request: baseRequest,
        requestGate: new WebSearchRequestGate(),
      }),
      (error: Error) => {
        assert.ok(error instanceof AgentBrowserSearchError);
        assert.equal(error.kind, options.expectedKind);
        assert.equal(error.retryable, options.expectedRetryable);
        assert.equal(error.status, options.expectedStatus);
        assert.doesNotMatch(error.message, /fixture-secret/);
        return true;
      },
    );
    assert.equal(requestCount, 1);
  }

  await expectFailure({
    expectedKind: "transient",
    expectedRetryable: true,
    expectedStatus: 500,
    fixture: async () => new Response("upstream failed", { status: 500 }),
  });
  await expectFailure({
    expectedKind: "auth",
    expectedRetryable: false,
    expectedStatus: 401,
    fixture: async () => new Response("fixture-secret rejected", { status: 401 }),
  });
  await expectFailure({
    expectedKind: "quota",
    expectedRetryable: false,
    expectedStatus: 429,
    fixture: async () => new Response("fixture-secret exhausted", { status: 429 }),
  });
  await expectFailure({
    expectedKind: "invalid-request",
    expectedRetryable: false,
    expectedStatus: 400,
    fixture: async () => new Response("bad request", { status: 400 }),
  });
  await expectFailure({
    expectedKind: "invalid-response",
    expectedRetryable: true,
    fixture: async () => new Response("not-json", { status: 200 }),
  });
  await expectFailure({
    expectedKind: "network",
    expectedRetryable: true,
    fixture: async () => {
      throw new TypeError("fixture-secret socket failure");
    },
  });
});

test("internal timeout is typed as a deadline when fetch ignores abort", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requestCount = 0;
  const fixtureFetch: typeof fetch = async () => {
    requestCount += 1;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  globalThis.fetch = fixtureFetch;

  await assert.rejects(
    fetchExaSearchJson(
      { contents: { highlights: true }, numResults: 1, query: "timeout", type: "auto" },
      "fixture-secret",
      undefined,
      1,
    ),
    (error: Error) => {
      assert.ok(error instanceof AgentBrowserSearchError);
      assert.equal(error.kind, "deadline");
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    },
  );
  assert.equal(requestCount, 1);
});

test("request gate serializes work and cancellation or stale generations stop execution", async () => {
  const starts: number[] = [];
  let clock = 1_100;
  const gate = new WebSearchRequestGate(
    () => clock,
    async (milliseconds) => {
      clock += milliseconds;
    },
  );
  await Promise.all([
    gate.run(undefined, async () => {
      starts.push(clock);
    }),
    gate.run(undefined, async () => {
      starts.push(clock);
    }),
  ]);
  assert.deepEqual(starts, [1_100, 2_200]);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executeAgentBrowserSearchBackend({
      configState: await configWithEnv({ BRAVE_API_KEY: "fixture-secret" }),
      env: { BRAVE_API_KEY: "fixture-secret" },
      provider: "brave",
      request: baseRequest,
      requestGate: new WebSearchRequestGate(),
      signal: controller.signal,
    }),
    (error: Error) => error instanceof AgentBrowserSearchError && error.kind === "cancelled",
  );

  await assert.rejects(
    executeAgentBrowserSearchBackend({
      configState: await configWithEnv({ BRAVE_API_KEY: "fixture-secret" }),
      env: { BRAVE_API_KEY: "fixture-secret" },
      guard: { generation: 1, isCurrent: () => false },
      provider: "brave",
      request: baseRequest,
      requestGate: new WebSearchRequestGate(),
    }),
    (error: Error) => error instanceof AgentBrowserSearchError && error.kind === "stale-context",
  );
});

test("aborting a queued backend request never starts its fetch", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const firstFetchStarted = deferred();
  const releaseFirstFetch = deferred();
  let requestCount = 0;
  const fixtureFetch: typeof fetch = async () => {
    requestCount += 1;
    firstFetchStarted.resolve();
    await releaseFirstFetch.promise;
    return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
  };
  globalThis.fetch = fixtureFetch;
  const configState = await configWithEnv({ BRAVE_API_KEY: "fixture-secret" });
  const requestGate = new WebSearchRequestGate();
  const first = executeAgentBrowserSearchBackend({
    configState,
    env: { BRAVE_API_KEY: "fixture-secret" },
    provider: "brave",
    request: baseRequest,
    requestGate,
  });
  await firstFetchStarted.promise;

  const controller = new AbortController();
  const queued = executeAgentBrowserSearchBackend({
    configState,
    env: { BRAVE_API_KEY: "fixture-secret" },
    provider: "brave",
    request: baseRequest,
    requestGate,
    signal: controller.signal,
  });
  controller.abort();
  releaseFirstFetch.resolve();
  await first;
  await assert.rejects(
    queued,
    (error: Error) => error instanceof AgentBrowserSearchError && error.kind === "cancelled",
  );
  assert.equal(requestCount, 1);
});

test("real Pi wrappers isolate adapter scopes and suppress standalone discovery in canonical mode", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "choco-pi-agent-browser-search-"));
  t.after(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });
  const configState = await configWithEnv({
    BRAVE_API_KEY: "fixture-brave",
    EXA_API_KEY: "fixture-exa",
  });
  const integratedBus = createEventBus();
  const integratedLoader = new DefaultResourceLoader({
    agentDir: join(fixtureRoot, "integrated-agent"),
    cwd: join(fixtureRoot, "integrated-project"),
    eventBus: integratedBus,
    extensionFactories: [
      { factory: unifiedSearchCore, name: "canonical-search" },
      { factory: registeredCanonicalSearchFrontend, name: "canonical-search-frontend" },
      {
        factory: (pi) =>
          registerAgentBrowserExtension(pi, {
            initialConfigState: configState,
            loadSearchConfigState: async () => configState,
          }),
        name: "integrated-agent-browser",
      },
    ],
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager: SettingsManager.inMemory(),
  });
  await integratedLoader.reload();
  const integratedResult = integratedLoader.getExtensions();
  assert.deepEqual(integratedResult.errors, []);
  const integratedExtension = integratedResult.extensions.find(
    (extension) => extension.path === "<inline:integrated-agent-browser>",
  );
  assert.ok(integratedExtension);
  assert.equal(integratedExtension.tools.has("agent_browser"), true);
  assert.equal(integratedExtension.tools.has("agent_browser_web_search"), false);
  const integratedGuidelines =
    integratedExtension.tools.get("agent_browser")?.definition.promptGuidelines?.join("\n") ?? "";
  const expectedReadmePath = join(dirname(dirname(fileURLToPath(import.meta.url))), "README.md");
  assert.equal(integratedGuidelines.includes(expectedReadmePath), true);
  assert.match(integratedGuidelines, /web_search/);
  assert.doesNotMatch(integratedGuidelines, /agent_browser_web_search/);
  const integratedScope = getSearchScope(integratedBus);
  assert.deepEqual([...integratedScope.adapters.keys()].sort(), [
    "agent-browser.brave",
    "agent-browser.exa",
  ]);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let capturedUrl: URL | undefined;
  const fixtureFetch: typeof fetch = async (input) => {
    capturedUrl = new URL(input instanceof Request ? input.url : input.toString());
    return new Response(
      JSON.stringify({
        web: {
          results: [
            {
              description: "Canonical snippet",
              language: "en",
              profile: { name: "Canonical Source" },
              title: "Canonical result",
              url: "https://example.test/canonical",
            },
          ],
        },
      }),
      { status: 200 },
    );
  };
  globalThis.fetch = fixtureFetch;
  bindSearchSession(
    integratedScope,
    SessionManager.inMemory("/tmp/choco-pi-agent-browser-search-test/integrated-session"),
  );
  const canonicalResponse = await search(
    {
      language: "en",
      numResults: 3,
      provider: "brave",
      query: "canonical query",
      recencyFilter: "week",
    },
    { scope: integratedScope },
  );
  assert.equal(canonicalResponse.adapterId, "agent-browser.brave");
  assert.equal(canonicalResponse.results[0]?.snippet, "Canonical snippet");
  assert.equal(capturedUrl?.searchParams.get("freshness"), "pw");
  assert.equal(capturedUrl?.searchParams.get("search_lang"), "en");
  assert.deepEqual(canonicalResponse.native, {
    diagnostics: null,
    provider: "brave",
    resultMetadata: [
      {
        description: "Canonical snippet",
        language: "en",
        source: "Canonical Source",
        title: "Canonical result",
        url: "https://example.test/canonical",
      },
    ],
    returnedQuery: "canonical query",
  });

  const fallbackCalls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    fallbackCalls.push(url.hostname);
    if (url.hostname === "api.search.brave.com")
      return new Response("backend timed out", { status: 408 });
    return new Response(
      JSON.stringify({
        results: [
          {
            highlights: ["Fallback snippet"],
            title: "Fallback result",
            url: "https://example.test/fallback",
          },
        ],
      }),
      { status: 200 },
    );
  };
  const fallbackResponse = await search(
    { provider: "auto", query: "fallback query" },
    { routing: { providers: ["brave", "exa"] }, scope: integratedScope },
  );
  assert.equal(fallbackResponse.adapterId, "agent-browser.exa");
  assert.deepEqual(fallbackCalls, ["api.search.brave.com", "api.exa.ai"]);

  fallbackCalls.length = 0;
  const fanoutResponse = await search(
    { provider: "all", query: "fanout query" },
    { scope: integratedScope },
  );
  assert.deepEqual(fallbackCalls.toSorted(), ["api.exa.ai", "api.search.brave.com"]);
  assert.deepEqual(
    fanoutResponse.providerResponses?.map(({ adapterId, provider }) => ({ adapterId, provider })),
    [{ adapterId: "agent-browser.exa", provider: "exa" }],
  );

  fallbackCalls.length = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    fallbackCalls.push(url.hostname);
    return new Response("credentials rejected", { status: 401 });
  };
  await assert.rejects(
    search(
      { provider: "auto", query: "auth query" },
      { routing: { providers: ["brave", "exa"] }, scope: integratedScope },
    ),
    (error: Error & { kind?: string }) => error.kind === "auth",
  );
  assert.deepEqual(fallbackCalls, ["api.search.brave.com"]);

  const standaloneBus = createEventBus();
  const standaloneLoader = new DefaultResourceLoader({
    agentDir: join(fixtureRoot, "standalone-agent"),
    cwd: join(fixtureRoot, "standalone-project"),
    eventBus: standaloneBus,
    extensionFactories: [
      {
        factory: (pi) =>
          registerAgentBrowserExtension(pi, {
            initialConfigState: configState,
            loadSearchConfigState: async () => configState,
          }),
        name: "standalone-agent-browser",
      },
    ],
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager: SettingsManager.inMemory(),
  });
  await standaloneLoader.reload();
  const standaloneResult = standaloneLoader.getExtensions();
  assert.deepEqual(standaloneResult.errors, []);
  const standaloneExtension = standaloneResult.extensions.find(
    (extension) => extension.path === "<inline:standalone-agent-browser>",
  );
  assert.ok(standaloneExtension);
  assert.equal(standaloneExtension.tools.has("agent_browser"), true);
  assert.equal(standaloneExtension.tools.has("agent_browser_web_search"), true);
  const standaloneGuidelines =
    standaloneExtension.tools.get("agent_browser")?.definition.promptGuidelines?.join("\n") ?? "";
  assert.equal(standaloneGuidelines.includes(expectedReadmePath), true);
  assert.match(standaloneGuidelines, /agent_browser_web_search/);
  const standaloneScope = getSearchScope(standaloneBus);
  assert.notEqual(standaloneScope, integratedScope);
  assert.notEqual(
    standaloneScope.adapters.get("agent-browser.brave"),
    integratedScope.adapters.get("agent-browser.brave"),
  );
});
