import assert from "node:assert/strict";
import test from "node:test";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  DAYBREAK_BRIDGE_SYMBOL,
  type CodexDaybreakDecision,
  type DaybreakBridge,
  type DaybreakController,
  type DaybreakOutcome,
  type DaybreakState,
} from "../src/providers/openai-codex/daybreak-types.ts";
import {
  applyCodexDaybreakAccessPrograms,
  beginCodexDaybreakRequest,
  configureCodexDaybreakEntitlementForTest,
  invalidateCodexDaybreakEntitlement,
  isCurrentCodexDaybreakDecision,
  resolveCodexDaybreakTicket,
  reportCodexDaybreakResponse,
  snapshotCodexDaybreakDecision,
  type CodexDaybreakTicket,
} from "../src/providers/openai-codex/daybreak-decision.ts";
import {
  DAYBREAK_CACHE_MAX_ENTRIES,
  DAYBREAK_ENTITLEMENT_TTL_MS,
  daybreakAccount,
  hasCodexDaybreakEntitlementEntry,
} from "../src/providers/openai-codex/daybreak-entitlement.ts";
import {
  createOpenAICodexProviderStream,
  prepareCodexRequestBody,
  prewarmOpenAICodexWebSocket,
} from "../src/providers/openai-codex-custom-provider.ts";
import {
  processCodexResponsesStream,
  processMappedCodexResponsesStream,
} from "../src/providers/openai-codex/stream-events.ts";
import { buildRequestBody } from "../src/providers/openai-codex/request-body.ts";
import { buildCachedWebSocketRequestBody } from "../src/providers/openai-codex/websocket-continuation.ts";
import { sendPreparedWebSocketRequest } from "../src/providers/openai-codex/websocket-stream.ts";
import { createCodexTransportStream } from "../src/providers/openai-codex/transport-recovery.ts";
import {
  isResponsesBody,
  type CodexStreamEvent,
  type OpenAICodexStreamOptions,
  type ResponsesBody,
} from "../src/providers/openai-codex/types.ts";
import { executeRemoteCompactionV2 } from "../src/adapter/compaction/remote-v2-client.ts";
import {
  rewriteCodexPrewarmProviderRequest,
  rewriteCodexProviderRequest,
} from "../src/adapter/provider-request.ts";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import type { AdapterState } from "../src/adapter/activation/state.ts";
import { createCodexTurnState } from "../src/providers/openai-codex/turn-state.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

import { configureCodexDaybreakModelSupportForTest } from "../src/providers/openai-codex/daybreak-model-support.ts";

const model: Model<"openai-codex-responses"> = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
};
const foreignModel: Model<"openai-codex-responses"> = {
  ...model,
  baseUrl: "https://proxy.example.test/backend-api",
};
const stockModel: Model<"openai-responses"> = {
  ...model,
  api: "openai-responses",
  provider: "stock-responses",
  baseUrl: "https://api.example.test/v1",
};
const context = normalizeContext({
  systemPrompt: "Instructions.",
  messages: [{ role: "user", content: "Hello.", timestamp: 1 }],
});

const AccessProgramsSchema = Type.Object({
  access_programs: Type.Object({ cyber: Type.String() }),
});
const FrameSchema = Type.Object({ type: Type.Literal("response.create") });
const WireBodySchema = Type.Record(Type.String(), Type.Unknown());
type WireBody = Static<typeof WireBodySchema>;
const CYBER_BY_OUTCOME = new Map<DaybreakOutcome, string>([
  ["blue", "daybreak_blue"],
  ["red", "daybreak_red"],
]);

function token(accountId: string, nonce = "a"): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId }, nonce }),
  ).toString("base64url");
  return `e30.${payload}.signature`;
}

function cyberOf(body: WireBody | undefined): string | undefined {
  return Value.Check(AccessProgramsSchema, body) ? body.access_programs.cyber : undefined;
}

function hasAccessPrograms(body: WireBody | undefined): boolean {
  return body !== undefined && Object.hasOwn(body, "access_programs");
}

const decompress = promisify(zstdDecompress);

async function requestText(init: RequestInit | undefined): Promise<string> {
  const body = init?.body;
  if (!(body instanceof Uint8Array)) return String(body);
  const encoding = new Headers(init?.headers).get("content-encoding");
  const bytes = encoding === "zstd" ? await decompress(body) : body;
  return new TextDecoder().decode(bytes);
}

function parseWire(text: string | undefined): WireBody {
  assert.ok(text);
  const parsed: unknown = JSON.parse(text);
  assert.ok(Value.Check(WireBodySchema, parsed));
  return parsed;
}

const injectRed: NonNullable<OpenAICodexStreamOptions["onPayload"]> = (payload) =>
  isResponsesBody(payload) ? { ...payload, access_programs: { cyber: "daybreak_red" } } : payload;

type FakeController = {
  controller: DaybreakController;
  state: DaybreakState;
  reports: Array<readonly [DaybreakOutcome, number]>;
};

