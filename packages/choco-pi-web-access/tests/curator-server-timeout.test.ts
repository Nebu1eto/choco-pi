// @ts-nocheck
import assert from "node:assert/strict";
import { access, unlink, writeFile } from "node:fs/promises";
import { after, test } from "node:test";

const curatorPageShim = new URL("../curator-page.js", import.meta.url);
let wroteCuratorPageShim = false;

const TEST_TIMEOUT_MS = 8000;

async function loadServer() {
  try {
    await access(curatorPageShim);
  } catch {
    await writeFile(
      curatorPageShim,
      'export { generateCuratorPage } from "./curator-page.ts";\n',
      "utf8",
    );
    wroteCuratorPageShim = true;
  }

  return import(`../curator-server.ts?test=${Date.now()}`);
}

after(async () => {
  if (!wroteCuratorPageShim) return;
  await unlink(curatorPageShim).catch(() => {});
});

function baseOptions(timeout = 1) {
  return {
    queries: ["test query"],
    sessionToken: "test-token",
    timeout,
    availableProviders: { all: true, openai: false, exa: true, kagi: true },
    defaultProvider: "exa",
    searchProvider: "exa",
    summaryModels: [],
    defaultSummaryModel: null,
  };
}

function baseCallbacks(resolveCancel) {
  return {
    onSubmit: () => {},
    onCancel: resolveCancel,
    onProviderChange: () => {},
    onAddSearch: async () => [{ answer: "", results: [], provider: "exa" }],
    onAddSearchResults: () => {},
    onSummarize: async () => ({
      summary: "",
      meta: { model: null, durationMs: 0, tokenEstimate: 0, fallbackUsed: true },
    }),
    onRewriteQuery: async (query) => query,
  };
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), TEST_TIMEOUT_MS);
    }),
  ]);
}

async function readEventStreamUntil(response, marker, label) {
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    await withTimeout(
      (async () => {
        while (!text.includes(marker)) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
        }
      })(),
      label,
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

test("curator times out when searches finish but no browser connects", async () => {
  const { startCuratorServer } = await loadServer();
  let resolveCancel;
  const cancelPromise = new Promise((resolve) => {
    resolveCancel = resolve;
  });
  const handle = await startCuratorServer(baseOptions(1), baseCallbacks(resolveCancel));

  try {
    handle.pushResult(0, { answer: "answer", results: [], provider: "exa" });
    handle.searchesDone();

    const reason = await withTimeout(cancelPromise, "no-browser timeout");
    assert.equal(reason, "timeout");
  } finally {
    handle.close();
  }
});

test("curator replays search events after SSE reconnect", async () => {
  const { startCuratorServer } = await loadServer();
  const handle = await startCuratorServer(
    baseOptions(20),
    baseCallbacks(() => {}),
  );

  try {
    const eventsUrl = new URL("/events", handle.url);
    eventsUrl.searchParams.set("session", "test-token");
    const firstResponse = await fetch(eventsUrl);
    assert.equal(firstResponse.status, 200);

    handle.pushResult(0, { answer: "answer", results: [], provider: "exa" });
    await firstResponse.body.cancel().catch(() => {});

    const secondResponse = await fetch(eventsUrl);
    const body = await readEventStreamUntil(secondResponse, "event: result", "sse replay");
    assert.match(body, /event: result/);
    assert.match(body, /"answer":"answer"/);
  } finally {
    handle.close();
  }
});

test("curator submit rejects contradictory summary metadata", async () => {
  const { startCuratorServer } = await loadServer();
  const handle = await startCuratorServer(
    baseOptions(20),
    baseCallbacks(() => {}),
  );

  try {
    for (const summaryMeta of [
      {
        model: null,
        durationMs: 0,
        tokenEstimate: 0,
        fallbackUsed: false,
        phase: "deterministic-fallback",
      },
      {
        model: "model",
        durationMs: 0,
        tokenEstimate: 0,
        fallbackUsed: true,
        phase: "summary-model",
      },
    ]) {
      const response = await fetch(new URL("/submit", handle.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "test-token", selected: [], summaryMeta }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { ok: false, error: "Invalid summaryMeta" });
    }
  } finally {
    handle.close();
  }
});

test("curator assigns one selectable result index per provider", async () => {
  const { startCuratorServer } = await loadServer();
  const indexedEntries = [];
  let summarySelection = [];
  const callbacks = baseCallbacks(() => {});
  callbacks.onAddSearch = async () => [
    {
      answer: "Exa answer",
      results: [{ title: "Exa", url: "https://example.com/exa", domain: "example.com" }],
      provider: "exa",
    },
    {
      answer: "Kagi answer",
      results: [{ title: "Kagi", url: "https://example.com/kagi", domain: "example.com" }],
      provider: "kagi",
    },
  ];
  callbacks.onAddSearchResults = (entries) => indexedEntries.push(...entries);
  callbacks.onSummarize = async (selected) => {
    summarySelection = selected;
    return {
      summary: "Combined summary",
      meta: { model: null, durationMs: 0, tokenEstimate: 0, fallbackUsed: true },
    };
  };

  const handle = await startCuratorServer(baseOptions(20), callbacks);
  try {
    const searchResponse = await fetch(new URL("/search", handle.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "test-token", query: "combined query", provider: "all" }),
    });
    assert.equal(searchResponse.status, 200);
    const searchBody = await searchResponse.json();
    assert.deepEqual(
      searchBody.entries.map((entry) => entry.provider),
      ["exa", "kagi"],
    );
    assert.deepEqual(
      searchBody.entries.map((entry) => entry.queryIndex),
      [1, 2],
    );
    assert.deepEqual(
      indexedEntries.map((entry) => entry.queryIndex),
      [1, 2],
    );

    const summarizeResponse = await fetch(new URL("/summarize", handle.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "test-token", selected: [1, 2] }),
    });
    assert.equal(summarizeResponse.status, 200);
    assert.deepEqual(summarySelection, [1, 2]);
  } finally {
    handle.close();
  }
});

