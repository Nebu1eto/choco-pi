import assert from "node:assert/strict";
import test from "node:test";
import {
  createWebAccessScope,
  extractContent,
  getWebAccessScope,
  registerContentExtractor,
  registerFetchTransport,
  WEB_ACCESS_SCOPE_SYMBOL,
  type ContentExtractor,
  type FetchTransport,
} from "../extract.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("getWebAccessScope exposes process-shared scope via Symbol.for", () => {
  const scope = getWebAccessScope();
  assert.strictEqual(
    scope,
    Object.getOwnPropertyDescriptor(globalThis, WEB_ACCESS_SCOPE_SYMBOL)?.value,
  );
  assert.ok(scope.getFetchTransport("http"));
  assert.ok(scope.getFetchTransport("kagi"));
  assert.ok(scope.extractors.has("github"));
  assert.ok(scope.extractors.has("pdf"));
  assert.ok(scope.extractors.has("readability"));
  assert.ok(scope.extractors.has("rsc"));
});

test("custom ContentExtractor dispatches by priority and falls through when returning null", async () => {
  const scope = createWebAccessScope();
  const calls: string[] = [];

  const lowPriority: ContentExtractor = {
    id: "custom.low",
    priority: 5,
    stage: "pre-fetch",
    match: (ctx) => ctx.url.includes("custom-doc.example"),
    extract: async (ctx) => {
      calls.push("low");
      return {
        url: ctx.url,
        title: "Custom Low Priority Winner",
        content: "Extracted by custom.low",
        error: null,
      };
    },
  };
  const skipFirst: ContentExtractor = {
    id: "custom.skip",
    priority: 1,
    stage: "pre-fetch",
    match: (ctx) => ctx.url.includes("custom-doc.example"),
    extract: async () => {
      calls.push("skip");
      return null;
    },
  };
  const higherNumber: ContentExtractor = {
    id: "custom.later",
    priority: 20,
    stage: "pre-fetch",
    match: () => true,
    extract: async () => {
      calls.push("later");
      return { url: "", title: "Should not run", content: "", error: null };
    },
  };

  const unregisterLow = registerContentExtractor(lowPriority, scope);
  registerContentExtractor(skipFirst, scope);
  registerContentExtractor(higherNumber, scope);

  const res = await extractContent("https://custom-doc.example/page", undefined, {
    scope,
    lookup: publicLookup,
  });
  assert.equal(res.error, null);
  assert.equal(res.title, "Custom Low Priority Winner");
  assert.equal(res.content, "Extracted by custom.low");
  assert.deepEqual(calls, ["skip", "low"]);

  // Unregistering removes only the matching extractor.
  unregisterLow();
  const resAfter = await extractContent("https://custom-doc.example/page", undefined, {
    scope,
    lookup: publicLookup,
  });
  assert.equal(resAfter.title, "Should not run");
});

test("custom FetchTransport registers, checks availability, and serves fallback when http fails", async () => {
  const scope = createWebAccessScope();
  const calls: string[] = [];

  const customTransport: FetchTransport = {
    id: "custom-browser",
    hosted: false,
    available: async () => {
      calls.push("available");
      return true;
    },
    fetch: async (ctx) => {
      calls.push("fetch");
      return {
        content: {
          url: ctx.url,
          title: "Rendered by Custom Browser",
          content: "Rendered content body",
          error: null,
        },
      };
    },
  };
  registerFetchTransport(customTransport, scope);

  // Duplicate id is rejected.
  assert.throws(() => registerFetchTransport(customTransport, scope), /already registered/);

  const result = await extractContent("https://example.com/spa", undefined, {
    scope,
    lookup: publicLookup,
    fetch: async () =>
      new Response("<html><body><div id='app'></div></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  });
  assert.equal(result.error, null);
  assert.equal(result.title, "Rendered by Custom Browser");
  assert.equal(result.content, "Rendered content body");
  assert.deepEqual(calls, ["available", "fetch"]);
});

test("scope is shared across separately evaluated fetch-registry module copies", async () => {
  // Pi loads extensions through jiti with moduleCache: false; query strings reproduce that here.
  const firstHref = new URL("../fetch-registry.ts?instance=1", import.meta.url).href;
  const secondHref = new URL("../fetch-registry.ts?instance=2", import.meta.url).href;
  const first: typeof import("../fetch-registry.ts") = await import(firstHref);
  const second: typeof import("../fetch-registry.ts") = await import(secondHref);
  assert.notStrictEqual(first.WebAccessScope, second.WebAccessScope);

  const scope1 = first.getWebAccessScope();
  const scope2 = second.getWebAccessScope();
  assert.strictEqual(scope1, scope2);
  assert.strictEqual(scope1, getWebAccessScope());

  const transport: FetchTransport = {
    id: "cross-copy-transport",
    hosted: false,
    available: () => true,
    fetch: async () => null,
  };
  const extractor: ContentExtractor = {
    id: "cross-copy-extractor",
    priority: 99,
    match: () => false,
    extract: async () => null,
  };
  const unregisterTransport = first.registerFetchTransport(transport);
  const unregisterExtractor = first.registerContentExtractor(extractor);
  try {
    const viaSecond = second.getWebAccessScope();
    assert.strictEqual(viaSecond.getFetchTransport("cross-copy-transport"), transport);
    assert.strictEqual(viaSecond.extractors.get("cross-copy-extractor"), extractor);
    // Built-in registrations made by the extract.ts copy survive as well.
    assert.ok(viaSecond.getFetchTransport("http"));
    assert.ok(viaSecond.extractors.has("readability"));
  } finally {
    unregisterTransport();
    unregisterExtractor();
  }
});

test("response-stage extractor claims non-HTML responses before the plain-text fallback", async () => {
  const jsonBody = JSON.stringify({ name: "fixture", items: [1, 2] });
  const jsonFetch = async () =>
    new Response(jsonBody, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  const scope = createWebAccessScope();
  const seen: Array<{ stage: string; mimeType?: string }> = [];
  registerContentExtractor(
    {
      id: "custom.json",
      priority: 1,
      stage: "response",
      match: (ctx) => ctx.mimeType === "application/json",
      extract: async (ctx) => {
        seen.push({ stage: ctx.stage, mimeType: ctx.mimeType });
        const body = ctx.response ? await ctx.response.text() : "";
        const parsed: { name: string } = JSON.parse(body);
        return { url: ctx.url, title: `JSON ${parsed.name}`, content: "custom json", error: null };
      },
    },
    scope,
  );
  const claimed = await extractContent("https://api.example.com/data.json", undefined, {
    scope,
    lookup: publicLookup,
    fetch: jsonFetch,
  });
  assert.equal(claimed.error, null);
  assert.equal(claimed.title, "JSON fixture");
  assert.equal(claimed.content, "custom json");
  assert.deepEqual(seen, [{ stage: "response", mimeType: "application/json" }]);

  // Without a claiming extractor the built-in plain-text fallback is unchanged.
  const fallback = await extractContent("https://api.example.com/data.json", undefined, {
    scope: createWebAccessScope(),
    lookup: publicLookup,
    fetch: jsonFetch,
  });
  assert.equal(fallback.error, null);
  assert.equal(fallback.content, jsonBody);
});