function fakeController(sessionId: string, requested: boolean, generation = 1): FakeController {
  const fake: FakeController = {
    state: { sessionId, requested, source: "explicit", revision: 1, generation, outcome: "off" },
    reports: [],
    controller: {
      getState: () => fake.state,
      subscribe: () => () => {},
      set: (next, source = "explicit") => {
        fake.state = { ...fake.state, requested: next, source, revision: fake.state.revision + 1 };
        return fake.state;
      },
      report: (outcome, revision) => {
        fake.reports.push([outcome, revision]);
        if (revision === fake.state.revision) fake.state = { ...fake.state, outcome };
      },
      dispose: () => undefined,
    },
  };
  return fake;
}

function installBridge() {
  const controllers = new Map<string, DaybreakController>();
  const bridge: DaybreakBridge = {
    version: 1,
    register: () => assert.fail("provider must not register controllers"),
    get: (sessionId) => controllers.get(sessionId),
    createExtension: () => assert.fail("provider must not create extensions"),
  };
  Object.defineProperty(globalThis, DAYBREAK_BRIDGE_SYMBOL, { configurable: true, value: bridge });
  return {
    add(sessionId: string, requested: boolean, generation = 1): FakeController {
      const fake = fakeController(sessionId, requested, generation);
      controllers.set(sessionId, fake.controller);
      return fake;
    },
    replace(sessionId: string, fake: FakeController) {
      controllers.set(sessionId, fake.controller);
    },
  };
}

type LookupCall = { url: string; headerNames: string[]; accept: string | null };

// Mirrors the live verified_access shape: grants are objects with a level and a source.
function grantsPayload(...levels: string[]) {
  const grants = levels.map((level) => ({ level, source: "individual" }));
  return {
    programs: [
      { program: "cyber", state: "active", grants, individual_blue_security_setup_required: false },
    ],
    unrelated: { x: 1 },
  };
}

function fakeLookup(respond: () => Response | Promise<Response>, now?: () => number) {
  const calls: LookupCall[] = [];
  const overrides: Parameters<typeof configureCodexDaybreakEntitlementForTest>[0] = {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: input instanceof Request ? input.url : String(input),
        headerNames: [...headers.keys()].sort(),
        accept: headers.get("accept"),
      });
      return respond();
    },
  };
  if (now) overrides.now = now;
  configureCodexDaybreakEntitlementForTest(overrides);
  configureCodexDaybreakModelSupportForTest({
    fetch: async () =>
      Response.json({
        models: [
          {
            slug: model.id,
            available_access_programs: { cyber: ["daybreak_blue", "daybreak_red"] },
          },
        ],
      }),
  });
  return calls;
}

function deferred<Value>() {
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ticket(sessionId: string, apiKey = token("acct-1"), target: Model<Api> = model) {
  return beginCodexDaybreakRequest({ sessionId, model: target, credentials: { apiKey } });
}

async function resolve(t: CodexDaybreakTicket): Promise<CodexDaybreakDecision> {
  const decision = await resolveCodexDaybreakTicket(t);
  assert.ok(decision);
  return decision;
}

async function waitFor(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !ready(); i++) await new Promise((resolve) => setImmediate(resolve));
  if (!ready()) throw new Error("condition not reached");
}

function cleanup() {
  Reflect.deleteProperty(globalThis, DAYBREAK_BRIDGE_SYMBOL);
  configureCodexDaybreakEntitlementForTest(undefined);
  configureCodexDaybreakModelSupportForTest(undefined);
}

test("off never looks up and every finalizer strips stale or forged access_programs", async (t) => {
  t.after(cleanup);
  const bridge = installBridge();
  const off = bridge.add("off-session", false);
  const calls = fakeLookup(() => Response.json(grantsPayload("tac3")));
  const body = await prepareCodexRequestBody(
    model,
    context,
    {
      sessionId: "off-session",
      apiKey: token("acct-1"),
      daybreakTicket: ticket("off-session"),
      onPayload: injectRed,
    },
    false,
  );
  assert.equal(hasAccessPrograms(body), false);
  assert.equal(calls.length, 0);
  assert.deepEqual(off.reports, [["off", 1]]);

  // Requested on, but no provider-minted ticket: forged tickets and decisions never enable it.
  bridge.add("on-session", true);
  for (const daybreakTicket of [undefined, Object.freeze({ sessionId: "on-session" })]) {
    const unticketed = await prepareCodexRequestBody(
      model,
      context,
      { sessionId: "on-session", apiKey: token("acct-1"), daybreakTicket, onPayload: injectRed },
      false,
    );
    assert.equal(hasAccessPrograms(unticketed), false);
  }
  const forged: CodexDaybreakDecision = {
    sessionId: "on-session",
    requested: true,
    source: "explicit",
    revision: 1,
    generation: 1,
    outcome: "red",
    cyber: "daybreak_red",
  };
  const plain: WireBody = { a: 1 };
  assert.equal(hasAccessPrograms(applyCodexDaybreakAccessPrograms(plain, forged)), false);
  assert.equal(isCurrentCodexDaybreakDecision(forged), false);
  assert.equal(calls.length, 0);
});