test("curator heartbeat timeout finalizes connected idle browser sessions", async () => {
  const { startCuratorServer } = await loadServer();
  let resolveCancel;
  const cancelPromise = new Promise((resolve) => {
    resolveCancel = resolve;
  });
  const handle = await startCuratorServer(baseOptions(20), baseCallbacks(resolveCancel));

  try {
    await fetch(handle.url);
    handle.pushResult(0, { answer: "answer", results: [], provider: "exa" });
    handle.searchesDone();

    const response = await fetch(new URL("/heartbeat", handle.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "test-token", idleMs: 21000, timeoutSec: 20 }),
    });
    assert.equal(response.status, 200);

    const reason = await withTimeout(cancelPromise, "idle heartbeat timeout");
    assert.equal(reason, "timeout");
  } finally {
    handle.close();
  }
});

test("curator state replay keeps current results and compacts superseded history", async () => {
  const { startCuratorServer } = await loadServer();
  const handle = await startCuratorServer(
    baseOptions(20),
    baseCallbacks(() => {}),
  );

  try {
    for (let i = 0; i < 205; i++) {
      handle.pushResult(i, {
        answer: `answer ${i}`,
        results: [],
        provider: "exa",
        query: `query ${i}`,
      });
    }
    handle.pushError(0, "updated", "exa", { query: "query 0" });

    const response = await fetch(new URL("/state?session=test-token", handle.url));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.events.length, 205);
    assert.equal(body.events[0].event, "search-error");
    assert.equal(body.events[0].data.queryIndex, 0);
    assert.equal(body.events[204].data.queryIndex, 204);
  } finally {
    handle.close();
  }
});

