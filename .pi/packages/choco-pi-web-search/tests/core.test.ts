import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createEventBus,
  createExtensionRuntime,
  SessionManager,
  type EventBus,
} from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import {
  bindSearchSession,
  canonicalSearchParams,
  confirmCanonicalSearchRegistration,
  createSearchScope,
  getSearchScope,
  hasCanonicalSearch,
  invalidateSearchSession,
  isSearchError,
  markCanonicalSearch,
  registerSearchAdapter,
  requestCanonicalSearchIntegration,
  resolveSearchScope,
  resolveSearchSession,
  search,
  searchProviderSchema,
  SearchError,
  type SearchAdapter,
  type SearchAdapterResponse,
  type SearchProviderFamily,
  type SearchRequest,
  type SearchRouting,
  type SearchScope,
} from "../index.ts";

const execFileAsync = promisify(execFile);

function result(answer: string, url = `https://${answer}.example`): SearchAdapterResponse {
  return { answer, results: [{ title: answer, url, snippet: answer }] };
}

function adapter(
  id: string,
  family: SearchProviderFamily,
  overrides: Partial<SearchAdapter> = {},
): SearchAdapter {
  return {
    id,
    family,
    transport: id,
    capabilities: {
      actions: ["search"],
      constraints: {
        recencyFilter: true,
        domainFilter: true,
        includeContent: true,
        country: true,
        language: true,
        safesearch: true,
        offset: true,
        exaSearchType: true,
        answerMode: true,
        responseLength: true,
      },
    },
    availability: () => ({ status: "available" }),
    execute: async () => result(id),
    ...overrides,
  };
}

function setup() {
  const scope = createSearchScope();
  const manager = SessionManager.inMemory("/tmp/choco-pi-web-search-test");
  bindSearchSession(scope, manager);
  return { scope, manager };
}