test("verified_access picks red over blue; anything else defaults to blue (catalog gates)", async (t) => {
  t.after(cleanup);
  const bridge = installBridge();
  const cases: Array<readonly [string, () => Response, DaybreakOutcome]> = [
    ["tac1", () => Response.json(grantsPayload("tac1")), "blue"],
    ["tac2", () => Response.json(grantsPayload("tac2")), "blue"],
    ["tac1+tac3", () => Response.json(grantsPayload("tac1", "tac3")), "red"],
    ["government", () => Response.json(grantsPayload("government")), "red"],
    ["no grants", () => Response.json(grantsPayload()), "blue"],
    ["unknown grant", () => Response.json(grantsPayload("other")), "blue"],
    [
      "grants omitted",
      () => Response.json({ programs: [{ program: "cyber", state: "active" }] }),
      "blue",
    ],
    [
      "inactive with tac3",
      () =>
        Response.json({
          programs: [{ program: "cyber", state: "pending", grants: [{ level: "tac3" }] }],
        }),
      "blue",
    ],
    [
      "unavailable",
      () =>
        Response.json({
          programs: [{ program: "cyber", state: "unavailable", grants: [{ level: "tac1" }] }],
        }),
      "blue",
    ],
    [
      "non-cyber program",
      () =>
        Response.json({
          programs: [{ program: "bio", state: "active", grants: [{ level: "tac1" }] }],
        }),
      "blue",
    ],
    [
      "later active entry",
      () =>
        Response.json({
          programs: [
            { program: "cyber", state: "revoked", grants: [{ level: "tac3" }] },
            { program: "cyber", state: "active", grants: [{ level: "tac1" }], since: "2026" },
          ],
        }),
      "blue",
    ],
    [
      "red across entries",
      () =>
        Response.json({
          programs: [
            { program: "cyber", state: "active", grants: [{ level: "tac1" }] },
            { program: "cyber", state: "active", grants: [{ level: "government" }] },
          ],
        }),
      "red",
    ],
    ["programs not array", () => Response.json({ programs: "cyber" }), "blue"],
    ["missing programs", () => Response.json({}), "blue"],
    [
      "program missing state",
      () => Response.json({ programs: [{ program: "cyber", grants: [{ level: "tac1" }] }] }),
      "blue",
    ],
    [
      "non-string grant",
      () => Response.json({ programs: [{ program: "cyber", state: "active", grants: [1] }] }),
      "blue",
    ],
    [
      "object grant",
      () =>
        Response.json({
          programs: [{ program: "cyber", state: "active", grants: [{ grant: "tac1" }] }],
        }),
      "blue",
    ],
    ["invalid json", () => new Response("{not json", { status: 200 }), "blue"],
    ["server error", () => new Response("down", { status: 500 }), "blue"],
  ];
  for (const [name, respond, expected] of cases) {
    const calls = fakeLookup(respond);
    const session = `matrix-${name}`;
    const fake = bridge.add(session, true);
    const decision = await resolve(ticket(session));
    assert.equal(decision.outcome, expected, name);
    assert.equal(decision.cyber, CYBER_BY_OUTCOME.get(expected), name);
    assert.deepEqual(fake.reports, [[expected, 1]], name);
    assert.equal(calls.length, 1, name);
  }
});

test("lookup uses canonical URL with auth headers only and times out safely", async (t) => {
  t.after(cleanup);
  const bridge = installBridge();
  bridge.add("headers", true);
  const calls = fakeLookup(() => Response.json(grantsPayload("tac1")));
  await resolve(
    beginCodexDaybreakRequest({
      sessionId: "headers",
      model,
      credentials: { apiKey: token("acct-1"), headers: { "x-extra": "1" } },
    }),
  );
  assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/accounts/verified_access");
  assert.equal(calls[0]?.accept, "application/json");
  const names = calls[0]?.headerNames ?? [];
  for (const required of ["authorization", "chatgpt-account-id", "originator", "x-extra"])
    assert.ok(names.includes(required), required);
  for (const forbidden of ["openai-beta", "session-id", "content-type", "x-client-request-id"])
    assert.equal(names.includes(forbidden), false, forbidden);

  bridge.add("timeout", true);
  configureCodexDaybreakEntitlementForTest({
    timeoutMs: 20,
    fetch: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  });
  const started = Date.now();
  const timedOut = await resolve(ticket("timeout"));
  assert.equal(timedOut.outcome, "blue", "a grant lookup timeout does not block Daybreak");
  assert.equal(timedOut.cyber, "daybreak_blue");
  assert.ok(Date.now() - started < 2_000);
});