test("curator state replay keeps all-provider entries that share one slot", async () => {
  const { startCuratorServer } = await loadServer();
  const handle = await startCuratorServer(
    baseOptions(20),
    baseCallbacks(() => {}),
  );

  try {
    handle.pushResult(0, {
      answer: "exa answer",
      results: [],
      provider: "exa",
      query: "query",
      slotIndex: 0,
    });
    handle.pushResult(1, {
      answer: "kagi answer",
      results: [],
      provider: "kagi",
      query: "query",
      slotIndex: 0,
    });

    const response = await fetch(new URL("/state?session=test-token", handle.url));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.events.map((event) => event.data.provider),
      ["exa", "kagi"],
    );
    assert.deepEqual(
      body.events.map((event) => event.data.queryIndex),
      [0, 1],
    );
    assert.deepEqual(
      body.events.map((event) => event.data.slotIndex),
      [0, 0],
    );
  } finally {
    handle.close();
  }
});

test("curator keeps simultaneous rewrite requests independent while open", async () => {
  const { startCuratorServer } = await loadServer();
  const callbacks = baseCallbacks(() => {});
  const pending = new Map();
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  callbacks.onRewriteQuery = (query, signal) =>
    new Promise((resolve) => {
      pending.set(query, { resolve, signal });
      if (pending.size === 2) resolveStarted();
    });

  const handle = await startCuratorServer(baseOptions(20), callbacks);
  try {
    const responses = ["first", "second"].map((query) =>
      fetch(new URL("/rewrite", handle.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "test-token", query }),
      }),
    );
    await withTimeout(started, "simultaneous rewrites");
    assert.equal(pending.get("first").signal.aborted, false);
    assert.equal(pending.get("second").signal.aborted, false);
    pending.get("first").resolve("rewritten first");
    pending.get("second").resolve("rewritten second");

    const resolved = await Promise.all(responses);
    assert.deepEqual(
      resolved.map((response) => response.status),
      [200, 200],
    );
    assert.deepEqual(await Promise.all(resolved.map((response) => response.json())), [
      { ok: true, query: "rewritten first" },
      { ok: true, query: "rewritten second" },
    ]);
  } finally {
    handle.close();
  }
});

test("curator close aborts a rewrite and rejects its late success", async () => {
  const { startCuratorServer } = await loadServer();
  const callbacks = baseCallbacks(() => {});
  let rewriteSignal;
  let resolveRewrite;
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  callbacks.onRewriteQuery = (_query, signal) => {
    rewriteSignal = signal;
    resolveStarted();
    return new Promise((resolve) => {
      resolveRewrite = resolve;
    });
  };

  const handle = await startCuratorServer(baseOptions(20), callbacks);
  const responsePromise = fetch(new URL("/rewrite", handle.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "test-token", query: "original" }),
  });
  try {
    await withTimeout(started, "rewrite start");
    handle.close();
    assert.equal(rewriteSignal.aborted, true);
    resolveRewrite("late rewrite");

    const response = await withTimeout(responsePromise, "cancelled rewrite response");
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "Rewrite request cancelled",
    });
  } finally {
    handle.close();
  }
});

test("curator reports an aborted stale rewrite as cancellation", async () => {
  const { startCuratorServer } = await loadServer();
  const callbacks = baseCallbacks(() => {});
  let rewriteSignal;
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const staleContextMessage =
    "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";
  callbacks.onRewriteQuery = (_query, signal) => {
    rewriteSignal = signal;
    resolveStarted();
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error(staleContextMessage)), {
        once: true,
      });
    });
  };

  const handle = await startCuratorServer(baseOptions(20), callbacks);
  const responsePromise = fetch(new URL("/rewrite", handle.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "test-token", query: "original" }),
  });
  try {
    await withTimeout(started, "stale rewrite start");
    handle.close();
    assert.equal(rewriteSignal.aborted, true);

    const response = await withTimeout(responsePromise, "stale rewrite response");
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.deepEqual(body, { ok: false, error: "Rewrite request cancelled" });
    assert.doesNotMatch(body.error, /extension ctx is stale/);
  } finally {
    handle.close();
  }
});
