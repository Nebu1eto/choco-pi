/**
 * Per-session keying of the Codex background integration: a subagent child's
 * binding is published under the child's owner key, a binding published after
 * the backend was created is picked up, a stale refresh never replaces a newer
 * binding, and one session's shutdown leaves every other session's binding.
 * Offline: no request leaves the process.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";

import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import { codexBackgroundAccountScope } from "../src/adapter/compaction/background-v2.ts";
import {
  type CodexBackgroundContext,
  codexBackgroundOwnerKey,
  createCodexBackgroundIntegration,
  publishedCodexBinding,
  registerCodexBackgroundFactory,
} from "../src/extension/background-compaction.ts";
import { getRegistry } from "../../choco-pi-compaction/src/background/registry.ts";
import {
  refreshSessionNativeState,
  sessionNativeRefreshers,
} from "../../choco-pi-compaction/src/background-host/native-refresh.ts";
import { CHILD_OWNER_KEY_PREFIX } from "../../choco-pi-compaction/src/ownership.ts";

const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("NETWORK FORBIDDEN");
};
afterEach(() => {
  getRegistry().backendFactories.delete("codex-native-v2");
});
after(() => {
  globalThis.fetch = originalFetch;
});

const model: Model<"openai-codex-responses"> = {
  id: "gpt-6-luna",
  name: "Fixture",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 2048,
};
const account = "fixture-keying-account";

function tokenFor(id: string): string {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: id } };
  return `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
}

const scope = {
  provider: model.provider,
  model: model.id,
  baseUrl: model.baseUrl,
  authMode: "oauth",
  accountScope: codexBackgroundAccountScope(account),
};

async function registry(): Promise<ModelRegistry> {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(model.provider, async () => ({
    type: "oauth",
    access: tokenFor(account),
    refresh: "synthetic-unused-refresh",
    expires: Date.now() + 3_600_000,
  }));
  const runtime = await ModelRuntime.create({
    credentials,
    refreshOnCreate: false,
    modelsPath: null,
  });
  runtime.registerProvider(model.provider, { api: model.api, models: [model] });
  return new ModelRegistry(runtime);
}

function contextFor(manager: SessionManager, modelRegistry: ModelRegistry): CodexBackgroundContext {
  return {
    sessionManager: manager,
    model,
    modelRegistry,
    cwd: process.cwd(),
    isProjectTrusted: () => false,
    ui: { notify: () => {} },
  };
}

function newSession(): SessionManager {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "prefix", timestamp: 1 });
  return manager;
}

/** Mark one session ID as a live subagent child while `run` executes. */
async function asChildSession<T>(childId: string, run: () => Promise<T>): Promise<T> {
  const key = Symbol.for("pi-subagents:manager");
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, {
    value: { isChildSessionId: (id: string) => id === childId },
    configurable: true,
  });
  try {
    return await run();
  } finally {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  }
}

const enabled = async () => ({ enabled: true, blockImages: false });

test("the compaction owner-key prefix matches the subagent bridge's", async () => {
  const bridge = await import("../../choco-pi-subagents/src/child-compaction-bridge.ts");
  assert.equal(CHILD_OWNER_KEY_PREFIX, bridge.CHILD_OWNER_KEY_PREFIX);
});

test("a child binding is published under the child key and a late binding is picked up", async () => {
  const manager = newSession();
  const childId = manager.getSessionId();
  await asChildSession(childId, async () => {
    const ownerKey = codexBackgroundOwnerKey(childId);
    assert.equal(ownerKey, `subagent-child:${childId}`);
    assert.equal(registerCodexBackgroundFactory(true), true);
    const factory = getRegistry().backendFactories.get("codex-native-v2");
    assert.ok(factory);
    // The child coordinator's backend exists before the child's Codex refresh bound anything.
    const backend = await factory({ ownerKey, ownerGeneration: 1, providerScope: scope });
    assert.deepEqual(await backend.capability(scope), { supported: false, reason: "unsupported" });
    const controller = createCodexBackgroundIntegration({
      state: {},
      resolveSettings: enabled,
      onInstalled: () => {},
    });
    const ctx = contextFor(manager, await registry());
    controller.begin(ctx);
    assert.ok(await controller.refresh(ctx));
    assert.ok(publishedCodexBinding(ownerKey), "published under the child key");
    assert.equal(publishedCodexBinding(`main-session:${childId}`), undefined);
    assert.deepEqual(await backend.capability(scope), { supported: true }, "late binding used");
    controller.stop(childId);
    assert.equal(publishedCodexBinding(ownerKey), undefined);
  });
});