test("model availability gates; the grant only selects red and never blocks", async (t) => {
  t.after(cleanup);
  const bridge = installBridge();
  // An unsupported model never spends an entitlement lookup, whatever the account would say.
  const entitlementCalls = fakeLookup(() => Response.json(grantsPayload()));
  configureCodexDaybreakModelSupportForTest({
    fetch: async () => Response.json({ models: [] }),
  });
  bridge.add("unsupported-first", true);
  assert.equal((await resolve(ticket("unsupported-first"))).outcome, "model-not-supported");
  assert.equal(entitlementCalls.length, 0);

  // A supported model then consults the grant only to choose red; denial and failure still send blue.
  configureCodexDaybreakModelSupportForTest({
    fetch: async () =>
      Response.json({
        models: [{ slug: model.id, available_access_programs: { cyber: ["daybreak_blue"] } }],
      }),
  });
  for (const [name, respond, expected] of [
    ["denied", () => Response.json(grantsPayload()), "blue"],
    ["failure", () => new Response("failed", { status: 500 }), "blue"],
  ] satisfies Array<readonly [string, () => Response, DaybreakOutcome]>) {
    fakeLookup(respond);
    bridge.add(name, true);
    const decision = await resolve(ticket(name));
    assert.equal(decision.outcome, expected);
    assert.equal(hasAccessPrograms(applyCodexDaybreakAccessPrograms({}, decision)), true);
  }

  // A catalog failure omits the field too.
  fakeLookup(() => Response.json(grantsPayload("tac1")));
  configureCodexDaybreakModelSupportForTest({
    fetch: async () => new Response("failed", { status: 500 }),
  });
  bridge.add("models-failed", true);
  const decision = await resolve(ticket("models-failed"));
  assert.equal(decision.outcome, "lookup-failed");
  assert.equal(
    hasAccessPrograms(
      applyCodexDaybreakAccessPrograms({ access_programs: { cyber: "daybreak_red" } }, decision),
    ),
    false,
  );

  // A red grant on a blue-only model falls back to blue, matching what the server would apply.
  fakeLookup(() => Response.json(grantsPayload("tac3")));
  configureCodexDaybreakModelSupportForTest({
    fetch: async () =>
      Response.json({
        models: [{ slug: model.id, available_access_programs: { cyber: ["daybreak_blue"] } }],
      }),
  });
  bridge.add("red-on-blue-only", true);
  const fallback = await resolve(ticket("red-on-blue-only"));
  assert.equal(fallback.outcome, "blue");
  assert.equal(fallback.cyber, "daybreak_blue");
});

test("toggle-on refreshes cached model support and stale owners never enable an unverified model", async (t) => {
  t.after(cleanup);
  const bridge = installBridge();
  fakeLookup(() => Response.json(grantsPayload("tac1")));
  let modelsCalls = 0;
  let supported = false;
  configureCodexDaybreakModelSupportForTest({
    fetch: async () => {
      modelsCalls++;
      return Response.json({
        models: supported
          ? [{ slug: model.id, available_access_programs: { cyber: ["daybreak_blue"] } }]
          : [],
      });
    },
  });
  const fake = bridge.add("models-toggle", true);
  assert.equal((await resolve(ticket("models-toggle"))).outcome, "model-not-supported");
  supported = true;
  assert.equal((await resolve(ticket("models-toggle"))).outcome, "model-not-supported");
  assert.equal(modelsCalls, 1);
  fake.controller.set(false);
  fake.controller.set(true);
  assert.equal((await resolve(ticket("models-toggle"))).outcome, "blue");
  assert.equal(modelsCalls, 2);

  const gate = deferred<void>();
  configureCodexDaybreakModelSupportForTest({
    fetch: async () => {
      await gate.promise;
      return Response.json({
        models: [{ slug: model.id, available_access_programs: { cyber: ["daybreak_blue"] } }],
      });
    },
  });
  const pending = resolve(ticket("models-toggle"));
  await Promise.resolve();
  fake.state = { ...fake.state, generation: fake.state.generation + 1 };
  gate.resolve();
  const stale = await pending;
  assert.equal(hasAccessPrograms(applyCodexDaybreakAccessPrograms({}, stale)), false);
});

test("ineligible auth or backend reports auth-not-eligible without lookup", async (t) => {
  t.after(cleanup);
  const bridge = installBridge();
  const calls = fakeLookup(() => Response.json(grantsPayload("tac1")));
  const foreign = bridge.add("foreign", true);
  assert.equal(
    (await resolve(ticket("foreign", token("acct-1"), foreignModel))).outcome,
    "auth-not-eligible",
  );
  assert.deepEqual(foreign.reports, [["auth-not-eligible", 1]]);
  bridge.add("stock", true);
  assert.equal(
    (await resolve(ticket("stock", token("acct-1"), stockModel))).outcome,
    "auth-not-eligible",
  );
  bridge.add("no-key", true);
  assert.equal(
    (await resolve(beginCodexDaybreakRequest({ sessionId: "no-key", model }))).outcome,
    "auth-not-eligible",
  );
  bridge.add("bad-key", true);
  assert.equal((await resolve(ticket("bad-key", "not-a-jwt"))).outcome, "auth-not-eligible");
  assert.equal(calls.length, 0);
  assert.equal(snapshotCodexDaybreakDecision("stock", stockModel).outcome, "auth-not-eligible");
  assert.equal(snapshotCodexDaybreakDecision("foreign").outcome, "auth-not-eligible");
  assert.equal(snapshotCodexDaybreakDecision("missing").outcome, "off");
});

