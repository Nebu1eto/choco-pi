import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createSyntheticSearchBackend,
  SYNTHETIC_SEARCH_ADAPTER_ID,
  SYNTHETIC_SEARCH_PROVIDER_FAMILY,
} from "../extensions/web-search/backend.ts";

const subscriptionQuotas = {
  subscription: { limit: 100, requests: 1, renewsAt: "2027-01-01T00:00:00Z" },
};

const searchResponse = {
  results: [
    {
      title: "Synthetic result",
      url: "https://example.test/result",
      text: "Result body",
      published: "2026-09-21",
    },
  ],
};

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

test("Synthetic search backend production boundaries", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  await context.test("does no credential or network work when disabled", async () => {
    let credentialCalls = 0;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response();
    };
    const backend = createSyntheticSearchBackend({
      loadConfig: async () => ({ webSearch: false }),
      getApiKey: async () => {
        credentialCalls++;
        return "secret";
      },
    });

    assert.deepEqual(await backend.resolveAvailability(), {
      status: "disabled",
      reason: "Synthetic web search is disabled by configuration.",
    });
    assert.equal(credentialCalls, 0);
    assert.equal(fetchCalls, 0);
  });

  await context.test(
    "uses registry credentials for direct quota and /v2/search calls",
    async () => {
      const requests: Array<{
        url: string;
        authorization: string | null;
        body: string;
      }> = [];
      globalThis.fetch = async (input, init) => {
        const url = requestUrl(input);
        const headers = new Headers(init?.headers);
        const request = new Request(input, init);
        requests.push({
          url,
          authorization: headers.get("authorization"),
          body: await request.text(),
        });
        return Response.json(url.endsWith("/v2/quotas") ? subscriptionQuotas : searchResponse);
      };
      let credentialCalls = 0;
      const backend = createSyntheticSearchBackend({
        loadConfig: async () => ({ webSearch: true }),
        getApiKey: async () => {
          credentialCalls++;
          return "registry-synthetic-key";
        },
      });

      const result = await backend.search("independent registry key");

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.deepEqual(result.backend, {
        adapterId: SYNTHETIC_SEARCH_ADAPTER_ID,
        providerFamily: SYNTHETIC_SEARCH_PROVIDER_FAMILY,
        transport: "synthetic-v2-search",
      });
      assert.deepEqual(result.results, searchResponse.results);
      assert.equal(credentialCalls, 1);
      assert.deepEqual(
        requests.map(({ url }) => url),
        ["https://api.synthetic.new/v2/quotas", "https://api.synthetic.new/v2/search"],
      );
      assert.deepEqual(
        requests.map(({ authorization }) => authorization),
        ["Bearer registry-synthetic-key", "Bearer registry-synthetic-key"],
      );
      assert.equal(requests[1]?.body, JSON.stringify({ query: "independent registry key" }));
    },
  );

  await context.test(
    "does not reuse credential A entitlement after rotation to PAYG credential B",
    async () => {
      const authorizations: Array<string | null> = [];
      globalThis.fetch = async (input, init) => {
        const url = requestUrl(input);
        const authorization = new Headers(init?.headers).get("authorization");
        authorizations.push(authorization);
        if (url.endsWith("/v2/search")) return Response.json(searchResponse);
        return Response.json(authorization === "Bearer credential-a" ? subscriptionQuotas : {});
      };
      let credentialCalls = 0;
      const backend = createSyntheticSearchBackend({
        loadConfig: async () => ({ webSearch: true }),
        getApiKey: async () => {
          credentialCalls++;
          return credentialCalls === 1 ? "credential-a" : "credential-b";
        },
      });

      assert.equal((await backend.search("credential A")).ok, true);
      assert.deepEqual(await backend.search("credential B"), {
        ok: false,
        error: {
          kind: "ineligible",
          message:
            "Synthetic web search requires an eligible subscription; PAYG is not auto-enabled.",
          retryable: false,
        },
      });
      assert.equal(credentialCalls, 2);
      assert.deepEqual(authorizations, [
        "Bearer credential-a",
        "Bearer credential-a",
        "Bearer credential-b",
      ]);
    },
  );

  await context.test(
    "supports an unauthenticated proxy without resolving credentials",
    async () => {
      let credentialCalls = 0;
      const urls: string[] = [];
      globalThis.fetch = async (input) => {
        const url = requestUrl(input);
        urls.push(url);
        return Response.json(url.endsWith("/v2/quotas") ? subscriptionQuotas : searchResponse);
      };
      const backend = createSyntheticSearchBackend({
        loadConfig: async () => ({
          webSearch: true,
          proxyUrl: "https://proxy.example.test/base/",
          proxyRequiresAuth: false,
        }),
        getApiKey: async () => {
          credentialCalls++;
          return "must-not-be-read";
        },
      });

      const result = await backend.search("proxy search");

      assert.equal(result.ok, true);
      assert.equal(credentialCalls, 0);
      assert.deepEqual(urls, [
        "https://proxy.example.test/base/v2/quotas",
        "https://proxy.example.test/base/v2/search",
      ]);
    },
  );

  await context.test("keeps PAYG unavailable and never sends a paid search", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = requestUrl(input);
      urls.push(url);
      return Response.json({});
    };
    const backend = createSyntheticSearchBackend({
      loadConfig: async () => ({ webSearch: true }),
      getApiKey: async () => "payg-key",
    });

    const result = await backend.search("must not run");

    assert.deepEqual(result, {
      ok: false,
      error: {
        kind: "ineligible",
        message:
          "Synthetic web search requires an eligible subscription; PAYG is not auto-enabled.",
        retryable: false,
      },
    });
    assert.deepEqual(urls, ["https://api.synthetic.new/v2/quotas"]);
  });

  await context.test("reports abort without exposing a request error", async () => {
    globalThis.fetch = async (_input, init) => {
      await delay(30_000, undefined, { signal: init?.signal ?? undefined });
      return Response.json(searchResponse);
    };
    const backend = createSyntheticSearchBackend({
      loadConfig: async () => ({ webSearch: true }),
      getApiKey: async () => "secret",
    });
    const controller = new AbortController();
    const pending = backend.search("cancelled", controller.signal);
    controller.abort();

    assert.deepEqual(await pending, {
      ok: false,
      error: {
        kind: "aborted",
        message: "Synthetic web search was cancelled.",
        retryable: false,
      },
    });
  });

  await context.test("marks an invalidated in-flight session stale", async () => {
    globalThis.fetch = async (_input, init) => {
      await delay(30_000, undefined, { signal: init?.signal ?? undefined });
      return Response.json(searchResponse);
    };
    const backend = createSyntheticSearchBackend({
      loadConfig: async () => ({ webSearch: true }),
      getApiKey: async () => "secret",
    });
    const pending = backend.search("stale");
    await Promise.resolve();
    backend.invalidate();

    assert.deepEqual(await pending, {
      ok: false,
      error: {
        kind: "stale",
        message: "Synthetic web search belongs to an inactive session.",
        retryable: false,
      },
    });
  });

  await context.test("preserves auth, quota, network, and request failure categories", async () => {
    const createBackend = () =>
      createSyntheticSearchBackend({
        loadConfig: async () => ({ webSearch: true }),
        getApiKey: async () => "secret-api-key",
      });

    globalThis.fetch = async () => new Response("token=must-not-leak", { status: 401 });
    assert.deepEqual(await createBackend().search("auth"), {
      ok: false,
      error: {
        kind: "auth",
        message: "Synthetic credentials were rejected.",
        retryable: false,
      },
    });

    globalThis.fetch = async () => new Response("quota-secret=must-not-leak", { status: 429 });
    assert.deepEqual(await createBackend().search("quota"), {
      ok: false,
      error: {
        kind: "quota",
        message: "Synthetic quota prevents web search.",
        retryable: true,
      },
    });

    globalThis.fetch = async () => {
      throw new TypeError("proxy-secret=must-not-leak");
    };
    assert.deepEqual(await createBackend().search("network"), {
      ok: false,
      error: {
        kind: "network",
        message: "Synthetic subscription eligibility could not be reached.",
        retryable: true,
      },
    });

    globalThis.fetch = async (input) =>
      Response.json(
        requestUrl(input).endsWith("/v2/quotas")
          ? subscriptionQuotas
          : { error: "request-secret=must-not-leak" },
        { status: requestUrl(input).endsWith("/v2/quotas") ? 200 : 502 },
      );
    assert.deepEqual(await createBackend().search("request"), {
      ok: false,
      error: {
        kind: "request",
        message: "Synthetic web search request failed.",
        retryable: true,
      },
    });
  });

  await context.test("does not share entitlement between backend sessions", async () => {
    const quotaUrls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = requestUrl(input);
      quotaUrls.push(url);
      return Response.json(url.startsWith("https://sub.example.test") ? subscriptionQuotas : {});
    };
    const subscriptionSession = createSyntheticSearchBackend({
      loadConfig: async () => ({
        webSearch: true,
        proxyUrl: "https://sub.example.test",
        proxyRequiresAuth: false,
      }),
      getApiKey: async () => undefined,
    });
    const paygSession = createSyntheticSearchBackend({
      loadConfig: async () => ({
        webSearch: true,
        proxyUrl: "https://payg.example.test",
        proxyRequiresAuth: false,
      }),
      getApiKey: async () => undefined,
    });

    assert.deepEqual(await subscriptionSession.resolveAvailability(), {
      status: "available",
    });
    assert.equal((await paygSession.resolveAvailability()).status, "ineligible");
    assert.deepEqual(quotaUrls, [
      "https://sub.example.test/v2/quotas",
      "https://payg.example.test/v2/quotas",
    ]);
  });
});
