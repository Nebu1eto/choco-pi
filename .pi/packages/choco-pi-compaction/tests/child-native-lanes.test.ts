/**
 * Subagent children select the same provider-native lanes as the main session
 * for the same model: owner keys, the child owner spec's lane switches, and
 * the backend a Codex child's coordinator selects. Offline.
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import type { ChildCoordinatorContext } from "../../choco-pi-subagents/src/child-compaction-bridge.ts";
import { codexBackgroundAccountScope } from "../../choco-pi-codex/src/adapter/compaction/background-v2.ts";
import {
  createCodexBackgroundIntegration,
  registerCodexBackgroundFactory,
} from "../../choco-pi-codex/src/extension/background-compaction.ts";
import {
  type Backend,
  type BackendFactoryContext,
  type CoordinatorStatus,
  DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
} from "../src/background/contract.ts";
import { getRegistry, registerBackendFactory } from "../src/background/registry.ts";
import { CODEX_BACKEND_SETTING_ID } from "../src/background/settings.ts";
import { TEXT_BACKEND_ID } from "../src/background/text-backend.ts";
import { childOwnerSpec, type ChildSpecRuntime } from "../src/background-host/child-provider.ts";
import { nativeLaneSwitches } from "../src/background-host/native-lanes.ts";
import {
  refreshSessionNativeState,
  registerSessionNativeRefresher,
  sessionNativeRefreshers,
} from "../src/background-host/native-refresh.ts";
import { createOwnerCore } from "../src/background-host/owner-core.ts";
import { CHILD_OWNER_KEY_PREFIX, mainOwnerKey, ownerKeyFor } from "../src/ownership.ts";
import type { CompactionSessionState } from "../src/session-state.ts";
import { createXaiCapabilityGate } from "../src/xai/capability.ts";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const CHILD_IDS = new Set<string>();
Object.defineProperty(globalThis, MANAGER_KEY, {
  value: { isChildSessionId: (id: string) => CHILD_IDS.has(id) },
  configurable: true,
});

const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("NETWORK FORBIDDEN");
};
afterEach(() => {
  CHILD_IDS.clear();
  getRegistry().backendFactories.delete(CODEX_BACKEND_SETTING_ID);
});
test.after(() => {
  globalThis.fetch = originalFetch;
});

function model(fields: Pick<Model<Api>, "id" | "api" | "provider" | "baseUrl">): Model<Api> {
  return {
    ...fields,
    name: fields.id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
  };
}

const CODEX = model({
  id: "gpt-6-luna",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
});
const ANTHROPIC = model({
  id: "claude-haiku-5-5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
});
const XAI = model({
  id: "grok-test-1",
  api: "openai-responses",
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
});

const SETTINGS = {
  ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
  enabled: true,
  text: true,
  codexNative: true,
  anthropicNative: true,
};

function runtime(xaiMode: ChildSpecRuntime["xaiMode"]): ChildSpecRuntime {
  return {
    loaded: { settings: SETTINGS, source: undefined, diagnostic: undefined },
    xaiMode,
    xaiGate: createXaiCapabilityGate({ cooldownMs: 0 }),
  };
}

async function registry(): Promise<ModelRegistry> {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false,
    modelsPath: null,
  });
  return new ModelRegistry(modelRuntime);
}

const STATE: CompactionSessionState = {
  generation: 1,
  retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
  codexCompaction: { responsesCompaction: true, additionalProviders: [] },
  compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 0 }),
};

function childContext(child: SessionManager, active: Model<Api>): ChildCoordinatorContext {
  const childSessionId = child.getSessionId();
  return {
    ownerKey: ownerKeyFor(childSessionId),
    ownerGeneration: 1,
    childSessionId,
    parentSessionId: "parent-session",
    mainSessionFork: false,
    readOnly: false,
    isolated: false,
    sessionManager: child,
    model: active,
    appendRecord: () => {},
    appendAnchor: () => "",
    signal: new AbortController().signal,
  };
}

function childSession(): SessionManager {
  const child = SessionManager.inMemory();
  CHILD_IDS.add(child.getSessionId());
  return child;
}

test("owner keys: a child session is keyed like the subagent bridge, a main session as before", async () => {
  const bridge = await import("../../choco-pi-subagents/src/child-compaction-bridge.ts");
  assert.equal(CHILD_OWNER_KEY_PREFIX, bridge.CHILD_OWNER_KEY_PREFIX);
  CHILD_IDS.add("child-1");
  assert.equal(ownerKeyFor("child-1"), "subagent-child:child-1");
  assert.equal(ownerKeyFor("main-1"), mainOwnerKey("main-1"));
  assert.equal(mainOwnerKey("main-1"), "main-session:main-1");
});

test("a child's lane switches equal the main session's for the same model", async () => {
  const models = await registry();
  for (const xaiMode of ["server-side", "choco-pi"] as const) {
    const rt = runtime(xaiMode);
    for (const active of [CODEX, ANTHROPIC, XAI]) {
      const child = childSession();
      const spec = childOwnerSpec(rt, {
        host: { modelRegistry: models, state: STATE },
        child: childContext(child, active),
        model: active,
        scope: { provider: active.provider, model: active.id, baseUrl: active.baseUrl },
        report: () => {},
      });
      const lanes = {
        allowAnthropic: spec.allowAnthropic,
        allowForeign: spec.allowForeign,
        xaiServerSide: spec.xaiServerSide,
      };
      assert.deepEqual(lanes, nativeLaneSwitches(rt, active), `${xaiMode} ${active.id}`);
      assert.equal(spec.ownerKey, `subagent-child:${child.getSessionId()}`);
    }
  }
  const rt = runtime("server-side");
  assert.deepEqual(nativeLaneSwitches(rt, ANTHROPIC), {
    allowAnthropic: true,
    allowForeign: true,
    xaiServerSide: false,
  });
  assert.equal(nativeLaneSwitches(rt, XAI).xaiServerSide, true, "admitted xAI model");
  assert.equal(nativeLaneSwitches(runtime("choco-pi"), XAI).xaiServerSide, false);
});

test("a Codex child's coordinator selects the Codex backend under the child's owner key", async () => {
  const contexts: BackendFactoryContext[] = [];
  const probe: Backend = {
    id: CODEX_BACKEND_SETTING_ID,
    capability: async () => ({ supported: true }),
    isLegalCut: () => ({ legal: false, reason: "no-legal-cut" }),
    prepare: async () => ({ ok: false, reason: "unsupported", retryable: false }),
  };
  registerBackendFactory(CODEX_BACKEND_SETTING_ID, (context) => {
    contexts.push(context);
    return probe;
  });
  const models = await registry();
  const child = childSession();
  const spec = childOwnerSpec(runtime("server-side"), {
    host: { modelRegistry: models, state: STATE },
    child: childContext(child, CODEX),
    model: CODEX,
    scope: { provider: CODEX.provider, model: CODEX.id, baseUrl: CODEX.baseUrl },
    report: (message) => assert.fail(message),
  });
  const core = await createOwnerCore(spec, {});
  assert.ok(core, "a child coordinator exists");
  try {
    assert.equal(core.backendId, CODEX_BACKEND_SETTING_ID);
    assert.ok(core.backendIds.includes(TEXT_BACKEND_ID), "the text lane stays the fallback");
    assert.deepEqual(
      contexts.map((context) => context.ownerKey),
      [`subagent-child:${child.getSessionId()}`],
    );
  } finally {
    core.dispose();
  }
});

test("an admitted xAI child leaves compaction to xAI server-side, as the main session does", async () => {
  const models = await registry();
  const child = childSession();
  const spec = childOwnerSpec(runtime("server-side"), {
    host: { modelRegistry: models, state: STATE },
    child: childContext(child, XAI),
    model: XAI,
    scope: { provider: XAI.provider, model: XAI.id, baseUrl: XAI.baseUrl },
    report: (message) => assert.fail(message),
  });
  const core = await createOwnerCore(spec, {});
  assert.ok(core);
  try {
    assert.equal(core.backendId, undefined, "no background lane over an opaque xAI checkpoint");
  } finally {
    core.dispose();
  }
});

test("native refreshers run per session; only stale-context failures are contained", async () => {
  const calls: string[] = [];
  const offA = registerSessionNativeRefresher("s-a", "one", () => {
    calls.push("a:one");
  });
  const offB = registerSessionNativeRefresher("s-b", "one", () => {
    calls.push("b:one");
  });
  const stale = registerSessionNativeRefresher("s-a", "stale", () => {
    throw new Error("This extension ctx is stale after session replacement or reload. fixture");
  });
  const ctx = {
    sessionManager: SessionManager.inMemory(),
    model: undefined,
    modelRegistry: await registry(),
    cwd: process.cwd(),
    isProjectTrusted: () => false,
    ui: { notify: () => {} },
  };
  await refreshSessionNativeState("s-a", ctx);
  assert.deepEqual(calls, ["a:one"], "only the named session's refreshers ran");
  stale();
  const failure = new Error("real failure");
  const failing = registerSessionNativeRefresher("s-a", "failing", () => {
    throw failure;
  });
  await assert.rejects(refreshSessionNativeState("s-a", ctx), (cause) => cause === failure);
  assert.deepEqual(calls, ["a:one", "a:one"], "every contributor ran before the rethrow");

  // A replaced contributor's old unregister never removes the newer one.
  const replacement = registerSessionNativeRefresher("s-a", "one", () => {
    calls.push("a:one-new");
  });
  offA();
  assert.deepEqual(sessionNativeRefreshers("s-a"), ["one", "failing"]);
  failing();
  replacement();
  offB();
  assert.deepEqual(sessionNativeRefreshers("s-a"), []);
  assert.deepEqual(sessionNativeRefreshers("s-b"), []);
});
test("a Codex child whose Codex lane refuses the cut never prepares on the text lane", async () => {
  const account = "fixture-child-lane-account";
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: account } };
  const token = `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(CODEX.provider, async () => ({
    type: "oauth",
    access: token,
    refresh: "synthetic-unused-refresh",
    expires: Date.now() + 3_600_000,
  }));
  const modelRuntime = await ModelRuntime.create({
    credentials,
    refreshOnCreate: false,
    modelsPath: null,
  });
  modelRuntime.registerProvider(CODEX.provider, { api: CODEX.api, models: [CODEX] });
  const models = new ModelRegistry(modelRuntime);
  const child = childSession();
  child.appendMessage({ role: "user", content: "CHILD-A", timestamp: 1 });
  child.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "CHILD-B" }],
    api: CODEX.api,
    provider: CODEX.provider,
    model: CODEX.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  child.appendMessage({ role: "user", content: "CHILD-C", timestamp: 3 });
  // The child's Codex binding exists (the real factory, published under the child key),
  // but no provider response was recorded for the child, so the Codex capture refuses.
  registerCodexBackgroundFactory(true);
  const integration = createCodexBackgroundIntegration({
    state: {},
    resolveSettings: async () => ({ enabled: true, blockImages: false }),
    onInstalled: () => {},
  });
  const ctx = {
    sessionManager: child,
    model: CODEX,
    modelRegistry: models,
    cwd: process.cwd(),
    isProjectTrusted: () => false,
    ui: { notify: () => {} },
  };
  integration.begin(ctx);
  assert.ok(await integration.refresh(ctx));
  const summarized: string[] = [];
  const rt: ChildSpecRuntime = {
    ...runtime("server-side"),
    loaded: {
      settings: { ...SETTINGS, cooldownMs: 0 },
      source: undefined,
      diagnostic: undefined,
    },
  };
  const scope = {
    provider: CODEX.provider,
    model: CODEX.id,
    baseUrl: CODEX.baseUrl,
    authMode: "oauth",
    accountScope: codexBackgroundAccountScope(account),
  };
  const core = await createOwnerCore(
    childOwnerSpec(rt, {
      host: { modelRegistry: models, state: STATE },
      child: childContext(child, CODEX),
      model: CODEX,
      scope,
      report: () => {},
    }),
    {
      createTextSummarizer: () => ({
        scope,
        summarize: async () => {
          summarized.push("text");
          throw new Error("the text lane must not serve a Codex child");
        },
      }),
    },
  );
  assert.ok(core);
  try {
    assert.equal(core.backendId, CODEX_BACKEND_SETTING_ID);
    const usage = { tokens: 190_000, contextWindow: 200_000, percent: 95 };
    for (let attempt = 0; attempt < 2; attempt++) {
      core.observeUsage(usage);
      await core.coordinator.waitForPreparation();
      const status: CoordinatorStatus = core.coordinator.status();
      assert.equal(status.state, "failed", `attempt ${attempt}`);
      assert.equal(status.backendId, CODEX_BACKEND_SETTING_ID, `attempt ${attempt} stays on Codex`);
      assert.equal(status.reason, "no-legal-cut");
      assert.equal(status.detail, "no_state", "the capture refuses before any provider response");
    }
    assert.deepEqual(summarized, [], "no text preparation for a Codex child");
  } finally {
    core.dispose();
    integration.stop();
  }
});