test("entitlement cache: shared single-flight, TTL, token change, 401, bounded entries", async (t) => {
  t.after(cleanup);
  const bridge = installBridge();
  let now = 1_000;
  const gate = deferred<void>();
  const calls = fakeLookup(
    async () => {
      await gate.promise;
      return Response.json(grantsPayload("tac1"));
    },
    () => now,
  );
  bridge.add("shared-a", true);
  bridge.add("shared-b", true);
  const first = resolve(ticket("shared-a"));
  const second = resolve(ticket("shared-b"));
  gate.resolve();
  assert.deepEqual(
    (await Promise.all([first, second])).map(({ outcome }) => outcome),
    ["blue", "blue"],
  );
  assert.equal(calls.length, 1);

  // A different controller's first observation reuses the completed shared entry.
  bridge.add("shared-c", true);
  await resolve(ticket("shared-c"));
  assert.equal(calls.length, 1);

  now += DAYBREAK_ENTITLEMENT_TTL_MS + 1;
  await resolve(ticket("shared-a"));
  assert.equal(calls.length, 2);

  await resolve(ticket("shared-a", token("acct-1", "rotated")));
  assert.equal(calls.length, 3);

  invalidateCodexDaybreakEntitlement(token("acct-1", "rotated"), model.baseUrl);
  await resolve(ticket("shared-a", token("acct-1", "rotated")));
  assert.equal(calls.length, 4);

  const denied = fakeLookup(() => new Response("forbidden", { status: 403 }));
  bridge.add("denied", true);
  assert.equal((await resolve(ticket("denied"))).outcome, "blue");
  await resolve(ticket("denied"));
  assert.equal(denied.length, 2, "403 lookups are not cached");

  const bounded = fakeLookup(() => Response.json(grantsPayload("tac1")));
  for (let index = 0; index <= DAYBREAK_CACHE_MAX_ENTRIES; index++) {
    bridge.add(`bounded-${index}`, true);
    await resolve(ticket(`bounded-${index}`, token(`acct-b${index}`)));
  }
  assert.equal(bounded.length, DAYBREAK_CACHE_MAX_ENTRIES + 1);
  const evicted = daybreakAccount(token("acct-b0"), model.baseUrl);
  const kept = daybreakAccount(token(`acct-b${DAYBREAK_CACHE_MAX_ENTRIES}`), model.baseUrl);
  assert.ok(evicted && kept);
  assert.equal(hasCodexDaybreakEntitlementEntry(evicted), false);
  assert.equal(hasCodexDaybreakEntitlementEntry(kept), true);
});

test("toggle-on and invalidation drop pending flights that cannot refill the cache", async (t) => {
  t.after(cleanup);
  const bridge = installBridge();
  configureCodexDaybreakModelSupportForTest({
    fetch: async () =>
      Response.json({
        models: [
          {
            slug: model.id,
            available_access_programs: { cyber: ["daybreak_blue", "daybreak_red"] },
          },
        ],
      }),
  });
  const gates: Array<ReturnType<typeof deferred<void>>> = [];
  const grants = ["tac1", "tac3"];
  const calls = fakeLookup(async () => {
    const gate = deferred<void>();
    gates.push(gate);
    const grant = grants[gates.length - 1] ?? "tac1";
    await gate.promise;
    return Response.json(grantsPayload(grant));
  });
  const fake = bridge.add("toggle", true);
  const stale = resolve(ticket("toggle"));
  await waitFor(() => calls.length === 1);
  fake.controller.set(false);
  fake.controller.set(true);
  const fresh = resolve(ticket("toggle"));
  await waitFor(() => calls.length === 2);
  assert.equal(calls.length, 2, "toggle-on must not reuse the pre-toggle pending flight");
  gates[0]?.resolve();
  gates[1]?.resolve();
  assert.equal((await stale).outcome, "blue");
  assert.equal((await fresh).outcome, "red");
  // The stale flight did not refill: the fresh red entry is served from cache.
  bridge.add("toggle-peer", true);
  assert.equal((await resolve(ticket("toggle-peer"))).outcome, "red");
  assert.equal(calls.length, 2);

  // Explicit invalidation while pending likewise prevents a refill.
  configureCodexDaybreakEntitlementForTest(undefined);
  const pendingGate = deferred<void>();
  let lookups = 0;
  configureCodexDaybreakEntitlementForTest({
    fetch: async () => {
      lookups++;
      if (lookups === 1) await pendingGate.promise;
      return Response.json(grantsPayload("tac1"));
    },
  });
  bridge.add("pending", true);
  const pending = resolve(ticket("pending"));
  await waitFor(() => lookups === 1);
  invalidateCodexDaybreakEntitlement(token("acct-1"), model.baseUrl);
  pendingGate.resolve();
  await pending;
  await resolve(ticket("pending"));
  assert.equal(lookups, 2);
});

test("frozen decision: revision drift keeps start state; identity or generation drift omits", async (t) => {
  t.after(cleanup);
  const bridge = installBridge();
  fakeLookup(() => Response.json(grantsPayload("tac1")));
  const fake = bridge.add("freeze", true);
  const frozen = ticket("freeze");
  fake.controller.set(false);
  const decision = await resolve(frozen);
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(decision.outcome, "blue");
  assert.equal(isCurrentCodexDaybreakDecision(decision), false);
  assert.deepEqual(fake.reports, [], "stale revisions are not reported");
  assert.equal(cyberOf(applyCodexDaybreakAccessPrograms({}, decision)), "daybreak_blue");
  assert.equal(await resolveCodexDaybreakTicket(frozen), decision, "retries reuse one result");

  const generation = bridge.add("generation", true);
  const generationDecision = await resolve(ticket("generation"));
  generation.state = { ...generation.state, generation: 2 };
  assert.equal(hasAccessPrograms(applyCodexDaybreakAccessPrograms({}, generationDecision)), false);

  bridge.add("identity", true);
  const identityDecision = await resolve(ticket("identity"));
  bridge.replace("identity", fakeController("identity", true));
  assert.equal(hasAccessPrograms(applyCodexDaybreakAccessPrograms({}, identityDecision)), false);
  assert.equal(isCurrentCodexDaybreakDecision(identityDecision), false);
  assert.equal(
    hasAccessPrograms(applyCodexDaybreakAccessPrograms({}, { ...identityDecision })),
    false,
  );

  const mutable = bridge.add("mutable-state", true);
  const mutableState = { ...mutable.state };
  mutable.state = mutableState;
  const immutableSnapshot = ticket("mutable-state");
  mutableState.requested = false;
  assert.equal((await resolve(immutableSnapshot)).outcome, "blue");

  // Credentials are copied at begin; later caller mutation cannot change the lookup.
  const owned = bridge.add("owned", true);
  const credentials = { apiKey: token("acct-1"), headers: { "x-extra": "1" } };
  const ownedTicket = beginCodexDaybreakRequest({ sessionId: "owned", model, credentials });
  credentials.apiKey = "not-a-jwt";
  assert.equal((await resolve(ownedTicket)).outcome, "blue");
  assert.deepEqual(owned.reports, [["blue", 1]]);
});

