import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getDaybreakBridge, daybreakStatusValue } from "../../../extensions/lib/daybreak-state.ts";
import {
  createCodexDaybreakProbe,
  registerCodexDaybreakProbe,
  type DaybreakProbeContext,
} from "../src/extension/daybreak-probe.ts";
import { createSdkFixture } from "./sdk-fixture.ts";
import { configureCodexDaybreakEntitlementForTest } from "../src/providers/openai-codex/daybreak-entitlement.ts";
import { configureCodexDaybreakModelSupportForTest } from "../src/providers/openai-codex/daybreak-model-support.ts";

const model: Model<Api> = {
  id: "blue",
  name: "Blue",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};
const apiKey = `e30.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "probe-fixture" },
  }),
).toString("base64url")}.signature`;

function deferred<Value>() {
  let resolve: (value: Value) => void = () => assert.fail("deferred promise is not initialized");
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(t: test.TestContext, requested = false) {
  configureCodexDaybreakEntitlementForTest(undefined);
  configureCodexDaybreakModelSupportForTest(undefined);
  const urls: string[] = [];
  let modelResponse: Promise<Response> | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    urls.push(url.pathname);
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("x-probe-header"), "fixture");
    if (url.pathname.endsWith("/models")) {
      return (
        modelResponse ??
        Response.json({
          models: [
            { slug: "blue", available_access_programs: { cyber: ["daybreak_blue"] } },
            { slug: "standard", available_access_programs: { cyber: ["standard"] } },
          ],
        })
      );
    }
    assert.equal(url.pathname, "/backend-api/accounts/verified_access", "never sends /responses");
    return Response.json({
      programs: [
        {
          program: "cyber",
          state: "active",
          grants: [{ level: "tac1", source: "individual" }],
          individual_blue_security_setup_required: false,
        },
      ],
    });
  };
  t.mock.method(globalThis, "fetch", fetcher);
  const sessionId = `probe-${t.name}`;
  const bridge = getDaybreakBridge();
  const controller = bridge.register({
    sessionId,
    owner: {},
    generation: 0,
    initial: { requested, source: "inherited" },
  });
  const probe = createCodexDaybreakProbe();
  const credentialModels: string[] = [];
  const ctx: DaybreakProbeContext = {
    model,
    sessionManager: { getSessionId: () => sessionId },
    modelRegistry: {
      getApiKeyAndHeaders: async (selected) => {
        credentialModels.push(selected.id);
        return { ok: true, apiKey, headers: { "x-probe-header": "fixture" } };
      },
    },
  };
  t.after(() => {
    probe.dispose();
    bridge.get(sessionId)?.dispose();
    configureCodexDaybreakEntitlementForTest(undefined);
    configureCodexDaybreakModelSupportForTest(undefined);
  });
  return {
    ctx,
    controller,
    bridge,
    probe,
    urls,
    credentialModels,
    holdModels: (response: Promise<Response>) => {
      modelResponse = response;
    },
    sessionId,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++)
    await new Promise<void>((done) => setImmediate(done));
  assert.ok(predicate(), "probe reached the expected phase");
}

test("toggle-on probes credentials once and publishes without a provider turn", async (t) => {
  const f = fixture(t);
  await f.probe.bind(f.ctx);
  assert.deepEqual(f.credentialModels, []);
  f.controller.set(true);
  assert.equal(f.controller.getState().outcome, "pending");
  await f.probe.settled();
  assert.deepEqual(f.credentialModels, ["blue"]);
  assert.deepEqual(f.urls, ["/backend-api/codex/models", "/backend-api/accounts/verified_access"]);
  assert.equal(f.controller.getState().outcome, "blue");
  assert.equal(daybreakStatusValue(f.controller.getState()), "on (blue)");
});

test("missing credentials use the decision pipeline's auth-not-eligible outcome", async (t) => {
  const f = fixture(t, true);
  await f.probe.bind({
    ...f.ctx,
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "not configured" }) },
  });
  assert.equal(f.controller.getState().outcome, "auth-not-eligible");
  assert.deepEqual(f.urls, []);
});

test("real SDK session-start and model-select events run the eager probe", async (t) => {
  fixture(t); // Install strict lookup-only fetch I/O.
  const bridge = getDaybreakBridge();
  const sdk = await createSdkFixture(model, [
    registerCodexDaybreakProbe, // Probe registration deliberately precedes the controller factory.
    bridge.createExtension({
      owner: {},
      generation: 0,
      initial: { requested: true, source: "inherited" },
    }),
    (pi) => {
      pi.on("session_start", (_event, ctx) => {
        t.mock.method(ctx.modelRegistry, "getApiKeyAndHeaders", async () => ({
          ok: true,
          apiKey,
          headers: { "x-probe-header": "fixture" },
        }));
      });
    },
  ]);
  t.after(() => sdk.session.dispose());
  const controller = bridge.get(sdk.ctx.sessionManager.getSessionId());
  assert.ok(controller);
  await waitFor(() => controller.getState().outcome === "blue");
  assert.equal(controller.getState().outcome, "blue");
  t.mock.method(sdk.session.modelRuntime, "checkAuth", async () => true);
  await sdk.session.setModel({ ...model, id: "standard" });
  await waitFor(() => controller.getState().outcome === "model-not-supported");
  assert.equal(controller.getState().outcome, "model-not-supported");
});

