import assert from "node:assert/strict";
import test from "node:test";
import { cleanupSessionResources, type Model } from "@earendil-works/pi-ai";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import {
  createFastModeBridge,
  decideFastMode,
  installFastModeExtension,
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