test("a superseded refresh never replaces the newer generation's binding", async () => {
  const manager = newSession();
  const sessionId = manager.getSessionId();
  const ownerKey = codexBackgroundOwnerKey(sessionId);
  const ctx = contextFor(manager, await registry());
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const controller = createCodexBackgroundIntegration({
    state: {},
    resolveSettings: async () => {
      calls += 1;
      if (calls === 1) await held;
      return { enabled: true, blockImages: false };
    },
    onInstalled: () => {},
  });
  const first = controller.begin(ctx);
  const stale = controller.refresh(ctx, first);
  const second = controller.begin(ctx);
  assert.ok(second > first);
  assert.ok(await controller.refresh(ctx, second));
  const current = publishedCodexBinding(ownerKey);
  assert.ok(current?.isCurrent());
  release();
  assert.equal(await stale, undefined);
  assert.equal(publishedCodexBinding(ownerKey), current, "the newer binding stays published");
  assert.equal(controller.isGenerationCurrent(first), false);
  controller.stop();
});

test("an older registration cannot clobber or withdraw a newer registration's binding", async () => {
  const manager = newSession();
  const sessionId = manager.getSessionId();
  const ownerKey = codexBackgroundOwnerKey(sessionId);
  const ctx = contextFor(manager, await registry());
  const older = createCodexBackgroundIntegration({
    state: {},
    resolveSettings: enabled,
    onInstalled: () => {},
  });
  const newer = createCodexBackgroundIntegration({
    state: {},
    resolveSettings: enabled,
    onInstalled: () => {},
  });
  older.begin(ctx);
  newer.begin(ctx);
  assert.ok(await newer.refresh(ctx));
  const published = publishedCodexBinding(ownerKey);
  assert.ok(published);
  // The older registration's slot is still current in its own state; its refresh is stale here.
  await older.refresh(ctx);
  assert.equal(publishedCodexBinding(ownerKey), published, "not replaced");
  older.stop(sessionId);
  assert.equal(publishedCodexBinding(ownerKey), published, "not withdrawn");
  newer.stop(sessionId);
  assert.equal(publishedCodexBinding(ownerKey), undefined);
});

test("one session's shutdown leaves another session's binding and fence", async () => {
  const models = await registry();
  const a = newSession();
  const b = newSession();
  const controller = createCodexBackgroundIntegration({
    state: {},
    resolveSettings: enabled,
    onInstalled: () => {},
  });
  const ctxA = contextFor(a, models);
  const ctxB = contextFor(b, models);
  const genA = controller.begin(ctxA);
  const genB = controller.begin(ctxB);
  assert.ok(await controller.refresh(ctxA, genA));
  assert.ok(await controller.refresh(ctxB, genB));
  const fenceB = controller.fence(b.getSessionId());
  assert.equal(fenceB.engaged, true);
  controller.stop(a.getSessionId());
  assert.equal(publishedCodexBinding(codexBackgroundOwnerKey(a.getSessionId())), undefined);
  assert.ok(publishedCodexBinding(codexBackgroundOwnerKey(b.getSessionId()))?.isCurrent());
  assert.equal(controller.isStale(fenceB), false, "session B's fence survives A's shutdown");
  assert.equal(controller.isGenerationCurrent(genB), true);
  assert.equal(controller.isGenerationCurrent(genA), false);
  controller.stop();
});

test("the per-session refresher re-runs the restore for that session only", async () => {
  const manager = newSession();
  const sessionId = manager.getSessionId();
  const ctx = contextFor(manager, await registry());
  let settingsReads = 0;
  const controller = createCodexBackgroundIntegration({
    state: {},
    resolveSettings: async () => {
      settingsReads += 1;
      return { enabled: true, blockImages: false };
    },
    onInstalled: () => {},
  });
  controller.begin(ctx);
  assert.deepEqual(sessionNativeRefreshers(sessionId), ["codex-native"]);
  assert.ok(await controller.refresh(ctx));
  const before = publishedCodexBinding(codexBackgroundOwnerKey(sessionId));
  await refreshSessionNativeState(sessionId, ctx);
  assert.equal(
    publishedCodexBinding(codexBackgroundOwnerKey(sessionId)),
    before,
    "same scope kept",
  );
  assert.equal(settingsReads, 1, "the settings snapshot of this generation is reused");
  // Another session's ID reaches nothing of this one.
  await refreshSessionNativeState("unrelated-session", ctx);
  controller.stop(sessionId);
  assert.deepEqual(sessionNativeRefreshers(sessionId), [], "shutdown unregisters the refresher");
});
