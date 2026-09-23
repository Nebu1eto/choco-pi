import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  createExtensionRuntime,
  type EventBus,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import unifiedSearchCore from "../../choco-pi-web-search/extension.ts";
import { registeredCanonicalSearchFrontend } from "../../choco-pi-web-search/tests/fixtures/registered-canonical-tool.ts";
import {
  bindSearchSession,
  getSearchScope,
  type SearchScope,
  search,
} from "../../choco-pi-web-search/index.ts";
import syntheticWebSearchExtension from "../extensions/web-search/index.ts";
import type { ResolvedSyntheticConfig } from "../src/config.ts";
import { SYNTHETIC_CONFIG_UPDATED_EVENT } from "../src/config-events.ts";
import { publishSyntheticConfig } from "../src/config-state.ts";

function config(overrides: Partial<ResolvedSyntheticConfig> = {}): ResolvedSyntheticConfig {
  return {
    configVersion: "test",
    webSearch: true,
    quotasCommand: true,
    usageStatus: false,
    quotaWarnings: false,
    subBarIntegration: true,
    proxyUrl: "https://proxy.example.test",
    proxyRequiresAuth: false,
    ...overrides,
  };
}

interface ScopeObservation {
  scope: SearchScope;
  events: EventBus;
}

async function observeScope(bus: EventBus, label: string): Promise<ScopeObservation> {
  let observed: SearchScope | undefined;
  let events: EventBus | undefined;
  await loadExtensionFromFactory(
    (pi) => {
      events = pi.events;
      observed = getSearchScope(pi.events);
    },
    process.cwd(),
    bus,
    createExtensionRuntime(),
    label,
  );
  assert.ok(observed);
  assert.ok(events);
  return { scope: observed, events };
}

test("Synthetic canonical adapter registration and routing", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const sharedBus = createEventBus();
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return Response.json({});
  };
  publishSyntheticConfig(config());

  await loadExtensionFromFactory(
    unifiedSearchCore,
    process.cwd(),
    sharedBus,
    createExtensionRuntime(),
    "<unified-search-core>",
  );
  await loadExtensionFromFactory(
    registeredCanonicalSearchFrontend,
    process.cwd(),
    sharedBus,
    createExtensionRuntime(),
    "<canonical-search-frontend>",
  );
  const loadedSynthetic = await loadExtensionFromFactory(
    syntheticWebSearchExtension,
    process.cwd(),
    sharedBus,
    createExtensionRuntime(),
    "<synthetic-search>",
  );
  const firstObservation = await observeScope(sharedBus, "<scope-observer:first>");
  const secondObservation = await observeScope(sharedBus, "<scope-observer:second>");
  const sharedScope = firstObservation.scope;
  assert.notEqual(firstObservation.events, secondObservation.events);
  assert.equal(firstObservation.scope, secondObservation.scope);

  assert.equal(fetchCalls, 0, "canonical registration must not perform quota discovery");
  assert.equal(loadedSynthetic.tools.has("synthetic_web_search"), false);
  const adapter = sharedScope.adapters.get("synthetic.search");
  assert.ok(adapter);
  assert.equal(adapter.family, "synthetic");
  assert.equal(adapter.transport, "synthetic-v2-search");
  assert.equal(adapter.capabilities.constraints?.numResults, true);

  bindSearchSession(
    sharedScope,
    SessionManager.inMemory("/tmp/choco-pi-synthetic-search-adapter-test"),
  );
  const session = sharedScope.session;
  assert.ok(session);
  globalThis.fetch = async () => {
    fetchCalls++;
    return Response.json({});
  };
  const availabilityContext = {
    session,
    generation: session.generation,
    signal: session.signal,
  };
  assert.deepEqual(await adapter.availability(availabilityContext), {
    status: "unavailable",
    reason: "Synthetic web search requires an eligible subscription; PAYG is not auto-enabled.",
    transport: "synthetic-v2-search",
    billing: "subscription",
  });
  assert.equal((await adapter.availability(availabilityContext)).status, "unavailable");
  assert.equal(fetchCalls, 1, "PAYG eligibility must be cached for the same configuration");

  sharedBus.emit(SYNTHETIC_CONFIG_UPDATED_EVENT, {
    config: config({ proxyUrl: "https://subscription-proxy.example.test" }),
  });
  globalThis.fetch = async () => {
    fetchCalls++;
    return Response.json({
      subscription: {
        limit: 100,
        requests: 1,
        renewsAt: "2027-01-01T00:00:00Z",
      },
    });
  };
  assert.equal((await adapter.availability(availabilityContext)).status, "available");
  assert.equal(fetchCalls, 2, "a changed configuration must receive a fresh eligibility probe");

  const otherBus = createEventBus();
  const isolatedObservation = await observeScope(otherBus, "<isolated-scope-observer>");
  const isolatedScope = isolatedObservation.scope;
  assert.notEqual(isolatedScope, sharedScope);
  assert.equal(isolatedScope.adapters.has("synthetic.search"), false);

  const largeText = "x".repeat(5_000);
  globalThis.fetch = async (input) => {
    fetchCalls++;
    const url = input instanceof Request ? input.url : input.toString();
    return Response.json(
      url.endsWith("/v2/quotas")
        ? {
            subscription: {
              limit: 100,
              requests: 1,
              renewsAt: "2027-01-01T00:00:00Z",
            },
          }
        : {
            results: [
              {
                title: "first",
                url: "https://example.test/first",
                text: largeText,
                published: "2026-09-21",
              },
              {
                title: "second",
                url: "https://example.test/second",
                text: "second body",
                published: "2026-09-20",
              },
            ],
          },
    );
  };
  const response = await search(
    {
      query: "query independent of conversation provider",
      provider: "synthetic",
      numResults: 1,
      requiredCapabilities: ["numResults"],
    },
    { scope: sharedScope },
  );
  assert.equal(response.adapterId, "synthetic.search");
  assert.equal(response.provider, "synthetic");
  assert.equal(response.transport, "synthetic-v2-search");
  assert.equal(response.answer, "");
  assert.equal(response.results.length, 1);
  assert.equal(Buffer.byteLength(response.results[0]?.snippet ?? ""), 4_000);
  assert.deepEqual(response.warnings, [
    "Synthetic returned 2 results; limited to 1 by numResults.",
    "1 Synthetic result snippet(s) were excerpted to the shared 20KB response budget.",
  ]);
  assert.equal(fetchCalls, 3);

  sharedBus.emit(SYNTHETIC_CONFIG_UPDATED_EVENT, {
    config: config({ webSearch: false }),
  });
  assert.deepEqual(
    await adapter.availability({
      session,
      generation: session.generation,
      signal: session.signal,
    }),
    {
      status: "disabled",
      reason: "Synthetic web search is disabled by configuration.",
      transport: "synthetic-v2-search",
      billing: "subscription",
    },
  );
  assert.equal(fetchCalls, 3);
});