test("HTTP and normalized WebSocket terminal echoes attest the applied Daybreak program", async (t) => {
  t.after(cleanup);
  const bridge = installBridge();
  fakeLookup(() => Response.json(grantsPayload("tac1")));
  const account = daybreakAccount(token("acct-1"), model.baseUrl);
  assert.ok(account);
  for (const transport of ["http", "ws"]) {
    for (const echo of ["standard", "daybreak_blue", "absent", "malformed"]) {
      const id = `${transport}-${echo}`;
      const fake = bridge.add(id, true);
      const requestTicket = ticket(id);
      await resolve(requestTicket);
      assert.equal(hasCodexDaybreakEntitlementEntry(account), true);
      const response: CodexStreamEvent["response"] = { status: "completed" };
      if (echo !== "absent")
        response.access_programs = echo === "malformed" ? { cyber: 5 } : { cyber: echo };
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      };
      async function* events(): AsyncIterable<CodexStreamEvent> {
        yield { type: transport === "http" ? "response.done" : "response.completed", response };
      }
      const process =
        transport === "http" ? processCodexResponsesStream : processMappedCodexResponsesStream;
      await process(events(), output, createAssistantMessageEventStream(), model, {
        daybreakTicket: requestTicket,
      });
      assert.equal(fake.state.outcome, echo === "standard" ? "not-granted" : "blue");
      assert.equal(hasCodexDaybreakEntitlementEntry(account), echo !== "standard");
      assert.equal(fake.reports.length, echo === "standard" || echo === "daybreak_blue" ? 2 : 1);
      reportCodexDaybreakResponse(requestTicket, { access_programs: { cyber: "standard" } });
      assert.equal(
        fake.reports.length,
        echo === "standard" || echo === "daybreak_blue" ? 2 : 1,
        "terminal observation settles once",
      );
    }
  }
});

test("custom HTTP provider carries its frozen Daybreak ticket through terminal echo observation", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });
  const bridge = installBridge();
  fakeLookup(() => Response.json(grantsPayload("tac1")));
  const fake = bridge.add("http-echo", true);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", access_programs: { cyber: "standard" } } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const stream = createOpenAICodexProviderStream(
    model,
    context,
    { sessionId: "http-echo", apiKey: token("acct-1"), transport: "sse", maxRetries: 0 },
    {},
  );
  for await (const _event of stream);
  assert.equal(fake.state.outcome, "not-granted");
  assert.equal(requests, 1, "the echo never retries or resends the request");
  const account = daybreakAccount(token("acct-1"), model.baseUrl);
  assert.ok(account);
  assert.equal(hasCodexDaybreakEntitlementEntry(account), false);
});

test("server echoes from superseded Daybreak revisions do not report or invalidate the cache", async (t) => {
  t.after(cleanup);
  const bridge = installBridge();
  fakeLookup(() => Response.json(grantsPayload("tac1")));
  const fake = bridge.add("echo-stale", true);
  const requestTicket = ticket("echo-stale");
  await resolve(requestTicket);
  fake.controller.set(false);
  fake.controller.set(true);
  const before = fake.reports.length;
  reportCodexDaybreakResponse(requestTicket, { access_programs: { cyber: "standard" } });
  assert.equal(fake.reports.length, before);
  const account = daybreakAccount(token("acct-1"), model.baseUrl);
  assert.ok(account);
  assert.equal(hasCodexDaybreakEntitlementEntry(account), true);
});

test("HTTP provider path applies after payload hooks and 401 invalidates entitlement", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });
  const bridge = installBridge();
  const lookups = fakeLookup(() => Response.json(grantsPayload("tac1")));
  const sent: string[] = [];
  let status = 400;
  globalThis.fetch = async (_input, init) => {
    sent.push(await requestText(init));
    return new Response(JSON.stringify({ error: { message: "stop" } }), { status });
  };
  const run = async (sessionId: string) => {
    const stream = createOpenAICodexProviderStream(
      model,
      context,
      {
        apiKey: token("acct-1"),
        sessionId,
        transport: "sse",
        maxRetries: 0,
        onPayload: injectRed,
      },
      {},
    );
    for await (const _event of stream);
    return parseWire(sent.at(-1));
  };
  bridge.add("http-on", true);
  assert.equal(cyberOf(await run("http-on")), "daybreak_blue");
  bridge.add("http-off", false);
  assert.equal(hasAccessPrograms(await run("http-off")), false);
  bridge.add("http-foreign", true);
  assert.equal(lookups.length, 1);

  status = 401;
  await run("http-on");
  status = 400;
  await run("http-on");
  assert.equal(lookups.length, 2, "an inference 401 forces a fresh entitlement lookup");

  configureCodexDaybreakModelSupportForTest({ fetch: async () => Response.json({ models: [] }) });
  const unsupported = bridge.add("http-unsupported", true);
  assert.equal(hasAccessPrograms(await run("http-unsupported")), false);
  assert.equal(unsupported.state.outcome, "model-not-supported");
});

