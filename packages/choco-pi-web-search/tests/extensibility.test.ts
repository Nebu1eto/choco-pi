import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  BUILTIN_SEARCH_PROVIDER_FAMILIES,
  bindSearchSession,
  createSearchScope,
  isSearchError,
  isValidSearchProviderFamily,
  registerSearchAdapter,
  search,
  SearchError,
  searchProviderFamilies,
  type SearchAdapter,
  type SearchRequest,
} from "../index.ts";

function createBoundScope() {
  const scope = createSearchScope();
  bindSearchSession(scope, SessionManager.inMemory("/tmp/choco-pi-web-search-ext"));
  return scope;
}

test("BUILTIN_SEARCH_PROVIDER_FAMILIES matches searchProviderFamilies and family validator accepts custom ids", () => {
  assert.strictEqual(BUILTIN_SEARCH_PROVIDER_FAMILIES, searchProviderFamilies);
  assert.equal(isValidSearchProviderFamily("openai"), true);
  assert.equal(isValidSearchProviderFamily("searxng"), true);
  assert.equal(isValidSearchProviderFamily("custom-backend-2"), true);
  assert.equal(isValidSearchProviderFamily(""), false);
  assert.equal(isValidSearchProviderFamily("auto"), false);
  assert.equal(isValidSearchProviderFamily("all"), false);
  assert.equal(isValidSearchProviderFamily("Custom"), false);
  assert.equal(isValidSearchProviderFamily("has space"), false);
});

test("custom third-party SearchAdapter registers and routes by explicit, auto, all, and routing.providers", async () => {
  const scope = createBoundScope();
  const received: SearchRequest[] = [];
  const customAdapter: SearchAdapter = {
    id: "custom.searxng",
    family: "searxng",
    transport: "http",
    capabilities: { actions: ["search"] },
    availability: () => ({ status: "available", billing: "free" }),
    execute: async (request) => {
      received.push(request);
      return {
        answer: "searxng-answer",
        results: [{ title: "T", url: "https://example.com", snippet: "S" }],
      };
    },
  };
  registerSearchAdapter(scope, customAdapter);

  const explicitRes = await search({ query: "q", provider: "searxng" }, { scope });
  assert.equal(explicitRes.provider, "searxng");
  assert.equal(explicitRes.adapterId, "custom.searxng");

  const autoRes = await search({ query: "q" }, { scope });
  assert.equal(autoRes.provider, "searxng");

  const allRes = await search({ query: "q", provider: "all" }, { scope });
  assert.equal(allRes.provider, "all");
  assert.equal(allRes.providerResponses?.length, 1);
  assert.equal(allRes.providerResponses?.[0]?.provider, "searxng");

  const routedRes = await search({ query: "q" }, { scope, routing: { providers: ["searxng"] } });
  assert.equal(routedRes.provider, "searxng");
  assert.equal(received.length, 4);
});

test("registerSearchAdapter rejects invalid family ids and SearchError with custom family passes isSearchError", () => {
  const scope = createBoundScope();
  const badAdapter: SearchAdapter = {
    id: "bad.family",
    family: "AUTO",
    transport: "http",
    capabilities: { actions: ["search"] },
    availability: () => ({ status: "available" }),
    execute: async () => ({ answer: "", results: [] }),
  };
  assert.throws(
    () => registerSearchAdapter(scope, badAdapter),
    (err) => isSearchError(err) && err.kind === "config",
  );

  const err = new SearchError("transient", "boom", {
    family: "searxng",
    adapterId: "custom.searxng",
    attempts: [
      { adapterId: "custom.searxng", family: "searxng", transport: "http", outcome: "error" },
    ],
  });
  assert.equal(isSearchError(err), true);
});

test("providerOptions passes through to adapters and normalizes legacy exaSearchType", async () => {
  const scope = createBoundScope();
  const seen: SearchRequest[] = [];
  registerSearchAdapter(scope, {
    id: "custom.exa",
    family: "exa",
    transport: "api",
    capabilities: { actions: ["search"], constraints: { exaSearchType: true } },
    availability: () => ({ status: "available" }),
    execute: async (request) => {
      seen.push(request);
      return { answer: "ok", results: [] };
    },
  });

  await search(
    {
      query: "q",
      provider: "exa",
      exaSearchType: "deep",
      providerOptions: { exa: { livecrawl: "always" }, custom: { flag: true } },
    },
    { scope },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.exaSearchType, "deep");
  assert.deepEqual(seen[0]?.providerOptions, {
    exa: { livecrawl: "always", searchType: "deep" },
    custom: { flag: true },
  });

  const badRequest: SearchRequest = { query: "q", provider: "exa" };
  Object.assign(badRequest, { providerOptions: { exa: { bad: Number.NaN } } });
  await assert.rejects(
    () => search(badRequest, { scope }),
    (err) => isSearchError(err) && err.kind === "invalid-request",
  );
});

test("legacy exaSearchType normalizes into providerOptions for custom families without providerOptions", async () => {
  const scope = createBoundScope();
  const seen: SearchRequest[] = [];
  registerSearchAdapter(scope, {
    id: "custom.deep",
    family: "custom-deep",
    transport: "api",
    capabilities: { actions: ["search"], constraints: { exaSearchType: true } },
    availability: () => ({ status: "available" }),
    execute: async (request) => {
      seen.push(request);
      return { answer: "ok", results: [] };
    },
  });

  await search({ query: "q", provider: "custom-deep", exaSearchType: "deep" }, { scope });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.exaSearchType, "deep");
  assert.equal(seen[0]?.providerOptions?.exa?.searchType, "deep");
});
