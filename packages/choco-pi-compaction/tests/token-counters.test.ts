import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import { DEFAULT_BACKGROUND_COMPACTION_SETTINGS } from "../src/background/contract.ts";
import type { TokenCounter } from "../src/background/contract.ts";
import { ownerTokenCounter } from "../src/background-host/backends.ts";
import {
  COUNT_TOKENS_NEGATIVE_TTL_MS,
  createProviderTokenCounter,
} from "../src/background-host/token-counters.ts";
import {
  type CompactionTokenCounter,
  registerCompactionTokenCounter,
  registeredTokenCounter,
} from "../src/background-host/token-counter-registry.ts";
import { registerCompactionTokenCounter as registerSharedCompactionTokenCounter } from "../../choco-pi-shared/src/compaction-token-counter-slot.ts";
import {
  ANTIGRAVITY_COUNT_TOKENS_ENV,
  registerAntigravityCompactionTokenCounter,
} from "../../choco-pi-provider-google-antigravity/src/compaction/token-counter.ts";
import { registerSyntheticCompactionTokenCounter } from "../../choco-pi-provider-synthetic/src/compaction/token-counter.ts";

const unregisterProviders: (() => void)[] = [];
before(() => {
  unregisterProviders.push(
    registerSyntheticCompactionTokenCounter(),
    registerAntigravityCompactionTokenCounter(),
  );
});
after(() => {
  for (const unregister of unregisterProviders.splice(0)) unregister();
});

const ANTIGRAVITY_ON = new Map([[ANTIGRAVITY_COUNT_TOKENS_ENV, true]]);

function model(provider: string, id: string, baseUrl: string): Model<Api> {
  return {
    id,
    name: id,
    api: provider === "anthropic" ? "anthropic-messages" : "openai-completions",
    provider,
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 524_288,
    maxTokens: 65_536,
  };
}

const SYNTHETIC = model("synthetic", "hf:zai-org/GLM-5.3", "https://api.synthetic.new/openai/v1");
const ANTHROPIC = model("anthropic", "claude-test", "https://api.anthropic.com");
const ANTIGRAVITY = model(
  "google",
  "gemini-3.8-flash",
  "https://daily-cloudcode-pa.googleapis.com",
);
const ANTIGRAVITY_KEY = JSON.stringify({ token: "fake-access-token", project_id: "fake-project" });

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function stubFetch(...responders: ((call: Call) => Promise<Response>)[]) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const call = { url, init };
    calls.push(call);
    const respond = responders.shift();
    if (respond === undefined) return Promise.reject(new Error("unexpected fetch"));
    return respond(call);
  };
  return { fetch, calls };
}

interface CountReply {
  readonly input_tokens?: number;
  readonly tokens?: number;
}

const json =
  (body: CountReply, status = 200) =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );

const empty500 = () => Promise.resolve(new Response("", { status: 500 }));

const rpcError = (status: number, rpcStatus: string) => () =>
  Promise.resolve(
    new Response(
      JSON.stringify({ error: { code: status, message: "denied", status: rpcStatus } }),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    ),
  );

const totalTokens = (count: number) => () =>
  Promise.resolve(
    new Response(JSON.stringify({ totalTokens: count }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

const hang = (call: Call) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = call.init?.signal;
    if (!signal) return reject(new Error("no signal"));
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

function registry(apiKey: string | undefined, headers: Record<string, string> = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    getApiKeyAndHeaders: async (_model: Model<Api>) => {
      calls++;
      return { ok: true as const, apiKey, headers };
    },
  };
}

function input(target: Model<Api>, notes: string[], signal = new AbortController().signal) {
  return {
    system: "SYSTEM",
    promptText: "PROMPT",
    model: target,
    signal,
    onDiagnostic: (note: string) => notes.push(note),
  };
}

function headerOf(call: Call | undefined, name: string): string | null {
  return new Headers(call?.init?.headers).get(name);
}

test("synthetic: a count is returned from the Anthropic-compatible endpoint", async () => {
  const stub = stubFetch(json({ input_tokens: 117_875 }));
  const counter = createProviderTokenCounter({ registry: registry("syn-key"), fetch: stub.fetch });
  const notes: string[] = [];
  assert.equal(await counter.countTokens(input(SYNTHETIC, notes)), 117_875);
  assert.deepEqual(notes, []);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]?.url, "https://api.synthetic.new/anthropic/v1/messages/count_tokens");
  assert.equal(headerOf(stub.calls[0], "x-api-key"), "syn-key");
  const body = JSON.parse(String(stub.calls[0]?.init?.body));
  assert.deepEqual(body, {
    model: "hf:zai-org/GLM-5.3",
    system: "SYSTEM",
    messages: [{ role: "user", content: [{ type: "text", text: "PROMPT" }] }],
  });
});