async function expectKind(promise: Promise<unknown>, kind: SearchError["kind"]): Promise<void> {
  await assert.rejects(promise, { name: "SearchError", kind });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test("real Pi API wrappers rendezvous only on their shared loader bus", async () => {
  const sharedBus = createEventBus();
  const runtime = createExtensionRuntime();
  let first: SearchScope | undefined;
  let second: SearchScope | undefined;
  let firstEvents: EventBus | undefined;
  let secondEvents: EventBus | undefined;
  await loadExtensionFromFactory(
    (pi) => {
      firstEvents = pi.events;
      first = getSearchScope(pi.events);
      registerSearchAdapter(first, adapter("codex.web_run", "openai"));
    },
    "/tmp/choco-pi-web-search-test",
    sharedBus,
    runtime,
    "<inline:first>",
  );
  await loadExtensionFromFactory(
    (pi) => {
      secondEvents = pi.events;
      second = getSearchScope(pi.events);
    },
    "/tmp/choco-pi-web-search-test",
    sharedBus,
    runtime,
    "<inline:second>",
  );
  assert.notEqual(firstEvents, secondEvents);
  assert.equal(first, second);
  assert.equal(second?.adapters.has("codex.web_run"), true);

  const otherBus = createEventBus();
  let isolated: SearchScope | undefined;
  await loadExtensionFromFactory(
    (pi) => {
      isolated = getSearchScope(pi.events);
    },
    "/tmp/choco-pi-web-search-test",
    otherBus,
    createExtensionRuntime(),
    "<inline:isolated>",
  );
  assert.notEqual(isolated, first);
});

test("native and Jiti module copies share only owner-scoped search state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-web-search-cross-loader-"));
  const agentDir = path.join(root, "agent");
  const environment: NodeJS.ProcessEnv = {
    HOME: root,
    PI_CODING_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: path.join(root, "config"),
  };
  if (process.env.PATH !== undefined) environment.PATH = process.env.PATH;
  try {
    const fixture = fileURLToPath(new URL("./fixtures/cross-loader-runner.ts", import.meta.url));
    const result = await execFileAsync(process.execPath, [fixture], {
      cwd: root,
      encoding: "utf8",
      env: environment,
    });
    assert.match(result.stdout, /cross-loader-ok/);
    assert.equal(result.stderr, "");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("synchronous cancellation settles an already-started adapter rejection", async () => {
  const fixture = fileURLToPath(
    new URL("./fixtures/cancellation-settlement-runner.ts", import.meta.url),
  );
  const child = await execFileAsync(process.execPath, [fixture], {
    cwd: path.dirname(fixture),
    encoding: "utf8",
  });
  assert.equal(child.stdout, "cancellation-settled-ok\n");
  assert.equal(child.stderr, "");
});

test("canonical marker and registration work in either load order", () => {
  for (const markerFirst of [true, false]) {
    const bus = createEventBus();
    const scope = getSearchScope(bus);
    if (markerFirst) markCanonicalSearch(scope);
    const unregister = registerSearchAdapter(scope, adapter(`openai-${markerFirst}`, "openai"));
    if (!markerFirst) markCanonicalSearch(scope);
    assert.equal(hasCanonicalSearch(bus), true);
    unregister();
    assert.equal(scope.adapters.size, 0);
  }
});

test("canonical integration handshake requires both parties in either order", () => {
  for (const requestFirst of [true, false]) {
    const scope = createSearchScope();
    const first = requestFirst
      ? requestCanonicalSearchIntegration
      : confirmCanonicalSearchRegistration;
    const second = requestFirst
      ? confirmCanonicalSearchRegistration
      : requestCanonicalSearchIntegration;
    first(scope);
    assert.equal(hasCanonicalSearch(scope), false);
    second(scope);
    assert.equal(hasCanonicalSearch(scope), true);
  }
});

test("auto is OpenAI-first and transport priority ignores conversation provider", async () => {
  const { scope } = setup();
  const calls: string[] = [];
  registerSearchAdapter(
    scope,
    adapter("web-access.exa", "exa", {
      execute: async () => {
        calls.push("exa");
        return result("exa");
      },
    }),
  );
  registerSearchAdapter(
    scope,
    adapter("web-access.openai", "openai", {
      priority: 20,
      billing: "api",
      execute: async () => {
        calls.push("responses");
        return result("responses");
      },
    }),
  );
  registerSearchAdapter(
    scope,
    adapter("codex.web_run", "openai", {
      priority: 10,
      billing: "subscription",
      execute: async () => {
        calls.push("codex");
        return result("codex");
      },
    }),
  );
  const response = await search({ query: "query" }, { scope });
  assert.equal(response.adapterId, "codex.web_run");
  assert.deepEqual(calls, ["codex"]);
});

test("explicit, family-list, and all routing stay within selected families", async () => {
  const { scope } = setup();
  registerSearchAdapter(scope, adapter("openai", "openai"));
  registerSearchAdapter(scope, adapter("exa", "exa"));
  registerSearchAdapter(scope, adapter("kagi", "kagi"));
  const explicit = await search({ query: "q", provider: "exa" }, { scope });
  assert.equal(explicit.provider, "exa");
  const listed = await search({ query: "q", provider: ["exa", "kagi"] }, { scope });
  assert.equal(listed.provider, "all");
  assert.deepEqual(
    listed.providerResponses?.map((entry) => entry.provider),
    ["exa", "kagi"],
  );
  const all = await search({ query: "q", provider: "all" }, { scope });
  assert.deepEqual(
    all.providerResponses?.map((entry) => entry.provider),
    ["openai", "exa", "kagi"],
  );

  const isolated = setup().scope;
  registerSearchAdapter(
    isolated,
    adapter("openai", "openai", { availability: () => ({ status: "unavailable" }) }),
  );
  registerSearchAdapter(isolated, adapter("exa", "exa"));
  await expectKind(search({ query: "q", provider: "openai" }, { scope: isolated }), "capability");
});

test("auto skips unavailable credentials without probing later families", async () => {
  const { scope } = setup();
  let openaiAvailability = 0;
  let exaAvailability = 0;
  registerSearchAdapter(
    scope,
    adapter("openai", "openai", {
      availability: () => {
        openaiAvailability += 1;
        return { status: "available" };
      },
    }),
  );
  registerSearchAdapter(
    scope,
    adapter("exa", "exa", {
      availability: () => {
        exaAvailability += 1;
        return { status: "available" };
      },
    }),
  );
  await search({ query: "q" }, { scope });
  assert.equal(openaiAvailability, 1);
  assert.equal(exaAvailability, 0);
});

test("capabilities preserve hard constraints while numResults remains a warned hint", async () => {
  const { scope } = setup();
  registerSearchAdapter(
    scope,
    adapter("openai", "openai", { capabilities: { actions: ["search"], constraints: {} } }),
  );
  registerSearchAdapter(scope, adapter("exa", "exa"));
  const hinted = await search({ query: "q", numResults: 9 }, { scope });
  assert.equal(hinted.provider, "openai");
  assert.match(hinted.warnings?.[0] ?? "", /non-binding hint/);
  const constrained = await search({ query: "q", recencyFilter: "day" }, { scope });
  assert.equal(constrained.provider, "exa");
  await expectKind(
    search({ query: "q", provider: "openai", recencyFilter: "day" }, { scope }),
    "capability",
  );
  await expectKind(
    search(
      { query: "q", provider: "openai", numResults: 9, requiredCapabilities: ["numResults"] },
      { scope },
    ),
    "capability",
  );
});

test("billed API does not follow an attempted subscription unless enabled", async () => {
  const { scope } = setup();
  let apiCalls = 0;
  registerSearchAdapter(
    scope,
    adapter("codex", "openai", {
      priority: 1,
      billing: "subscription",
      execute: async () => {
        throw new SearchError("transient", "subscription failed");
      },
    }),
  );
  registerSearchAdapter(
    scope,
    adapter("responses", "openai", {
      priority: 2,
      billing: "api",
      execute: async () => {
        apiCalls += 1;
        return result("api");
      },
    }),
  );
  await expectKind(search({ query: "q", provider: "openai" }, { scope }), "transient");
  assert.equal(apiCalls, 0);
  const response = await search(
    { query: "q", provider: "openai" },
    { scope, allowBilledApiFallback: true },
  );
  assert.equal(response.adapterId, "responses");
  assert.equal(apiCalls, 1);
});

test("typed fallback is bounded and hard-stop errors cannot be configured around", async () => {
  const { scope } = setup();
  let secondCalls = 0;
  registerSearchAdapter(
    scope,
    adapter("first", "openai", {
      priority: 1,
      execute: async () => {
        throw new SearchError("network", "offline");
      },
    }),
  );
  registerSearchAdapter(
    scope,
    adapter("second", "openai", {
      priority: 2,
      execute: async () => {
        secondCalls += 1;
        return result("second");
      },
    }),
  );
  assert.equal((await search({ query: "q", provider: "openai" }, { scope })).adapterId, "second");
  assert.equal(secondCalls, 1);

  const hard = setup().scope;
  let forbiddenFallback = 0;
  registerSearchAdapter(
    hard,
    adapter("auth", "openai", {
      priority: 1,
      execute: async () => {
        throw new SearchError("auth", "denied");
      },
    }),
  );
  registerSearchAdapter(
    hard,
    adapter("later", "openai", {
      priority: 2,
      execute: async () => {
        forbiddenFallback += 1;
        return result("later");
      },
    }),
  );
  await expectKind(
    search({ query: "q", provider: "openai" }, { scope: hard, fallbackOn: ["auth"] }),
    "auth",
  );
  assert.equal(forbiddenFallback, 0);

  const quota = setup().scope;
  registerSearchAdapter(
    quota,
    adapter("quota", "openai", {
      priority: 1,
      execute: async () => {
        throw new SearchError("quota", "limited", { retryable: false });
      },
    }),
  );
  registerSearchAdapter(quota, adapter("later", "openai", { priority: 2 }));
  await expectKind(
    search({ query: "q", provider: "openai" }, { scope: quota, fallbackOn: ["quota"] }),
    "quota",
  );
});

test("empty results succeed and malformed adapter output records only an error", async () => {
  const { scope } = setup();
  registerSearchAdapter(
    scope,
    adapter("empty", "openai", { execute: async () => ({ answer: "", results: [] }) }),
  );
  assert.deepEqual((await search({ query: "q" }, { scope })).results, []);

  const malformed = setup().scope;
  const invalidResponse: SearchAdapterResponse = {
    answer: "bad",
    results: [{ title: "x", url: "x", snippet: "x" }],
    native: Number.NaN,
  };
  registerSearchAdapter(
    malformed,
    adapter("bad", "openai", { priority: 1, execute: async () => invalidResponse }),
  );
  registerSearchAdapter(
    malformed,
    adapter("good", "openai", { priority: 2, execute: async () => result("good") }),
  );
  const recovered = await search({ query: "q", provider: "openai" }, { scope: malformed });
  assert.deepEqual(
    recovered.attempts.map(({ adapterId, outcome }) => `${adapterId}:${outcome}`),
    ["bad:error", "good:success"],
  );
});

test("session invalidation, caller cancellation, and deadlines stop fallback", async () => {
  const staleSetup = setup();
  const replacement = SessionManager.inMemory("/tmp/choco-pi-web-search-replacement");
  registerSearchAdapter(
    staleSetup.scope,
    adapter("stale", "openai", {
      execute: async () => {
        bindSearchSession(staleSetup.scope, replacement);
        return result("stale");
      },
    }),
  );
  await expectKind(search({ query: "q" }, { scope: staleSetup.scope }), "stale-context");

  for (const mode of ["cancel", "deadline"] as const) {
    const { scope } = setup();
    let fallbackCalls = 0;
    registerSearchAdapter(
      scope,
      adapter("slow", "openai", {
        priority: 1,
        execute: async (_request, context) =>
          new Promise<SearchAdapterResponse>((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      }),
    );
    registerSearchAdapter(
      scope,
      adapter("fallback", "openai", {
        priority: 2,
        execute: async () => {
          fallbackCalls += 1;
          return result("fallback");
        },
      }),
    );
    const controller = new AbortController();
    if (mode === "cancel") setTimeout(() => controller.abort(), 5);
    await expectKind(
      search(
        { query: "q", provider: "openai" },
        mode === "cancel"
          ? { scope, signal: controller.signal }
          : { scope, fallbackOn: [], attemptDeadlineMs: 5, totalDeadlineMs: 50 },
      ),
      mode === "cancel" ? "cancelled" : "deadline",
    );
    assert.equal(fallbackCalls, 0);
  }
});

test("pre-cancelled requests skip availability and total deadlines abort transport", async () => {
  const cancelled = setup().scope;
  let availabilityCalls = 0;
  registerSearchAdapter(
    cancelled,
    adapter("cancelled", "openai", {
      availability: () => {
        availabilityCalls += 1;
        return { status: "available" };
      },
    }),
  );
  const controller = new AbortController();
  controller.abort();
  await expectKind(
    search({ query: "q" }, { scope: cancelled, signal: controller.signal }),
    "cancelled",
  );
  assert.equal(availabilityCalls, 0);

  const deadline = setup().scope;
  let fallbackCalls = 0;
  registerSearchAdapter(
    deadline,
    adapter("slow", "openai", {
      priority: 1,
      execute: async (_request, context) =>
        new Promise<SearchAdapterResponse>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    }),
  );
  registerSearchAdapter(
    deadline,
    adapter("fallback", "openai", {
      priority: 2,
      execute: async () => {
        fallbackCalls += 1;
        return result("fallback");
      },
    }),
  );
  await expectKind(
    search(
      { query: "q", provider: "openai" },
      { scope: deadline, totalDeadlineMs: 5, attemptDeadlineMs: 50 },
    ),
    "deadline",
  );
  assert.equal(fallbackCalls, 0);
});

test("default deadlines preserve 45-second transports, retry slow attempts, and stop totals", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const normal = setup().scope;
  registerSearchAdapter(
    normal,
    adapter("normal", "openai", {
      execute: async () =>
        new Promise<SearchAdapterResponse>((resolve) => {
          setTimeout(() => resolve(result("normal")), 45_000);
        }),
    }),
  );
  let normalSettled = false;
  const normalSearch = search({ query: "q" }, { scope: normal }).then((response) => {
    normalSettled = true;
    return response;
  });
  await flushMicrotasks();
  t.mock.timers.tick(30_001);
  await flushMicrotasks();
  assert.equal(normalSettled, false);
  t.mock.timers.tick(14_999);
  await flushMicrotasks();
  assert.equal((await normalSearch).adapterId, "normal");

  const retry = setup().scope;
  let fallbackCalls = 0;
  registerSearchAdapter(
    retry,
    adapter("slow", "openai", {
      priority: 1,
      execute: async (_request, context) =>
        new Promise<SearchAdapterResponse>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    }),
  );
  registerSearchAdapter(
    retry,
    adapter("fallback", "openai", {
      priority: 2,
      execute: async () => {
        fallbackCalls += 1;
        return result("fallback");
      },
    }),
  );
  const retriedSearch = search({ query: "q", provider: "openai" }, { scope: retry });
  await flushMicrotasks();
  t.mock.timers.tick(120_000);
  await flushMicrotasks();
  assert.equal((await retriedSearch).adapterId, "fallback");
  assert.equal(fallbackCalls, 1);

  const total = setup().scope;
  registerSearchAdapter(
    total,
    adapter("never", "openai", {
      execute: async () => new Promise<SearchAdapterResponse>(() => undefined),
    }),
  );
  const totalSearch = search(
    { query: "q", provider: "openai" },
    { scope: total, attemptDeadlineMs: 500_000 },
  );
  await flushMicrotasks();
  t.mock.timers.tick(360_000);
  await flushMicrotasks();
  await expectKind(totalSearch, "deadline");
});

test("duplicate ids conflict and unregister is identity-safe", () => {
  const scope = createSearchScope();
  const first = adapter("duplicate", "openai");
  const unregister = registerSearchAdapter(scope, first);
  assert.throws(() => registerSearchAdapter(scope, adapter("duplicate", "exa")), {
    name: "SearchError",
    kind: "conflict",
  });
  unregister();
  registerSearchAdapter(scope, adapter("duplicate", "exa"));
  unregister();
  assert.equal(scope.adapters.get("duplicate")?.family, "exa");
});

test("native references retain stable ownership and reject foreign sessions", async () => {
  const { scope, manager } = setup();
  let receivedNative: unknown;
  registerSearchAdapter(
    scope,
    adapter("browser", "brave", {
      capabilities: { actions: ["search", "open"] },
      execute: async (request, context) => {
        if (request.action === "open") {
          receivedNative = context.reference?.native;
          return result("opened");
        }
        return {
          ...result("search"),
          references: [{ id: "native-1", kind: "page", native: { ref_id: "turn0search0" } }],
        };
      },
    }),
  );
  const initial = await search({ query: "q", provider: "brave" }, { scope });
  const reference = initial.references?.[0];
  assert.ok(reference);
  const opened = await search(
    { action: "open", open: true, reference: { id: reference.id }, provider: "brave" },
    { scope },
  );
  assert.equal(opened.answer, "opened");
  assert.deepEqual(receivedNative, { ref_id: "turn0search0" });

  invalidateSearchSession(scope, manager);
  bindSearchSession(scope, SessionManager.inMemory("/tmp/choco-pi-web-search-foreign"));
  await expectKind(
    search(
      { action: "open", open: true, reference: { id: reference.id }, provider: "brave" },
      { scope },
    ),
    "stale-context",
  );
});

test("live scopes have globally unique session and public reference identities", async () => {
  const left = setup();
  const right = setup();
  const backendSessionIds: string[] = [];
  const referenceAdapter = (id: string) =>
    adapter(id, "brave", {
      capabilities: { actions: ["search", "open"] },
      execute: async (_request, context) => {
        backendSessionIds.push(context.session.id);
        return {
          ...result(id),
          references: [{ id: "same-native-id", kind: "page", native: { ref_id: "same" } }],
        };
      },
    });
  registerSearchAdapter(left.scope, referenceAdapter("browser"));
  registerSearchAdapter(right.scope, referenceAdapter("browser"));
  const leftResponse = await search({ query: "left", provider: "brave" }, { scope: left.scope });
  const rightResponse = await search({ query: "right", provider: "brave" }, { scope: right.scope });
  const leftReference = leftResponse.references?.[0];
  const rightReference = rightResponse.references?.[0];
  assert.ok(leftReference);
  assert.ok(rightReference);
  assert.notEqual(backendSessionIds[0], backendSessionIds[1]);
  assert.notEqual(leftReference.id, rightReference.id);
  await expectKind(
    search(
      { action: "open", open: true, reference: { id: leftReference.id }, provider: "brave" },
      { scope: right.scope },
    ),
    "stale-context",
  );
});

test("rebinding removes the old manager context mapping", () => {
  const { scope, manager: oldManager } = setup();
  const newManager = SessionManager.inMemory("/tmp/choco-pi-web-search-new-manager");
  bindSearchSession(scope, newManager);
  assert.equal(resolveSearchScope({ sessionManager: oldManager }), undefined);
  assert.equal(resolveSearchSession({ sessionManager: oldManager }), undefined);
  assert.equal(resolveSearchScope({ sessionManager: newManager }), scope);
  assert.equal(resolveSearchSession({ sessionManager: newManager }), scope.session);
});

test("session-only invocation resolves its live manager binding", async () => {
  const { scope } = setup();
  const session = scope.session;
  assert.ok(session);
  registerSearchAdapter(scope, adapter("session-only", "openai"));
  const response = await search({ query: "q" }, { session });
  assert.equal(response.answer, "session-only");

  invalidateSearchSession(scope);
  await expectKind(search({ query: "q" }, { session }), "stale-context");
});

test("direct URL open is validated and routes only to capable adapters", async () => {
  const { scope } = setup();
  let incompatibleCalls = 0;
  let openedUrl: string | undefined;
  registerSearchAdapter(
    scope,
    adapter("openai", "openai", {
      capabilities: { actions: ["search", "open"] },
      execute: async () => {
        incompatibleCalls += 1;
        return result("wrong");
      },
    }),
  );
  registerSearchAdapter(
    scope,
    adapter("exa", "exa", {
      capabilities: {
        actions: ["search", "open"],
        constraints: { url: true, lineno: true, recencyDays: true, searchContextSize: true },
      },
      execute: async (request) => {
        openedUrl = request.url;
        return result("opened");
      },
    }),
  );
  const opened = await search(
    {
      action: "open",
      url: "https://example.com/page?q=1",
      lineno: 10,
      recencyDays: 17,
      searchContextSize: "high",
    },
    { scope },
  );
  assert.equal(opened.provider, "exa");
  assert.equal(openedUrl, "https://example.com/page?q=1");
  assert.equal(incompatibleCalls, 0);
  await expectKind(
    search({ action: "open", url: "https://example.com", provider: "openai" }, { scope }),
    "capability",
  );
  await expectKind(
    search({ action: "open", url: "file:///etc/passwd" }, { scope }),
    "invalid-request",
  );
  await expectKind(
    search({ query: "q", domainFilter: ["https://example.com/path"] }, { scope }),
    "invalid-request",
  );
});

test("all existing Exa search modes validate and unsupported neural is rejected", async () => {
  const { scope } = setup();
  registerSearchAdapter(
    scope,
    adapter("exa", "exa", {
      capabilities: { actions: ["search"], constraints: { exaSearchType: true } },
    }),
  );
  for (const exaSearchType of [
    "auto",
    "fast",
    "instant",
    "deep-lite",
    "deep",
    "deep-reasoning",
  ] as const) {
    assert.equal((await search({ query: "q", exaSearchType }, { scope })).provider, "exa");
  }
  const invalid: SearchRequest = { query: "q" };
  Object.assign(invalid, { exaSearchType: "neural" });
  await expectKind(search(invalid, { scope }), "invalid-request");
});

test("public action and provider schemas use string enum form", () => {
  const requestSchema = JSON.stringify(canonicalSearchParams);
  const providerSchema = JSON.stringify(searchProviderSchema());
  assert.match(requestSchema, /"action":\{"type":"string","enum":\[/);
  assert.match(providerSchema, /"enum":\[/);
  assert.doesNotMatch(requestSchema, /"const":"search"/);
  assert.doesNotMatch(providerSchema, /"const":"openai"/);
});

test("explicit provider navigation cannot cross the reference owner", async () => {
  const { scope } = setup();
  let exaCalls = 0;
  registerSearchAdapter(
    scope,
    adapter("browser", "brave", {
      capabilities: { actions: ["search", "open"] },
      execute: async () => ({
        ...result("brave"),
        references: [{ id: "native", kind: "page" }],
      }),
    }),
  );
  registerSearchAdapter(
    scope,
    adapter("exa", "exa", {
      capabilities: { actions: ["search", "open"] },
      execute: async () => {
        exaCalls += 1;
        return result("exa");
      },
    }),
  );
  const initial = await search({ query: "q", provider: "brave" }, { scope });
  const reference = initial.references?.[0];
  assert.ok(reference);
  await expectKind(
    search(
      { action: "open", open: true, reference: { id: reference.id }, provider: "exa" },
      { scope },
    ),
    "capability",
  );
  assert.equal(exaCalls, 0);
});

test("reference ownership pins its adapter without bypassing configured routing", async () => {
  const { scope } = setup();
  let braveAvailabilityChecks = 0;
  let braveCalls = 0;
  let syntheticAvailabilityChecks = 0;
  let syntheticCalls = 0;
  registerSearchAdapter(
    scope,
    adapter("browser", "brave", {
      capabilities: { actions: ["search", "open"] },
      availability: () => {
        braveAvailabilityChecks += 1;
        return { status: "available" };
      },
      execute: async (request) => {
        braveCalls += 1;
        return request.action === "open"
          ? result("opened")
          : { ...result("brave"), references: [{ id: "native", kind: "page" }] };
      },
    }),
  );
  registerSearchAdapter(
    scope,
    adapter("synthetic", "synthetic", {
      capabilities: { actions: ["search", "open"] },
      availability: () => {
        syntheticAvailabilityChecks += 1;
        return { status: "available" };
      },
      execute: async () => {
        syntheticCalls += 1;
        return result("synthetic");
      },
    }),
  );
  const initial = await search({ query: "q", provider: "brave" }, { scope });
  const reference = initial.references?.[0];
  assert.ok(reference);

  const unrestricted = await search(
    { action: "open", open: true, reference: { id: reference.id } },
    { scope },
  );
  assert.equal(unrestricted.answer, "opened");
  const checksBeforeRestriction = {
    brave: braveAvailabilityChecks,
    synthetic: syntheticAvailabilityChecks,
  };
  const callsBeforeRestriction = { brave: braveCalls, synthetic: syntheticCalls };

  await expectKind(
    search(
      { action: "open", open: true, reference: { id: reference.id } },
      { scope, routing: { providers: ["synthetic"] } },
    ),
    "capability",
  );
  assert.deepEqual(
    { brave: braveAvailabilityChecks, synthetic: syntheticAvailabilityChecks },
    checksBeforeRestriction,
  );
  assert.deepEqual({ brave: braveCalls, synthetic: syntheticCalls }, callsBeforeRestriction);

  const explicitOverride = await search(
    { action: "open", open: true, reference: { id: reference.id }, provider: "brave" },
    { scope, routing: { providers: ["synthetic"] } },
  );
  assert.equal(explicitOverride.answer, "opened");
  assert.equal(braveCalls, callsBeforeRestriction.brave + 1);
  assert.equal(syntheticCalls, callsBeforeRestriction.synthetic);
});

test("standalone scopes and sessions are isolated", async () => {
  const left = setup();
  const right = setup();
  registerSearchAdapter(left.scope, adapter("left", "openai"));
  registerSearchAdapter(right.scope, adapter("right", "openai"));
  assert.equal((await search({ query: "q" }, { scope: left.scope })).adapterId, "left");
  assert.equal((await search({ query: "q" }, { scope: right.scope })).adapterId, "right");
  invalidateSearchSession(left.scope, left.manager);
  await expectKind(search({ query: "q" }, { scope: left.scope }), "stale-context");
  assert.equal((await search({ query: "q" }, { scope: right.scope })).adapterId, "right");
});

test("empty routing configuration is rejected instead of disabling constraints silently", async () => {
  const { scope } = setup();
  registerSearchAdapter(scope, adapter("openai", "openai"));
  await expectKind(search({ query: "q" }, { scope, routing: { providers: [] } }), "config");
});

test("configured routing providers are sequential while request arrays and all fan out", async () => {
  const { scope } = setup();
  const calls: string[] = [];
  registerSearchAdapter(
    scope,
    adapter("openai", "openai", {
      execute: async () => {
        calls.push("openai");
        return result("openai");
      },
    }),
  );
  registerSearchAdapter(
    scope,
    adapter("exa", "exa", {
      execute: async () => {
        calls.push("exa");
        return result("exa");
      },
    }),
  );
  const routed = await search(
    { query: "fixture" },
    { scope, routing: { providers: ["openai", "exa"], fallbackOn: ["network"] } },
  );
  assert.equal(routed.provider, "openai");
  assert.deepEqual(calls, ["openai"]);

  calls.length = 0;
  const autoRouted = await search(
    { query: "fixture", provider: "auto" },
    { scope, routing: { providers: ["openai", "exa"] } },
  );
  assert.equal(autoRouted.provider, "openai");
  assert.deepEqual(calls, ["openai"]);

  calls.length = 0;
  assert.equal(
    (await search({ query: "fixture", provider: ["openai", "exa"] }, { scope })).provider,
    "all",
  );
  assert.deepEqual(calls, ["openai", "exa"]);
  calls.length = 0;
  assert.equal((await search({ query: "fixture", provider: "all" }, { scope })).provider, "all");
  assert.deepEqual(calls, ["openai", "exa"]);
});

test("configured sequential routing falls through only on allowed errors", async () => {
  const { scope } = setup();
  const calls: string[] = [];
  registerSearchAdapter(
    scope,
    adapter("openai", "openai", {
      execute: async () => {
        calls.push("openai");
        throw new SearchError("network", "offline");
      },
    }),
  );
  registerSearchAdapter(
    scope,
    adapter("exa", "exa", {
      execute: async () => {
        calls.push("exa");
        return result("exa");
      },
    }),
  );
  const response = await search(
    { query: "fixture" },
    { scope, routing: { providers: ["openai", "exa"], fallbackOn: ["network"] } },
  );
  assert.equal(response.provider, "exa");
  assert.deepEqual(calls, ["openai", "exa"]);
});

test("adapter config failures and availability errors stop automatic routing", async () => {
  for (const failure of ["execute", "availability"] as const) {
    const { scope } = setup();
    let exaCalls = 0;
    const override: Partial<SearchAdapter> =
      failure === "execute"
        ? {
            execute: async () => {
              throw new SearchError("config", "fixture invalid configuration");
            },
          }
        : { availability: () => ({ status: "error", reason: "fixture unavailable" }) };
    registerSearchAdapter(scope, adapter("openai", "openai", override));
    registerSearchAdapter(
      scope,
      adapter("exa", "exa", {
        execute: async () => {
          exaCalls += 1;
          return result("exa");
        },
      }),
    );
    await expectKind(search({ query: "fixture" }, { scope }), "config");
    assert.equal(exaCalls, 0);
  }
});

test("resolved availability billing blocks paid fallback only after subscription attempt", async () => {
  const { scope } = setup();
  let apiCalls = 0;
  registerSearchAdapter(
    scope,
    adapter("subscription", "openai", {
      priority: 1,
      billing: "unknown",
      availability: () => ({
        status: "available",
        billing: "subscription",
        transport: "native-subscription",
      }),
      execute: async () => {
        throw new SearchError("network", "subscription offline");
      },
    }),
  );
  registerSearchAdapter(
    scope,
    adapter("api", "openai", {
      priority: 2,
      billing: "unknown",
      availability: () => ({ status: "available", billing: "api", transport: "billed-api" }),
      execute: async () => {
        apiCalls += 1;
        return result("api");
      },
    }),
  );
  let blocked: SearchError | undefined;
  try {
    await search({ query: "fixture", provider: "openai" }, { scope });
  } catch (cause) {
    if (cause instanceof SearchError) blocked = cause;
  }
  assert.equal(blocked?.kind, "network");
  assert.equal(blocked?.billing, "subscription");
  assert.equal(blocked?.transport, "native-subscription");
  assert.equal(apiCalls, 0);
  const allowed = await search(
    { query: "fixture", provider: "openai" },
    { scope, allowBilledApiFallback: true },
  );
  assert.equal(allowed.billing, "api");
  assert.equal(allowed.transport, "billed-api");
  assert.equal(apiCalls, 1);
  assert.deepEqual(
    allowed.attempts.map(({ transport, outcome, errorKind }) =>
      errorKind === undefined ? { transport, outcome } : { transport, outcome, errorKind },
    ),
    [
      { transport: "native-subscription", outcome: "error", errorKind: "network" },
      { transport: "billed-api", outcome: "success" },
    ],
  );

  const apiOnly = setup().scope;
  registerSearchAdapter(
    apiOnly,
    adapter("api-only", "openai", {
      billing: "unknown",
      availability: () => ({ status: "available", billing: "api", transport: "configured-api" }),
    }),
  );
  const initialApi = await search({ query: "fixture" }, { scope: apiOnly });
  assert.equal(initialApi.billing, "api");
  assert.equal(initialApi.transport, "configured-api");
});

test("automatic routing preserves a substantive failure and snapshots every later route miss", async () => {
  const { scope } = setup();
  const unexpectedExecutions: string[] = [];
  registerSearchAdapter(
    scope,
    adapter("openai-subscription", "openai", {
      priority: 1,
      billing: "subscription",
      execute: async () => {
        throw new SearchError("transient", "temporary native transport failure");
      },
    }),
  );
  for (const [id, family] of [
    ["openai-api", "openai"],
    ["exa-api", "exa"],
  ] as const) {
    registerSearchAdapter(
      scope,
      adapter(id, family, {
        billing: "api",
        execute: async () => {
          unexpectedExecutions.push(id);
          return result(id);
        },
      }),
    );
  }
  for (const [id, family, status] of [
    ["kagi-api", "kagi", "unavailable"],
    ["synthetic-proxy", "synthetic", "disabled"],
    ["brave-api", "brave", "unavailable"],
  ] as const) {
    registerSearchAdapter(
      scope,
      adapter(id, family, {
        availability: () => ({ status, reason: `${id} is not available` }),
        execute: async () => {
          unexpectedExecutions.push(id);
          return result(id);
        },
      }),
    );
  }

  let failure: SearchError | undefined;
  try {
    await search({ query: "fixture" }, { scope });
  } catch (cause) {
    assert.equal(isSearchError(cause), true);
    if (isSearchError(cause)) failure = cause;
  }

  assert.ok(failure);
  assert.equal(failure.kind, "transient");
  assert.equal(failure.message, "temporary native transport failure");
  assert.equal(isSearchError(failure.cause), true);
  assert.deepEqual(unexpectedExecutions, []);
  assert.ok(failure.attempts);
  assert.equal(Object.isFrozen(failure.attempts), true);
  assert.deepEqual(
    failure.attempts.map(({ adapterId, outcome, errorKind, reason }) => ({
      adapterId,
      outcome,
      errorKind,
      reason,
    })),
    [
      {
        adapterId: "openai-subscription",
        outcome: "error",
        errorKind: "transient",
        reason: "temporary native transport failure",
      },
      {
        adapterId: "openai-api",
        outcome: "disabled",
        errorKind: undefined,
        reason: "billed API fallback is disabled after a subscription attempt",
      },
      {
        adapterId: "exa-api",
        outcome: "disabled",
        errorKind: undefined,
        reason: "billed API fallback is disabled after a subscription attempt",
      },
      {
        adapterId: "kagi-api",
        outcome: "unavailable",
        errorKind: undefined,
        reason: "kagi-api is not available",
      },
      {
        adapterId: "synthetic-proxy",
        outcome: "disabled",
        errorKind: undefined,
        reason: "synthetic-proxy is not available",
      },
      {
        adapterId: "brave-api",
        outcome: "unavailable",
        errorKind: undefined,
        reason: "brave-api is not available",
      },
    ],
  );
});

test("billing guard spans sequential families but not deliberate provider selections", async () => {
  const { scope } = setup();
  const calls: string[] = [];
  registerSearchAdapter(
    scope,
    adapter("subscription", "openai", {
      billing: "unknown",
      availability: () => ({
        status: "available",
        billing: "subscription",
        transport: "native-subscription",
      }),
      execute: async () => {
        calls.push("openai");
        throw new SearchError("network", "subscription offline");
      },
    }),
  );
  for (const family of ["exa", "kagi"] as const) {
    registerSearchAdapter(
      scope,
      adapter(`${family}-api`, family, {
        billing: "unknown",
        availability: () => ({
          status: "available",
          billing: "api",
          transport: `${family}-billed-api`,
        }),
        execute: async () => {
          calls.push(family);
          return result(family);
        },
      }),
    );
  }
  registerSearchAdapter(
    scope,
    adapter("brave-free", "brave", {
      billing: "unknown",
      availability: () => ({
        status: "available",
        billing: "free",
        transport: "brave-free",
      }),
      execute: async () => {
        calls.push("brave");
        return result("brave");
      },
    }),
  );
  const routing: SearchRouting = {
    providers: ["openai", "exa", "kagi", "brave"],
    fallbackOn: ["network"],
  };

  const blocked = await search({ query: "fixture" }, { scope });
  assert.equal(blocked.provider, "brave");
  assert.deepEqual(calls, ["openai", "brave"]);
  assert.deepEqual(
    blocked.attempts.map(({ adapterId, outcome, reason }) => ({
      adapterId,
      outcome,
      reason,
    })),
    [
      { adapterId: "subscription", outcome: "error", reason: "subscription offline" },
      {
        adapterId: "exa-api",
        outcome: "disabled",
        reason: "billed API fallback is disabled after a subscription attempt",
      },
      {
        adapterId: "kagi-api",
        outcome: "disabled",
        reason: "billed API fallback is disabled after a subscription attempt",
      },
      { adapterId: "brave-free", outcome: "success", reason: undefined },
    ],
  );

  calls.length = 0;
  const allowed = await search(
    { query: "fixture" },
    { scope, routing, allowBilledApiFallback: true },
  );
  assert.equal(allowed.provider, "exa");
  assert.deepEqual(calls, ["openai", "exa"]);

  calls.length = 0;
  const fanout = await search({ query: "fixture", provider: ["openai", "exa", "kagi"] }, { scope });
  assert.deepEqual(calls, ["openai", "exa", "kagi"]);
  assert.deepEqual(
    fanout.providerResponses?.map(({ provider }) => provider),
    ["exa", "kagi"],
  );

  calls.length = 0;
  const explicit = await search({ query: "fixture", provider: "exa" }, { scope });
  assert.equal(explicit.provider, "exa");
  assert.deepEqual(calls, ["exa"]);
});

test("an unavailable subscription does not activate the billed API guard", async () => {
  const { scope } = setup();
  let apiCalls = 0;
  registerSearchAdapter(
    scope,
    adapter("unconfigured-subscription", "openai", {
      priority: 1,
      billing: "subscription",
      availability: () => ({
        status: "unavailable",
        billing: "subscription",
        reason: "subscription credentials are not configured",
      }),
    }),
  );
  registerSearchAdapter(
    scope,
    adapter("configured-api", "openai", {
      priority: 2,
      billing: "api",
      execute: async () => {
        apiCalls += 1;
        return result("api");
      },
    }),
  );

  const response = await search({ query: "fixture" }, { scope });
  assert.equal(response.adapterId, "configured-api");
  assert.equal(apiCalls, 1);
});

test("noncooperative availability and execute settle on cancellation or deadlines", async () => {
  const availabilityScope = setup().scope;
  let executed = false;
  registerSearchAdapter(
    availabilityScope,
    adapter("delayed", "openai", {
      availability: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { status: "available" };
      },
      execute: async () => {
        executed = true;
        return result("unexpected");
      },
    }),
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  await expectKind(
    search({ query: "fixture" }, { scope: availabilityScope, signal: controller.signal }),
    "cancelled",
  );
  assert.equal(executed, false);

  const executeScope = setup().scope;
  registerSearchAdapter(
    executeScope,
    adapter("noncooperative", "openai", {
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return result("late");
      },
    }),
  );
  const started = Date.now();
  await expectKind(
    search(
      { query: "fixture", provider: "openai" },
      { scope: executeScope, totalDeadlineMs: 5, attemptDeadlineMs: 50 },
    ),
    "deadline",
  );
  assert.ok(Date.now() - started < 50);

  const fallbackScope = setup().scope;
  registerSearchAdapter(
    fallbackScope,
    adapter("slow", "openai", {
      priority: 1,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return result("late");
      },
    }),
  );
  registerSearchAdapter(fallbackScope, adapter("fallback", "openai", { priority: 2 }));
  const fallback = await search(
    { query: "fixture", provider: "openai" },
    {
      scope: fallbackScope,
      fallbackOn: ["deadline"],
      attemptDeadlineMs: 5,
      totalDeadlineMs: 100,
    },
  );
  assert.equal(fallback.adapterId, "fallback");
});

test("reference followup receives the exact backend-native descriptor id", async () => {
  const { scope } = setup();
  let followedId: string | undefined;
  registerSearchAdapter(
    scope,
    adapter("native", "openai", {
      capabilities: { actions: ["search", "open"] },
      execute: async (request, context) => {
        if (request.action === "open") {
          followedId = context.reference?.id;
          return result("opened");
        }
        return { ...result("search"), references: [{ id: "native0", kind: "page" }] };
      },
    }),
  );
  const initial = await search({ query: "fixture", provider: "openai" }, { scope });
  const reference = initial.references?.[0];
  assert.ok(reference);
  assert.notEqual(reference.id, "native0");
  await search(
    { action: "open", open: true, reference: { id: reference.id }, provider: "openai" },
    { scope },
  );
  assert.equal(followedId, "native0");
});

test("negative domain filters require an exclusion-capable adapter", async () => {
  const { scope } = setup();
  registerSearchAdapter(scope, adapter("positive-only", "openai"));
  registerSearchAdapter(
    scope,
    adapter("exa", "exa", {
      capabilities: {
        actions: ["search"],
        constraints: { domainFilter: true, domainExclusions: true },
      },
    }),
  );
  const response = await search(
    { query: "fixture", domainFilter: ["example.org", "-example.com"] },
    { scope },
  );
  assert.equal(response.provider, "exa");
  await expectKind(
    search({ query: "fixture", provider: "openai", domainFilter: ["-example.com"] }, { scope }),
    "capability",
  );
  await expectKind(
    search({ query: "fixture", domainFilter: ["-https://example.com"] }, { scope }),
    "invalid-request",
  );
});