test("prewarm preparedBody branch replaces or removes the field and skips stale revisions", async (t) => {
  t.after(cleanup);
  const bridge = installBridge();
  const apiKey = token("acct-1");
  const prepared: ResponsesBody = {
    ...buildRequestBody(model, context, {}),
    access_programs: { cyber: "daybreak_red" },
  };
  const prewarm = async (sessionId: string) => {
    let transported: ResponsesBody | undefined;
    await prewarmOpenAICodexWebSocket(
      model,
      context,
      { apiKey, sessionId, transport: "websocket" },
      {
        preparedBody: prepared,
        useResponsesLite: () => false,
        prewarmTransport: async (_url, body) => {
          transported = structuredClone(body);
          return { socketReused: false };
        },
      },
    );
    return transported;
  };
  const lookups = fakeLookup(() => Response.json(grantsPayload("tac1")));
  bridge.add("prewarm-on", true);
  assert.equal(cyberOf(await prewarm("prewarm-on")), "daybreak_blue");
  bridge.add("prewarm-off", false);
  const off = await prewarm("prewarm-off");
  assert.ok(off);
  assert.equal(hasAccessPrograms(off), false);
  assert.equal(lookups.length, 1);

  configureCodexDaybreakModelSupportForTest({ fetch: async () => Response.json({ models: [] }) });
  const unsupported = bridge.add("prewarm-unsupported", true);
  const unsupportedBody = await prewarm("prewarm-unsupported");
  assert.ok(unsupportedBody);
  assert.equal(hasAccessPrograms(unsupportedBody), false);
  assert.equal(unsupported.state.outcome, "model-not-supported");
  let frame = "";
  sendPreparedWebSocketRequest(
    {
      send: (data) => {
        frame = data;
      },
    },
    { kind: "send", body: unsupportedBody },
    {
      stream: "response",
      ts: new Date(0).toISOString(),
      provider: model.provider,
      model: model.id,
      continuation: "disabled",
      fullInputItemCount: unsupportedBody.input.length,
    },
  );
  assert.equal(hasAccessPrograms(parseWire(frame)), false);

  const gate = deferred<void>();
  configureCodexDaybreakEntitlementForTest({
    fetch: async () => {
      await gate.promise;
      return Response.json(grantsPayload("tac1"));
    },
  });
  const drift = bridge.add("prewarm-drift", true);
  const pending = prewarm("prewarm-drift");
  await Promise.resolve();
  drift.controller.set(true);
  gate.resolve();
  assert.equal(await pending, undefined, "a revision change skips the stale prewarm payload");
});

test("WebSocket response.create carries the field and continuation forces a fresh create", () => {
  const base = buildRequestBody(model, context, {});
  const blue: ResponsesBody = { ...base, access_programs: { cyber: "daybreak_blue" } };
  let frame = "";
  sendPreparedWebSocketRequest(
    { send: (data) => (frame = data) },
    { kind: "send", body: blue },
    {
      stream: "response",
      ts: new Date(0).toISOString(),
      provider: model.provider,
      model: model.id,
      continuation: "disabled",
      fullInputItemCount: blue.input.length,
    },
  );
  const emitted: unknown = JSON.parse(frame);
  assert.ok(Value.Check(FrameSchema, emitted));
  assert.equal(cyberOf(parseWire(frame)), "daybreak_blue");

  const responseItems = [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi." }] },
  ];
  const nextInput = [
    ...base.input,
    ...responseItems,
    { role: "user", content: [{ type: "input_text", text: "Next." }] },
  ];
  const continuation = {
    lastRequestBody: blue,
    lastResponseId: "resp-1",
    lastResponseItems: responseItems,
  };
  const same = buildCachedWebSocketRequestBody(continuation, { ...blue, input: nextInput });
  assert.equal(same.decision, "delta");
  for (const changed of [
    { ...base, input: nextInput },
    { ...base, input: nextInput, access_programs: { cyber: "daybreak_red" as const } },
  ]) {
    const result = buildCachedWebSocketRequestBody(continuation, changed);
    assert.equal(result.decision, "body_mismatch");
    assert.equal(result.body.previous_response_id, undefined);
  }
});