test("synthetic: a 500 falls back and is cached for ten minutes per model", async () => {
  let now = 1_000;
  const stub = stubFetch(empty500, empty500);
  const counter = createProviderTokenCounter({
    registry: registry("syn-key"),
    fetch: stub.fetch,
    now: () => now,
  });
  const notes: string[] = [];
  assert.equal(await counter.countTokens(input(SYNTHETIC, notes)), undefined);
  assert.equal(await counter.countTokens(input(SYNTHETIC, notes)), undefined);
  assert.equal(stub.calls.length, 1, "the second call within the TTL makes no request");
  assert.deepEqual(notes, ["count-tokens: http 500", "count-tokens: http 500 (cached)"]);
  now += COUNT_TOKENS_NEGATIVE_TTL_MS;
  assert.equal(await counter.countTokens(input(SYNTHETIC, notes)), undefined);
  assert.equal(stub.calls.length, 2, "an expired entry retries");
});

test("synthetic: a timeout falls back and is not cached", async () => {
  const stub = stubFetch(hang, json({ input_tokens: 42 }));
  const counter = createProviderTokenCounter({
    registry: registry("syn-key"),
    fetch: stub.fetch,
    timeoutMs: 20,
  });
  const notes: string[] = [];
  assert.equal(await counter.countTokens(input(SYNTHETIC, notes)), undefined);
  assert.deepEqual(notes, ["count-tokens: timeout"]);
  assert.equal(await counter.countTokens(input(SYNTHETIC, notes)), 42);
  assert.equal(stub.calls.length, 2);
});

test("an aborted preparation is not counted and not cached", async () => {
  const controller = new AbortController();
  const abortInFlight = (call: Call) => {
    const pending = hang(call);
    controller.abort();
    return pending;
  };
  const stub = stubFetch(abortInFlight, json({ input_tokens: 7 }));
  const counter = createProviderTokenCounter({ registry: registry("syn-key"), fetch: stub.fetch });
  const notes: string[] = [];
  assert.equal(await counter.countTokens(input(SYNTHETIC, notes, controller.signal)), undefined);
  assert.deepEqual(notes, ["count-tokens: aborted"]);
  assert.equal(await counter.countTokens(input(SYNTHETIC, notes)), 7);
  assert.equal(stub.calls.length, 2);

  const before = stubFetch();
  const early = createProviderTokenCounter({ registry: registry("syn-key"), fetch: before.fetch });
  assert.equal(await early.countTokens(input(SYNTHETIC, [], AbortSignal.abort())), undefined);
  assert.equal(before.calls.length, 0, "an already-aborted signal makes no request");
});

test("anthropic: counts with x-api-key and anthropic-version", async () => {
  const stub = stubFetch(json({ input_tokens: 9_001 }));
  const counter = createProviderTokenCounter({
    registry: registry("sk-ant-api03-test", { "anthropic-beta": "x" }),
    fetch: stub.fetch,
  });
  const notes: string[] = [];
  assert.equal(await counter.countTokens(input(ANTHROPIC, notes)), 9_001);
  const call = stub.calls[0];
  assert.equal(call?.url, "https://api.anthropic.com/v1/messages/count_tokens");
  assert.equal(headerOf(call, "x-api-key"), "sk-ant-api03-test");
  assert.equal(headerOf(call, "anthropic-version"), "2023-06-01");
  assert.equal(headerOf(call, "anthropic-beta"), "x");
  assert.deepEqual(JSON.parse(String(call?.init?.body)), {
    model: "claude-test",
    system: "SYSTEM",
    messages: [{ role: "user", content: [{ type: "text", text: "PROMPT" }] }],
  });
});

