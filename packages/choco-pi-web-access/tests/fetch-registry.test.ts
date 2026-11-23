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