test("remote compaction v2 through the registered Codex stream applies the frozen decision", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });
  const bridge = installBridge();
  fakeLookup(() => Response.json(grantsPayload("tac3")));
  const sent: string[] = [];
  globalThis.fetch = async (_input, init) => {
    sent.push(await requestText(init));
    return new Response(JSON.stringify({ error: { message: "stop" } }), { status: 400 });
  };
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  runtime.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    baseUrl: model.baseUrl,
    models: [model],
    streamSimple: (target, streamContext, options) =>
      createOpenAICodexProviderStream(target, streamContext, options, {}),
  });
  const run = async (sessionId: string) => {
    await executeRemoteCompactionV2({
      runtime: {
        provider: "openai-codex",
        api: "openai-codex-responses",
        apiFamily: "openai-codex-responses",
        codexTransport: true,
        model: model.id,
        baseUrl: model.baseUrl,
        apiKey: token("acct-1"),
        currentModel: model,
      },
      modelRegistry: new ModelRegistry(runtime),
      context,
      promptInput: [{ role: "user", content: [{ type: "input_text", text: "Hello." }] }],
      promptInputSource: "reconstructed",
      requestOptions: {},
      tokensBefore: 1,
      sessionId,
      transport: "sse",
      retryDelayMs: 0,
    });
    const parsed = parseWire(sent.at(-1));
    assert.ok(JSON.stringify(parsed["input"]).includes("compaction_trigger"));
    return parsed;
  };
  bridge.add("compact-on", true);
  assert.equal(cyberOf(await run("compact-on")), "daybreak_red");
  bridge.add("compact-off", false);
  assert.equal(hasAccessPrograms(await run("compact-off")), false);
});

test("WebSocket 401/403 invalidates entitlement before a non-auth HTTP fallback", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });
  const bridge = installBridge();
  const lookups = fakeLookup(() => Response.json(grantsPayload("tac1")));
  const apiKey = token("acct-1");
  globalThis.fetch = async () => new Response("stop", { status: 400 });
  for (const status of [401, 403]) {
    const sessionId = `ws-auth-${status}`;
    bridge.add(sessionId, true);
    await resolve(ticket(sessionId));
    const account = daybreakAccount(apiKey, model.baseUrl);
    assert.ok(account && hasCodexDaybreakEntitlementEntry(account));
    const stream = createCodexTransportStream(
      model,
      context,
      { apiKey, sessionId, transport: "websocket", maxRetries: 0 },
      {
        prepareRequestBody: async () => buildRequestBody(model, context, {}),
        processWebSocketStream: async () => {
          throw new Error(`Unexpected server response: ${status}`);
        },
      },
    );
    for await (const _event of stream);
    assert.equal(hasCodexDaybreakEntitlementEntry(account), false);
    const before = lookups.length;
    await resolve(ticket(sessionId));
    assert.equal(lookups.length, before + 1, "the next request must refresh entitlement");
  }
});

test("provider-request overlay omits access_programs on early and rewritten paths", async () => {
  const fixture = await createSdkFixture(stockModel);
  try {
    const baseState: AdapterState = {
      enabled: true,
      cwd: process.cwd(),
      promptSkills: [],
      config: {
        ...DEFAULT_CODEX_CONVERSION_CONFIG,
        compaction: { ...DEFAULT_CODEX_CONVERSION_CONFIG.compaction, responsesCompaction: false },
      },
      executionMode: "normal",
      codexTurnState: createCodexTurnState(),
      pendingActiveProviderPromptCapture: false,
    };
    const voiceOnly: AdapterState = {
      ...baseState,
      config: { ...baseState.config, voiceFeaturesOnly: true },
    };
    const payload = {
      model: stockModel.id,
      input: [],
      access_programs: { cyber: "daybreak_blue" },
    };
    for (const state of [baseState, voiceOnly]) {
      const rewritten = await rewriteCodexProviderRequest(payload, fixture.ctx, state);
      assert.ok(rewritten && Value.Check(Type.Object({ model: Type.String() }), rewritten));
      assert.equal(hasAccessPrograms(rewritten), false);
      const prewarmed = rewriteCodexPrewarmProviderRequest(payload, fixture.ctx, state);
      assert.ok(prewarmed && Value.Check(Type.Object({ model: Type.String() }), prewarmed));
      assert.equal(hasAccessPrograms(prewarmed), false);
    }
    assert.equal(
      await rewriteCodexProviderRequest(
        { model: stockModel.id, input: [] },
        fixture.ctx,
        voiceOnly,
      ),
      undefined,
      "payloads without the field keep the original no-rewrite result",
    );
  } finally {
    fixture.session.dispose();
  }
});

test("prewarm 401/403 invalidates entitlement so the next request refreshes it", async (t) => {
  t.after(cleanup);
  const bridge = installBridge();
  const lookups = fakeLookup(() => Response.json(grantsPayload("tac1")));
  const apiKey = token("acct-1");
  for (const status of [401, 403]) {
    const sessionId = `prewarm-auth-${status}`;
    bridge.add(sessionId, true);
    await resolve(ticket(sessionId));
    const account = daybreakAccount(apiKey, model.baseUrl);
    assert.ok(account && hasCodexDaybreakEntitlementEntry(account));
    await assert.rejects(
      prewarmOpenAICodexWebSocket(
        model,
        context,
        { apiKey, sessionId, transport: "websocket" },
        {
          preparedBody: buildRequestBody(model, context, {}),
          useResponsesLite: () => false,
          prewarmTransport: async () => {
            throw new Error(`Unexpected server response: ${status}`);
          },
        },
      ),
    );
    assert.equal(hasCodexDaybreakEntitlementEntry(account), false);
    const before = lookups.length;
    await resolve(ticket(sessionId));
    assert.equal(lookups.length, before + 1, "the next request must refresh entitlement");
  }
});