test("anthropic: a malformed body is cached; OAuth and missing keys make no request", async () => {
  const stub = stubFetch(json({ tokens: 1 }));
  const counter = createProviderTokenCounter({
    registry: registry("sk-ant-api03-test"),
    fetch: stub.fetch,
  });
  const notes: string[] = [];
  assert.equal(await counter.countTokens(input(ANTHROPIC, notes)), undefined);
  assert.equal(await counter.countTokens(input(ANTHROPIC, notes)), undefined);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(notes, ["count-tokens: malformed 200", "count-tokens: malformed 200 (cached)"]);

  const none = stubFetch();
  const oauth = createProviderTokenCounter({
    registry: registry("sk-ant-oat01-test"),
    fetch: none.fetch,
  });
  assert.equal(await oauth.countTokens(input(ANTHROPIC, [])), undefined);
  const keyless = createProviderTokenCounter({ registry: registry(undefined), fetch: none.fetch });
  assert.equal(await keyless.countTokens(input(ANTHROPIC, [])), undefined);
  assert.equal(none.calls.length, 0);
});

test("google (Antigravity): counting is off unless the env flag is 1 at creation", async () => {
  const saved = process.env[ANTIGRAVITY_COUNT_TOKENS_ENV];
  try {
    delete process.env[ANTIGRAVITY_COUNT_TOKENS_ENV];
    const stub = stubFetch(totalTokens(1));
    const auth = registry(ANTIGRAVITY_KEY);
    const off = createProviderTokenCounter({ registry: auth, fetch: stub.fetch });
    const notes: string[] = [];
    process.env[ANTIGRAVITY_COUNT_TOKENS_ENV] = "1";
    assert.equal(await off.countTokens(input(ANTIGRAVITY, notes)), undefined);
    assert.equal(stub.calls.length, 0);
    assert.equal(auth.calls, 0, "no credential is resolved while off");
    assert.deepEqual(notes, []);

    process.env[ANTIGRAVITY_COUNT_TOKENS_ENV] = "true";
    const notOne = createProviderTokenCounter({ registry: auth, fetch: stub.fetch });
    assert.equal(await notOne.countTokens(input(ANTIGRAVITY, [])), undefined);
    assert.equal(stub.calls.length, 0, "only the value 1 enables counting");

    process.env[ANTIGRAVITY_COUNT_TOKENS_ENV] = "1";
    const on = createProviderTokenCounter({ registry: auth, fetch: stub.fetch });
    assert.equal(await on.countTokens(input(ANTIGRAVITY, [])), 1);
    assert.equal(stub.calls.length, 1);
  } finally {
    if (saved === undefined) delete process.env[ANTIGRAVITY_COUNT_TOKENS_ENV];
    else process.env[ANTIGRAVITY_COUNT_TOKENS_ENV] = saved;
  }
});

test("google (Antigravity): counts through v1internal:countTokens with the runtime model id", async () => {
  const stub = stubFetch(totalTokens(4_321));
  const counter = createProviderTokenCounter({
    registry: registry(ANTIGRAVITY_KEY),
    fetch: stub.fetch,
    optIn: ANTIGRAVITY_ON,
  });
  const notes: string[] = [];
  assert.equal(await counter.countTokens(input(ANTIGRAVITY, notes)), 4_321);
  assert.deepEqual(notes, []);
  const call = stub.calls[0];
  assert.equal(call?.url, "https://daily-cloudcode-pa.googleapis.com/v1internal:countTokens");
  assert.equal(headerOf(call, "authorization"), "Bearer fake-access-token");
  assert.deepEqual(JSON.parse(String(call?.init?.body)), {
    request: {
      model: "gemini-3.8-flash-low",
      contents: [{ role: "user", parts: [{ text: "PROMPT" }] }],
      systemInstruction: { role: "user", parts: [{ text: "SYSTEM" }] },
    },
  });
});

