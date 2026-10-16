import assert from "node:assert/strict";
import test from "node:test";
import { cleanupSessionResources, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import {
  applyFastModeRequest,
  createXaiFastPricing,
  createFastModeBridge,
  decideFastMode,
  installFastModeExtension,
  isOpenAISubscriptionSignIn,
  OPENAI_SIGN_IN_FAST_REASON,
  supportsFastMode,
  XAI_FAST_HOST_REASON,
  XAI_FAST_MODEL_REASON,
  type FastModeExtensionContext,
} from "../.pi/extensions/lib/fast-mode-state.ts";

const owner = {};
const model = (provider: string): Model<"openai-responses"> => ({
  id: "fixture",
  name: "fixture",
  provider,
  api: "openai-responses",
  baseUrl:
    provider === "openai"
      ? "https://api.openai.com/v1"
      : provider === "openai-codex"
        ? "https://chatgpt.com/backend-api/codex"
        : "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1,
  maxTokens: 1,
});

test("preference and request applicability are independent", () => {
  const state = { sessionId: "s", requested: true, source: "explicit" as const, revision: 2 };
  assert.deepEqual(decideFastMode(state, model("anthropic")), {
    ...state,
    supported: false,
    active: false,
    serviceTier: undefined,
  });
  assert.equal(decideFastMode(state, model("openai")).serviceTier, "priority");
  assert.equal(
    decideFastMode({ ...state, requested: false }, model("openai")).serviceTier,
    "standard",
  );
});

test("registrations are session isolated, idempotent, and generation safe", () => {
  const bridge = createFastModeBridge();
  const first = bridge.register({
    sessionId: "one",
    owner,
    generation: 1,
    initial: { requested: false, source: "default" },
  });
  assert.equal(
    bridge.register({
      sessionId: "one",
      owner,
      generation: 1,
      initial: { requested: true, source: "inherited" },
    }),
    first,
  );
  const successor = bridge.register({
    sessionId: "one",
    owner,
    generation: 2,
    initial: { requested: true, source: "inherited" },
  });
  first.dispose();
  assert.equal(bridge.get("one"), successor);
  assert.equal(successor.getState().requested, true);
  successor.dispose();
});

test("SDK cleanup removes only the canonical controller for its session", () => {
  const bridge = createFastModeBridge();
  const first = bridge.register({
    sessionId: "cleanup-one",
    owner: {},
    generation: 1,
    initial: { requested: false, source: "default" },
  });
  const second = bridge.register({
    sessionId: "cleanup-two",
    owner: {},
    generation: 1,
    initial: { requested: true, source: "explicit" },
  });

  cleanupSessionResources("cleanup-one");
  assert.equal(bridge.get("cleanup-one"), undefined);
  assert.equal(bridge.get("cleanup-two"), second);

  first.dispose();
  cleanupSessionResources();
  assert.equal(bridge.get("cleanup-two"), undefined);
});

test("legacy booleans restore as explicit and explicit false defeats defaults", () => {
  const bridge = createFastModeBridge();
  const controller = bridge.register({
    sessionId: "legacy",
    owner,
    generation: 1,
    initial: { requested: true, source: "default" },
    entries: [
      {
        type: "custom",
        id: "entry",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "choco-pi-fast-mode",
        data: { enabled: false, revision: 7 },
      },
    ],
  });
  assert.deepEqual(controller.getState(), {
    sessionId: "legacy",
    requested: false,
    source: "explicit",
    revision: 7,
  });
});

test("stored default source remains a replaceable config default", () => {
  const bridge = createFastModeBridge();
  const controller = bridge.register({
    sessionId: "stored-default",
    owner,
    generation: 1,
    initial: { requested: false, source: "default" },
    entries: [
      {
        type: "custom",
        id: "default-entry",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "choco-pi-fast-mode",
        data: { enabled: true, source: "default", revision: 2 },
      },
    ],
  });
  assert.equal(controller.getState().source, "default");
  assert.equal(controller.getState().revision, 2);
});

test("inline child initialization persists an inherited snapshot before requests", () => {
  const bridge = createFastModeBridge();
  let start: ((ctx: FastModeExtensionContext) => void) | undefined;
  let request: ((payload: RuntimeValue, ctx: FastModeExtensionContext) => RuntimeValue) | undefined;
  const persisted: Array<{ type: string; data: RuntimeValue }> = [];
  installFastModeExtension(
    bridge,
    { owner, generation: 3, initial: { requested: true, source: "inherited" } },
    {
      appendEntry: (type, data) => persisted.push({ type, data }),
      onSessionStart: (handler) => (start = handler),
      onSessionTree: () => undefined,
      onBeforeProviderRequest: (handler) => (request = handler),
      onSessionShutdown: () => undefined,
    },
  );
  start?.({
    model: undefined,
    sessionManager: { getSessionId: () => "child", getBranch: () => [] },
  });
  assert.deepEqual(persisted, [
    {
      type: "choco-pi-fast-mode",
      data: { enabled: true, source: "inherited", revision: 0 },
    },
  ]);
  assert.equal(bridge.get("child")?.getState().requested, true);
  const result = request?.(
    { model: "fixture" },
    {
      model: model("openai"),
      sessionManager: { getSessionId: () => "child", getBranch: () => [] },
    },
  );
  assert.deepEqual(result, { model: "fixture", service_tier: "priority" });
});

test("explicit child override wins over copied parent fast-mode history", () => {
  const bridge = createFastModeBridge();
  let start: ((ctx: FastModeExtensionContext) => void) | undefined;
  const persisted: RuntimeValue[] = [];
  installFastModeExtension(
    bridge,
    { owner, generation: 4, initial: { requested: true, source: "explicit" } },
    {
      appendEntry: (_type, data) => persisted.push(data),
      onSessionStart: (handler) => (start = handler),
      onSessionTree: () => undefined,
      onBeforeProviderRequest: () => undefined,
      onSessionShutdown: () => undefined,
    },
  );
  start?.({
    model: undefined,
    sessionManager: {
      getSessionId: () => "explicit-child",
      getBranch: () => [
        {
          type: "custom",
          id: "copied-fast-mode",
          parentId: null,
          timestamp: new Date().toISOString(),
          customType: "choco-pi-fast-mode",
          data: { enabled: false, source: "explicit", revision: 9 },
        },
      ],
    },
  });
  assert.equal(bridge.get("explicit-child")?.getState().requested, true);
  assert.deepEqual(persisted, [{ enabled: true, source: "explicit", revision: 0 }]);
});

test("a replaced controller cannot persist or publish a stale update", () => {
  const bridge = createFastModeBridge();
  let writes = 0;
  const first = bridge.register({
    sessionId: "replaced",
    owner: {},
    generation: 1,
    initial: { requested: false, source: "default" },
    persist: () => writes++,
  });
  bridge.register({
    sessionId: "replaced",
    owner: {},
    generation: 2,
    initial: { requested: true, source: "inherited" },
  });
  assert.throws(() => first.set(true), /stale/);
  assert.equal(writes, 0);
  assert.equal(bridge.get("replaced")?.getState().requested, true);
});

test("failed persistence does not publish a state update", () => {
  const bridge = createFastModeBridge();
  const controller = bridge.register({
    sessionId: "failure",
    owner,
    generation: 1,
    initial: { requested: false, source: "default" },
    persist: () => {
      throw new Error("disk unavailable");
    },
  });
  assert.throws(() => controller.set(true), /disk unavailable/);
  assert.equal(controller.getState().requested, false);
  assert.equal(controller.getState().revision, 0);
  controller.dispose();
});

const oauth = { isUsingOAuth: () => true };
const apiKey = { isUsingOAuth: () => false };

test("sign-in predicate needs openai, the exact platform URL, and OAuth", () => {
  const openai = model("openai");
  assert.equal(isOpenAISubscriptionSignIn(openai, oauth), true);
  assert.equal(
    isOpenAISubscriptionSignIn({ ...openai, baseUrl: "https://api.openai.com/v1/" }, oauth),
    true,
  );
  assert.equal(isOpenAISubscriptionSignIn(openai, apiKey), false);
  assert.equal(isOpenAISubscriptionSignIn(openai, undefined), false);
  assert.equal(isOpenAISubscriptionSignIn(model("openai-codex"), oauth), false);
  assert.equal(
    isOpenAISubscriptionSignIn({ ...openai, baseUrl: "https://proxy.example/v1" }, oauth),
    false,
  );
  const throwing = {
    isUsingOAuth: (): boolean => {
      throw new Error("no auth storage");
    },
  };
  assert.equal(isOpenAISubscriptionSignIn(openai, throwing), false);
});

test("sign-in openai is unsupported with a reason; sk- openai and openai-codex keep priority", () => {
  const state = { sessionId: "s", requested: true, source: "explicit" as const, revision: 1 };
  assert.deepEqual(decideFastMode(state, model("openai"), oauth), {
    ...state,
    supported: false,
    active: false,
    serviceTier: undefined,
    reason: OPENAI_SIGN_IN_FAST_REASON,
  });
  assert.equal(supportsFastMode(model("openai"), oauth), false);
  const paid = decideFastMode(state, model("openai"), apiKey);
  assert.equal(paid.serviceTier, "priority");
  assert.equal(Object.hasOwn(paid, "reason"), false);
  assert.equal(decideFastMode(state, model("openai-codex"), oauth).serviceTier, "priority");
});

test("controller binds its registration registry unless a caller passes one", () => {
  const bridge = createFastModeBridge();
  const controller = bridge.register({
    sessionId: "bound",
    owner,
    generation: 1,
    initial: { requested: true, source: "explicit" },
    modelRegistry: oauth,
  });
  assert.equal(controller.decide(model("openai")).reason, OPENAI_SIGN_IN_FAST_REASON);
  assert.equal(controller.decide(model("openai"), apiKey).active, true);
  controller.dispose();
});

test("provider request hook injects no service_tier for sign-in and keeps it for sk- keys", () => {
  const bridge = createFastModeBridge();
  let start: ((ctx: FastModeExtensionContext) => void) | undefined;
  let request: ((payload: RuntimeValue, ctx: FastModeExtensionContext) => RuntimeValue) | undefined;
  installFastModeExtension(
    bridge,
    { owner, generation: 1, initial: { requested: true, source: "explicit" } },
    {
      appendEntry: () => undefined,
      onSessionStart: (handler) => (start = handler),
      onSessionTree: () => undefined,
      onBeforeProviderRequest: (handler) => (request = handler),
      onSessionShutdown: () => undefined,
    },
  );
  const sessionManager = { getSessionId: () => "hook", getBranch: () => [] };
  start?.({ model: model("openai"), sessionManager, modelRegistry: oauth });
  const signIn = { model: model("openai"), sessionManager, modelRegistry: oauth };
  assert.equal(request?.({ model: "fixture" }, signIn), undefined);
  assert.deepEqual(request?.({ model: "fixture", service_tier: "priority" }, signIn), {
    model: "fixture",
  });
  const keyed = { model: model("openai"), sessionManager, modelRegistry: apiKey };
  assert.deepEqual(request?.({ model: "fixture" }, keyed), {
    model: "fixture",
    service_tier: "priority",
  });
  const codex = { model: model("openai-codex"), sessionManager, modelRegistry: oauth };
  assert.deepEqual(request?.({ model: "fixture" }, codex), {
    model: "fixture",
    service_tier: "priority",
  });
  bridge.get("hook")?.dispose();
});

const xai = (id: string, baseUrl = "https://api.x.ai/v1"): Model<"openai-responses"> => ({
  ...model("xai"),
  id,
  baseUrl,
});

test("xAI Fast is a model variant on api.x.ai grok-4.7 only, with a reason elsewhere", () => {
  const state = { sessionId: "s", requested: true, source: "explicit" as const, revision: 1 };
  assert.deepEqual(decideFastMode(state, xai("grok-4.7")), {
    ...state,
    supported: true,
    active: true,
    serviceTier: undefined,
    fastModelId: "grok-4.7-build-fast",
  });
  assert.equal(decideFastMode({ ...state, requested: false }, xai("grok-4.7")).active, false);
  assert.equal(supportsFastMode(xai("grok-4.7")), true);
  assert.deepEqual(decideFastMode(state, xai("grok-4.5")), {
    ...state,
    supported: false,
    active: false,
    serviceTier: undefined,
    reason: XAI_FAST_MODEL_REASON,
  });
  assert.match(XAI_FAST_MODEL_REASON, /grok-4\.7/);
  const foreign = decideFastMode(state, xai("grok-4.7", "https://proxy.example/v1"));
  assert.equal(foreign.supported, false);
  assert.equal(foreign.reason, XAI_FAST_HOST_REASON);
  assert.equal(supportsFastMode(xai("grok-4.7", "https://proxy.example/v1")), false);
  assert.equal(supportsFastMode(xai("grok-4.7", "not a url")), false);
  assert.equal(supportsFastMode(xai("constructor")), false);
});

test("xAI request swaps the model id only when active and never adds service_tier", () => {
  const state = { sessionId: "s", requested: true, source: "explicit" as const, revision: 1 };
  const base = xai("grok-4.7");
  const on = decideFastMode(state, base);
  const off = decideFastMode({ ...state, requested: false }, base);
  assert.deepEqual(applyFastModeRequest({ model: "grok-4.7", input: [] }, on, base), {
    model: "grok-4.7-build-fast",
    input: [],
  });
  assert.equal(applyFastModeRequest({ model: "grok-4.7" }, off, base), undefined);
  // An existing tier is neither added nor stripped for xAI.
  assert.equal(
    applyFastModeRequest({ model: "grok-4.7", service_tier: "auto" }, off, base),
    undefined,
  );
  assert.deepEqual(applyFastModeRequest({ model: "grok-4.7", service_tier: "auto" }, on, base), {
    model: "grok-4.7-build-fast",
    service_tier: "auto",
  });
  // A payload already rewritten to another model is left alone.
  assert.equal(applyFastModeRequest({ model: "other" }, on, base), undefined);
  const older = xai("grok-4.5");
  assert.equal(
    applyFastModeRequest(
      { model: "grok-4.5", service_tier: "auto" },
      decideFastMode(state, older),
      older,
    ),
    undefined,
  );
});

test("xAI Fast pricing doubles only server-confirmed Fast responses, once", () => {
  const pricing = createXaiFastPricing();
  const message = (responseId: string, modelId = "grok-4.7"): AssistantMessage => ({
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "xai",
    model: modelId,
    responseId,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 17,
      cost: { input: 0.25, output: 0.5, cacheRead: 0.125, cacheWrite: 0, total: 0.875 },
    },
    stopReason: "stop",
    timestamp: 0,
  });
  pricing.observe("xai", {
    type: "response.completed",
    response: { id: "r1", model: "grok-4.7-build-fast" },
  });
  pricing.observe("xai", { type: "response.completed", response: { id: "r2", model: "grok-4.7" } });
  pricing.observe("openai", {
    type: "response.completed",
    response: { id: "r3", model: "grok-4.7-build-fast" },
  });
  const priced = pricing.apply(message("r1"));
  assert.equal(priced?.responseModel, "grok-4.7-build-fast");
  assert.deepEqual(priced?.usage.cost, {
    input: 0.5,
    output: 1,
    cacheRead: 0.25,
    cacheWrite: 0,
    total: 1.75,
  });
  assert.equal(priced?.usage.input, 10);
  assert.equal(pricing.apply(message("r1")), undefined, "consumed once");
  assert.equal(pricing.apply(message("r2")), undefined);
  assert.equal(pricing.apply(message("r3")), undefined);
  pricing.observe("xai", { response: { id: "r4", model: "grok-4.7-build-fast" } });
  assert.equal(
    pricing.apply({ ...message("r4"), responseModel: "grok-4.7-build-fast" }),
    undefined,
  );
});