test("inherited requested state probes at session start and switches the selected model", async (t) => {
  const f = fixture(t, true);
  await f.probe.bind(f.ctx);
  assert.equal(f.controller.getState().outcome, "blue");
  await f.probe.bind({ ...f.ctx, model: { ...model, id: "standard" } });
  assert.deepEqual(f.credentialModels, ["blue", "standard"]);
  assert.equal(f.controller.getState().outcome, "model-not-supported");
  assert.match(daybreakStatusValue(f.controller.getState()), /current model does not support/);
});

test("rapid toggles coalesce to one flight and off performs no lookup", async (t) => {
  const f = fixture(t);
  await f.probe.bind(f.ctx);
  f.controller.set(true);
  f.controller.set(false);
  f.controller.set(true);
  await f.probe.settled();
  assert.equal(f.credentialModels.length, 1);
  assert.equal(f.urls.length, 2);
  f.controller.set(false);
  f.controller.set(true);
  f.controller.set(false);
  await f.probe.settled();
  assert.equal(f.credentialModels.length, 1);
  assert.equal(f.controller.getState().outcome, "off");
});

test("a model switch serializes behind a stale lookup and drops its grant", async (t) => {
  const f = fixture(t, true);
  const blocked = deferred<Response>();
  f.holdModels(blocked.promise);
  const first = f.probe.bind(f.ctx);
  await waitFor(() => f.urls.length === 1);
  const next = f.probe.bind({ ...f.ctx, model: { ...model, id: "standard" } });
  assert.equal(f.credentialModels.length, 1, "no stacked credential/model flight");
  blocked.resolve(
    Response.json({
      models: [
        { slug: "blue", available_access_programs: { cyber: ["daybreak_blue"] } },
        { slug: "standard", available_access_programs: { cyber: ["standard"] } },
      ],
    }),
  );
  await Promise.all([first, next]);
  assert.equal(f.controller.getState().outcome, "model-not-supported");
  assert.deepEqual(f.credentialModels, ["blue", "standard"]);
  assert.equal(f.urls.length, 1, "stale flight does not proceed to entitlement");
});

test("replacement generation drops stale results", async (t) => {
  const f = fixture(t, true);
  const blocked = deferred<Response>();
  f.holdModels(blocked.promise);
  const first = f.probe.bind(f.ctx);
  await waitFor(() => f.urls.length === 1);
  const replacement = f.bridge.register({
    sessionId: f.sessionId,
    owner: {},
    generation: 1,
    initial: { requested: true, source: "inherited" },
  });
  blocked.resolve(
    Response.json({
      models: [
        {
          slug: "blue",
          available_access_programs: { cyber: ["daybreak_blue"] },
        },
      ],
    }),
  );
  await first;
  assert.equal(replacement.getState().outcome, "pending");
  assert.equal(f.urls.length, 1);
  assert.equal(f.controller.getState().outcome, "pending");
});

test("session replacement during credential resolution drops the old owner", async (t) => {
  const f = fixture(t, true);
  type Auth = Awaited<ReturnType<DaybreakProbeContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
  const blocked = deferred<Auth>();
  let credentialsStarted = false;
  const first = f.probe.bind({
    ...f.ctx,
    modelRegistry: {
      getApiKeyAndHeaders: () => {
        credentialsStarted = true;
        return blocked.promise;
      },
    },
  });
  await waitFor(() => credentialsStarted);
  const sessionId = `${f.sessionId}-replacement`;
  const controller = f.bridge.register({
    sessionId,
    owner: {},
    generation: 1,
    initial: { requested: true, source: "inherited" },
  });
  t.after(() => controller.dispose());
  const next = f.probe.bind({ ...f.ctx, sessionManager: { getSessionId: () => sessionId } });
  blocked.resolve({ ok: true, apiKey });
  await Promise.all([first, next]);
  assert.equal(f.controller.getState().outcome, "pending");
  assert.equal(controller.getState().outcome, "blue");
  assert.equal(f.urls.length, 2, "only the current session performed lookup I/O");
});

test("disposal drops a pending lookup and removes the toggle listener", async (t) => {
  const f = fixture(t, true);
  const blocked = deferred<Response>();
  f.holdModels(blocked.promise);
  const first = f.probe.bind(f.ctx);
  await waitFor(() => f.urls.length === 1);
  f.probe.dispose();
  f.probe.dispose();
  blocked.resolve(
    Response.json({
      models: [
        {
          slug: "blue",
          available_access_programs: { cyber: ["daybreak_blue"] },
        },
      ],
    }),
  );
  await first;
  assert.equal(f.controller.getState().outcome, "pending");
  f.controller.set(false);
  f.controller.set(true);
  await f.probe.settled();
  assert.equal(f.credentialModels.length, 1);
  assert.equal(f.urls.length, 1);
});