test("google (Antigravity): a 403 is cached, a 429 is not", async () => {
  const denied = stubFetch(rpcError(403, "PERMISSION_DENIED"));
  const counter = createProviderTokenCounter({
    registry: registry(ANTIGRAVITY_KEY),
    fetch: denied.fetch,
    optIn: ANTIGRAVITY_ON,
  });
  const notes: string[] = [];
  assert.equal(await counter.countTokens(input(ANTIGRAVITY, notes)), undefined);
  assert.equal(await counter.countTokens(input(ANTIGRAVITY, notes)), undefined);
  assert.equal(denied.calls.length, 1, "a 403 does not fall back to the next endpoint or repeat");
  assert.deepEqual(notes, ["count-tokens: auth 403", "count-tokens: auth 403 (cached)"]);

  const limited = stubFetch(rpcError(429, "RESOURCE_EXHAUSTED"), totalTokens(8));
  const retrying = createProviderTokenCounter({
    registry: registry(ANTIGRAVITY_KEY),
    fetch: limited.fetch,
    optIn: ANTIGRAVITY_ON,
  });
  const limitedNotes: string[] = [];
  assert.equal(await retrying.countTokens(input(ANTIGRAVITY, limitedNotes)), undefined);
  assert.deepEqual(limitedNotes, ["count-tokens: rate-limit 429"]);
  assert.equal(await retrying.countTokens(input(ANTIGRAVITY, limitedNotes)), 8);
  assert.equal(limited.calls.length, 2);
});

test("google (Antigravity): an abort is not cached; an unknown model is", async () => {
  const controller = new AbortController();
  const abortInFlight = (call: Call) => {
    const pending = hang(call);
    controller.abort();
    return pending;
  };
  const stub = stubFetch(abortInFlight, totalTokens(3));
  const counter = createProviderTokenCounter({
    registry: registry(ANTIGRAVITY_KEY),
    fetch: stub.fetch,
    optIn: ANTIGRAVITY_ON,
  });
  const notes: string[] = [];
  assert.equal(await counter.countTokens(input(ANTIGRAVITY, notes, controller.signal)), undefined);
  assert.deepEqual(notes, ["count-tokens: aborted"]);
  assert.equal(await counter.countTokens(input(ANTIGRAVITY, notes)), 3);
  assert.equal(stub.calls.length, 2);

  const none = stubFetch();
  const unknown = model("google", "no-such-model", ANTIGRAVITY.baseUrl);
  const unknownNotes: string[] = [];
  const counted = createProviderTokenCounter({
    registry: registry(ANTIGRAVITY_KEY),
    fetch: none.fetch,
    optIn: ANTIGRAVITY_ON,
  });
  assert.equal(await counted.countTokens(input(unknown, unknownNotes)), undefined);
  assert.deepEqual(unknownNotes, ["count-tokens: model-unavailable"]);
  assert.equal(none.calls.length, 0);
});

test("google (Antigravity): a Gemini API key or another non-OAuth key is skipped without a request", async () => {
  for (const key of ["AIzaFAKE-gemini-api-key-for-tests", "not-json", '{"token":"t"}']) {
    const none = stubFetch();
    const counter = createProviderTokenCounter({
      registry: registry(key),
      fetch: none.fetch,
      optIn: ANTIGRAVITY_ON,
    });
    const notes: string[] = [];
    assert.equal(await counter.countTokens(input(ANTIGRAVITY, notes)), undefined, key);
    assert.equal(await counter.countTokens(input(ANTIGRAVITY, notes)), undefined, key);
    assert.deepEqual(notes, [], key);
    assert.equal(none.calls.length, 0, key);
  }
});

test("an unsupported provider makes no request and resolves no auth", async () => {
  const stub = stubFetch();
  const auth = registry("key");
  const counter = createProviderTokenCounter({ registry: auth, fetch: stub.fetch });
  const notes: string[] = [];
  const other = model("openai", "gpt-test", "https://api.openai.com/v1");
  assert.equal(await counter.countTokens(input(other, notes)), undefined);
  assert.equal(stub.calls.length, 0);
  assert.equal(auth.calls, 0);
  assert.deepEqual(notes, []);
});

test("a failure that would throw is contained", async () => {
  const throwingRegistry = {
    getApiKeyAndHeaders: async (): Promise<{ ok: true; apiKey: string }> => {
      throw new Error("registry exploded");
    },
  };
  const notes: string[] = [];
  const counter = createProviderTokenCounter({
    registry: throwingRegistry,
    fetch: stubFetch().fetch,
  });
  assert.equal(await counter.countTokens(input(SYNTHETIC, notes)), undefined);
  assert.deepEqual(notes, ["count-tokens: error"]);

  const throwingFetch: typeof globalThis.fetch = () => {
    throw new TypeError("sync throw");
  };
  const badUrl = model("synthetic", "hf:x/y", "not a url");
  const viaFetch = createProviderTokenCounter({ registry: registry("k"), fetch: throwingFetch });
  assert.equal(await viaFetch.countTokens(input(SYNTHETIC, [])), undefined);
  assert.equal(await viaFetch.countTokens(input(badUrl, [])), undefined, "invalid baseUrl");

  const anthropicBadUrl = model("anthropic", "claude-test", "ftp://example.com");
  const badAnthropic = createProviderTokenCounter({
    registry: registry("sk-ant-api03-test"),
    fetch: throwingFetch,
  });
  assert.equal(await badAnthropic.countTokens(input(anthropicBadUrl, [])), undefined);

  const throwingSink = {
    ...input(SYNTHETIC, []),
    onDiagnostic: () => {
      throw new Error("sink exploded");
    },
  };
  const sinkCounter = createProviderTokenCounter({
    registry: registry("k"),
    fetch: stubFetch(empty500).fetch,
  });
  assert.equal(await sinkCounter.countTokens(throwingSink), undefined);
});

test("ownerTokenCounter: default provider counter, injected seam, and countTokens:false", async () => {
  const settings = { ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS, enabled: true };
  const auth = registry("key");
  const spec = { model: SYNTHETIC, modelRegistry: auth, settings };
  const owned = ownerTokenCounter(
    { ...spec, model: model("openai", "gpt", "https://api.openai.com/v1") },
    {},
  );
  assert.ok(owned, "a provider counter is wired by default");
  assert.equal(
    await owned.counter.countTokens(input(owned.model, [])),
    undefined,
    "an uncounted provider resolves undefined without auth or network",
  );
  assert.equal(auth.calls, 0);

  const injected: TokenCounter = { countTokens: async () => 5 };
  assert.equal(ownerTokenCounter(spec, { tokenCounter: injected })?.counter, injected);

  const off = { ...spec, settings: { ...settings, countTokens: false } };
  assert.equal(ownerTokenCounter(off, {}), undefined, "disabled: no counter, so no request");
  assert.equal(ownerTokenCounter(off, { tokenCounter: injected }), undefined);
});

test("registry: the newest registration answers and unregister removes only its own", async () => {
  const provider = "test-provider-registry";
  const counter = (tokens: number): CompactionTokenCounter => ({
    countTokens: async () => ({ ok: true, inputTokens: tokens }),
  });
  const first = counter(1);
  const second = counter(2);
  const dropFirst = registerCompactionTokenCounter(provider, first);
  const dropSecond = registerCompactionTokenCounter(provider, second);
  try {
    assert.equal(registeredTokenCounter(provider), second);
    const counted = createProviderTokenCounter({
      registry: registry("k"),
      fetch: stubFetch().fetch,
    });
    const target = model(provider, "m", "https://example.test");
    assert.equal(await counted.countTokens(input(target, [])), 2);
    dropFirst();
    dropFirst();
    assert.equal(
      registeredTokenCounter(provider),
      second,
      "a stale unregister keeps the newer one",
    );
    dropSecond();
    assert.equal(registeredTokenCounter(provider), undefined);
    assert.equal(
      await counted.countTokens(input(target, [])),
      undefined,
      "unregistered: uncounted",
    );
  } finally {
    dropFirst();
    dropSecond();
  }
});

test("registry: a counter failure code, cache override, and an unreadable answer", async () => {
  const provider = "test-provider-outcomes";
  const answers: Awaited<ReturnType<CompactionTokenCounter["countTokens"]>>[] = [
    { ok: false, code: "quota", status: 402 },
    { ok: false, code: "network", cache: true },
  ];
  const drop = registerCompactionTokenCounter(provider, {
    countTokens: async () => answers.shift() ?? { skipped: true },
  });
  try {
    let now = 0;
    const counted = createProviderTokenCounter({
      registry: registry("k"),
      fetch: stubFetch().fetch,
      now: () => now,
    });
    const notes: string[] = [];
    const target = model(provider, "m", "https://example.test");
    assert.equal(await counted.countTokens(input(target, notes)), undefined);
    assert.equal(await counted.countTokens(input(target, notes)), undefined);
    assert.equal(await counted.countTokens(input(target, notes)), undefined);
    assert.deepEqual(notes, [
      "count-tokens: quota 402",
      "count-tokens: network",
      "count-tokens: network (cached)",
    ]);
    now += COUNT_TOKENS_NEGATIVE_TTL_MS;
    assert.equal(await counted.countTokens(input(target, notes)), undefined);
    assert.equal(notes.length, 3, "a skip after the TTL reports nothing");
  } finally {
    drop();
  }

  const malformed = "test-provider-malformed";
  const dropMalformed = registerCompactionTokenCounter(malformed, {
    countTokens: async () => ({ ok: true, inputTokens: -1 }),
  });
  try {
    const notes: string[] = [];
    const counted = createProviderTokenCounter({
      registry: registry("k"),
      fetch: stubFetch().fetch,
    });
    assert.equal(
      await counted.countTokens(input(model(malformed, "m", "https://x.test"), notes)),
      undefined,
    );
    assert.deepEqual(notes, ["count-tokens: error"]);
  } finally {
    dropMalformed();
  }
});

test("the same counter registered twice keeps one lease after an idempotent first unregister", () => {
  const counter: CompactionTokenCounter = { countTokens: async () => ({ skipped: true }) };
  const first = registerCompactionTokenCounter("test-provider", counter);
  const second = registerCompactionTokenCounter("test-provider", counter);
  try {
    first();
    first();
    assert.equal(registeredTokenCounter("test-provider"), counter);
    second();
    assert.equal(registeredTokenCounter("test-provider"), undefined);
  } finally {
    first();
    second();
  }
});

test("shared slot: the same counter registered twice keeps one lease after an idempotent first unregister", () => {
  const counter: CompactionTokenCounter = { countTokens: async () => ({ skipped: true }) };
  const first = registerSharedCompactionTokenCounter("test-provider", counter);
  const second = registerSharedCompactionTokenCounter("test-provider", counter);
  try {
    first();
    first();
    assert.equal(registeredTokenCounter("test-provider"), counter);
    second();
    assert.equal(registeredTokenCounter("test-provider"), undefined);
  } finally {
    first();
    second();
  }
});

test("a blank provider id is rejected by both registries and valid lookups stay intact", () => {
  const counter: CompactionTokenCounter = { countTokens: async () => ({ skipped: true }) };
  const unregister = registerCompactionTokenCounter("test-intact", counter);
  try {
    for (const providerId of ["", "   "]) {
      assert.throws(
        () => registerSharedCompactionTokenCounter(providerId, counter),
        /must not be empty/,
      );
      assert.throws(() => registerCompactionTokenCounter(providerId, counter), /must not be empty/);
    }
    assert.equal(registeredTokenCounter("test-intact"), counter);
  } finally {
    unregister();
  }
});
