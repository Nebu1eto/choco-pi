import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  ExtensionRunner,
  createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import type { AdapterState } from "../src/adapter/activation/state.ts";
import { createCodexTurnState } from "../src/providers/openai-codex/turn-state.ts";
import { rewriteCodexProviderRequest } from "../src/adapter/provider-request.ts";
import { serializeActiveSessionToResponsesInput } from "../src/adapter/compaction/serializer.ts";
import { InMemoryCredentialStore, normalizeContext, type Model } from "@earendil-works/pi-ai";
import { buildSnapshot } from "../../choco-pi-compaction/tests/background-fakes.ts";
import { getRegistry } from "../../choco-pi-compaction/src/background/registry.ts";
import type {
  BackendFactoryContext,
  CoordinatorApi,
  AdoptionConsumer,
  PreSnapshotParticipant,
  FrozenSnapshot,
} from "../../choco-pi-compaction/src/background/contract.ts";
import {
  createCapturedCodexBackend,
  consumeCodexBackgroundAdoption,
  createCodexBackgroundIntegration,
  registerCodexBackgroundFactory,
  codexBackgroundOwnerKey,
  updateCodexBackgroundElision,
  codexBackgroundAuthToken,
  type CodexBackgroundBinding,
  type CodexBackgroundContext,
} from "../src/extension/background-compaction.ts";
import { codexBackgroundAccountScope } from "../src/adapter/compaction/background-v2.ts";
import { isBackgroundNativeCompactionDetails } from "../src/adapter/compaction/details-store.ts";
import { createOpenAICodexProviderStream } from "../src/providers/openai-codex-custom-provider.ts";
import {
  cleanupOpenAICodexTransportSession,
  resetOpenAICodexTransportSession,
} from "../src/providers/openai-codex/transport-cleanup.ts";

const originalFetch = globalThis.fetch;
let globalCalls = 0;
globalThis.fetch = () => {
  globalCalls++;
  throw new Error("NETWORK FORBIDDEN");
};
const cleanupSessions = new Set<string>();
const cleanupOwners = new Set<string>();
afterEach(() => {
  assert.equal(globalCalls, 0);
  for (const id of cleanupSessions) cleanupOpenAICodexTransportSession(id);
  cleanupSessions.clear();
  for (const owner of cleanupOwners) getRegistry().coordinators.delete(owner);
  cleanupOwners.clear();
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
const account = "fixture-adoption-account";
const withoutResponsesLite = { useResponsesLite: () => false };
function tokenFor(id: string): string {
  return `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.fixture`;
}
function response(compact: boolean): Response {
  const output = compact
    ? [
        {
          type: "compaction",
          id: "fixture-checkpoint",
          encrypted_content: "SYNTHETIC-OPAQUE-NOT-CIPHERTEXT",
        },
      ]
    : [];
  const events = [
    ...output.map((item) => ({ type: "response.output_item.done", item })),
    {
      type: "response.completed",
      response: {
        id: "fixture-response",
        status: "completed",
        output,
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          total_tokens: 11,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
async function fixture() {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(model.provider, async () => ({
    type: "oauth",
    access: tokenFor(account),
    refresh: "synthetic-unused-refresh",
    expires: Date.now() + 3600000,
  }));
  const runtime = await ModelRuntime.create({
    credentials,
    refreshOnCreate: false,
    modelsPath: null,
  });
  runtime.registerProvider(model.provider, {
    api: model.api,
    models: [model],
    streamSimple: (m, context, options) =>
      createOpenAICodexProviderStream(m, normalizeContext(context), options, withoutResponsesLite),
  });
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "Complete prefix", timestamp: 1 });
  const sessionId = manager.getSessionId();
  cleanupSessions.add(sessionId);
  const diagnostics: string[] = [];
  const ctx: CodexBackgroundContext = {
    sessionManager: manager,
    model,
    modelRegistry: new ModelRegistry(runtime),
    cwd: process.cwd(),
    isProjectTrusted: () => false,
    ui: {
      notify: (message) => {
        diagnostics.push(message);
      },
    },
  };
  const state: CodexBackgroundBinding["state"] = {};
  const elision = new Map([
    [sessionId, { epoch: "old", cut: 42 }],
    ["unrelated", { epoch: "untouched", cut: 9 }],
  ]);
  const scope = {
    provider: model.provider,
    model: model.id,
    baseUrl: model.baseUrl,
    authMode: "oauth",
    accountScope: codexBackgroundAccountScope(account),
  };
  const context: BackendFactoryContext = {
    ownerKey: codexBackgroundOwnerKey(sessionId),
    ownerGeneration: 1,
    providerScope: scope,
  };
  let fetchCalls = 0;
  const binding: CodexBackgroundBinding = {
    sessionId,
    ctx,
    model,
    scope,
    accountId: account,
    state,
    blockImages: false,
    cleanup: new Set(),
    isCurrent: () => true,
    runtime: {
      provider: model.provider,
      api: model.api,
      apiFamily: model.api,
      codexTransport: true,
      model: model.id,
      baseUrl: model.baseUrl,
      apiKey: tokenFor(account),
      currentModel: model,
    },
    fetch: async () => {
      fetchCalls++;
      return response(true);
    },
    onInstalled: (id, epoch) => {
      updateCodexBackgroundElision(elision, id, epoch);
    },
  };
  const leafId = manager.getLeafId();
  assert.ok(leafId);
  const snapshot: FrozenSnapshot = buildSnapshot({
    ...context,
    entries: manager.getBranch(),
    cutEntryId: leafId,
  });
  const seed = async (): Promise<void> => {
    const result = await createOpenAICodexProviderStream(
      model,
      normalizeContext({ messages: [{ role: "user", content: "Complete prefix", timestamp: 1 }] }),
      {
        apiKey: tokenFor(account),
        sessionId,
        transport: "sse",
        fetch: async () => response(false),
        maxRetries: 0,
      },
      { useResponsesLite: () => false },
    ).result();
    assert.equal(result.stopReason, "stop");
  };
  const request = () => ({
    signal: new AbortController().signal,
    candidateId: "fixture-candidate",
    budget: {
      maxInputTokens: 10000,
      maxOutputTokens: 100,
      maxResultBytes: 10000,
      deadlineMs: Date.now() + 5000,
      maxAttempts: 1,
    },
  });
  return {
    binding,
    context,
    snapshot,
    seed,
    request,
    manager,
    runtime,
    credentials,
    diagnostics,
    state,
    elision,
    fetchCalls: () => fetchCalls,
  };
}

test("factory yields to preregistration and remains idempotent; disabled binding is inert", async () => {
  const setup = await fixture();
  assert.equal(registerCodexBackgroundFactory(false), false);
  assert.equal(getRegistry().backendFactories.has("codex-native-v2"), false);
  assert.equal(registerCodexBackgroundFactory(true), true);
  const factory = getRegistry().backendFactories.get("codex-native-v2");
  assert.ok(factory);
  assert.equal(registerCodexBackgroundFactory(true), false);
  assert.equal(getRegistry().backendFactories.get("codex-native-v2"), factory);
  const backend = await factory(setup.context);
  assert.deepEqual(await backend.capability(setup.context.providerScope), {
    supported: false,
    reason: "unsupported",
  });
  const controller = createCodexBackgroundIntegration({
    state: setup.state,
    resolveSettings: async () => ({ enabled: false, blockImages: false }),
    onInstalled: () => assert.fail("disabled adoption"),
  });
  controller.begin(setup.binding.ctx);
  await controller.refresh(setup.binding.ctx);
  assert.equal(setup.binding.cleanup.size, 0);
  assert.equal(setup.fetchCalls(), 0);
  controller.stop();
  getRegistry().backendFactories.delete("codex-native-v2");
  getRegistry().backendFactories.set("codex-native-v2", factory);
  assert.equal(registerCodexBackgroundFactory(true), false);
});

test("cut capture is detached and reused after foreground lineage disappears", async () => {
  const setup = await fixture();
  await setup.seed();
  const backend = createCapturedCodexBackend(setup.context, setup.binding);
  const before = structuredClone(setup.snapshot);
  assert.deepEqual(backend.isLegalCut(setup.snapshot), { legal: true });
  assert.deepEqual(setup.snapshot, before);
  resetOpenAICodexTransportSession(setup.binding.sessionId);
  const prepared = await backend.prepare(setup.snapshot, setup.request());
  assert.ok("draft" in prepared);
  assert.equal(setup.fetchCalls(), 1);
  assert.ok(isBackgroundNativeCompactionDetails(prepared.details));
  assert.equal(prepared.details.prefixFingerprint, setup.snapshot.prefixFingerprint);
  const unseen = { ...setup.snapshot };
  assert.deepEqual(backend.isLegalCut(unseen), {
    legal: false,
    reason: "no-legal-cut",
    detail: "no_state",
  });
  assert.deepEqual(await backend.prepare(unseen, setup.request()), {
    ok: false,
    reason: "no-legal-cut",
    detail: "no_state",
    retryable: false,
  });
  assert.equal(setup.fetchCalls(), 1);
});

test("incomplete canonical lineage fails closed before paid transport", async () => {
  const setup = await fixture();
  const backend = createCapturedCodexBackend(setup.context, setup.binding);
  assert.deepEqual(backend.isLegalCut(setup.snapshot), {
    legal: false,
    reason: "no-legal-cut",
    detail: "no_state",
  });
  assert.deepEqual(await backend.prepare(setup.snapshot, setup.request()), {
    ok: false,
    detail: "no_state",
    reason: "no-legal-cut",
    retryable: false,
  });
  assert.equal(setup.fetchCalls(), 0);
});

async function committedFixture() {
  const setup = await fixture();
  await setup.seed();
  const backend = createCapturedCodexBackend(setup.context, setup.binding);
  assert.deepEqual(backend.isLegalCut(setup.snapshot), { legal: true });
  const prepared = await backend.prepare(setup.snapshot, setup.request());
  assert.ok("draft" in prepared && isBackgroundNativeCompactionDetails(prepared.details));
  const id = setup.manager.appendCompaction(
    prepared.draft.summary,
    prepared.draft.firstKeptEntryId ?? "",
    setup.snapshot.tokenEstimate,
    prepared.details,
  );
  const adoption = {
    adoptionId: "fixture-adoption",
    candidateId: prepared.candidateId,
    committedEntryId: id,
    backendId: prepared.backendId,
    fingerprint: setup.snapshot.prefixFingerprint,
  };
  return { ...setup, prepared, adoption };
}

test("consumer requires committed candidate/fingerprint, is exactly once, and updates target elision only", async () => {
  const setup = await committedFixture();
  const adopted = new Set<string>();
  assert.throws(
    () =>
      consumeCodexBackgroundAdoption(
        setup.binding,
        setup.context,
        { ...setup.adoption, fingerprint: "wrong" },
        adopted,
      ),
    /matching committed/,
  );
  assert.equal(setup.state.pendingPiCompactionNativeWindow, undefined);
  consumeCodexBackgroundAdoption(setup.binding, setup.context, setup.adoption, adopted);
  const installed = setup.state.pendingPiCompactionNativeWindow;
  assert.ok(installed);
  consumeCodexBackgroundAdoption(setup.binding, setup.context, setup.adoption, adopted);
  assert.equal(setup.state.pendingPiCompactionNativeWindow, installed);
  assert.deepEqual(setup.elision.get(setup.binding.sessionId), {
    epoch: setup.adoption.committedEntryId,
    cut: 0,
  });
  assert.deepEqual(setup.elision.get("unrelated"), { epoch: "untouched", cut: 9 });
  assert.equal(adopted.size, 1);
});

test("wrong target session adoption cannot install transport state", async () => {
  const setup = await committedFixture();
  const otherState: CodexBackgroundBinding["state"] = {};
  assert.throws(
    () =>
      consumeCodexBackgroundAdoption(
        { ...setup.binding, sessionId: "different-session", state: otherState },
        setup.context,
        setup.adoption,
        new Set(),
      ),
    /incompatible/,
  );
  assert.equal(otherState.pendingPiCompactionNativeWindow, undefined);
});

test("reload installs compatible committed replay; account/model change reports explicit incompatibility", async () => {
  const setup = await committedFixture();
  const controller = createCodexBackgroundIntegration({
    state: setup.state,
    resolveSettings: async () => ({ enabled: true, blockImages: false }),
    onInstalled: setup.binding.onInstalled,
  });
  controller.begin(setup.binding.ctx);
  const resolved = await controller.refresh(setup.binding.ctx);
  assert.ok(resolved, setup.diagnostics.join("; "));
  assert.equal(
    setup.state.pendingPiCompactionNativeWindow?.sourceCompactionEntryId,
    setup.adoption.committedEntryId,
  );
  await setup.credentials.modify(model.provider, async () => ({
    type: "oauth",
    access: tokenFor("changed-account"),
    refresh: "synthetic-unused-refresh",
    expires: Date.now() + 3600000,
  }));
  await controller.refresh(setup.binding.ctx);
  assert.equal(setup.state.pendingPiCompactionNativeWindow, undefined);
  assert.match(setup.diagnostics.at(-1) ?? "", /incompatible.*account/);
  await controller.refresh({ ...setup.binding.ctx, model: { ...model, id: "different-model" } });
  assert.match(setup.diagnostics.at(-1) ?? "", /incompatible.*model/);
  controller.stop();
});

test("incompatible checkpoint bypasses legacy replay per request; compatible replay is unchanged", async () => {
  const setup = await committedFixture();
  const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
  config.executionMode = "normal";
  config.compaction.responsesCompaction = true;
  const state: AdapterState = {
    enabled: true,
    cwd: process.cwd(),
    promptSkills: [],
    config,
    executionMode: "normal",
    codexTurnState: createCodexTurnState(),
  };
  const extensionRuntime = createExtensionRuntime();
  extensionRuntime.getThinkingLevel = () => "off";
  const runner = new ExtensionRunner(
    [],
    extensionRuntime,
    process.cwd(),
    setup.manager,
    setup.binding.ctx.modelRegistry,
  );
  const ctx = { ...runner.createContext(), model, ui: runner.getUIContext() };
  const controller = createCodexBackgroundIntegration({
    state,
    resolveSettings: async () => ({ enabled: true, blockImages: false }),
    onInstalled: () => {},
  });
  controller.begin(ctx);
  await controller.refresh(ctx);
  const compatibleState = controller.requestState(state, setup.binding.sessionId);
  assert.equal(compatibleState, state);
  const payload = {
    model: model.id,
    input: serializeActiveSessionToResponsesInput({
      model,
      entries: setup.manager.getBranch(),
      options: { blockImages: false },
    }),
  };
  const InputBodySchema = Type.Object(
    {
      input: Type.Array(
        Type.Object({ type: Type.Optional(Type.String()) }, { additionalProperties: true }),
      ),
    },
    { additionalProperties: true },
  );
  const compatible = await rewriteCodexProviderRequest(payload, ctx, compatibleState);
  assert.ok(Value.Check(InputBodySchema, compatible));
  assert.ok(compatible.input.some((item) => item.type === "compaction"));
  await setup.credentials.modify(model.provider, async () => ({
    type: "oauth",
    access: tokenFor("incompatible-account"),
    refresh: "synthetic-unused-refresh",
    expires: Date.now() + 3600000,
  }));
  await controller.refresh(ctx);
  const bypass = controller.requestState(state, setup.binding.sessionId);
  assert.notEqual(bypass, state);
  assert.equal(bypass.config.compaction.responsesCompaction, false);
  assert.equal(state.config.compaction.responsesCompaction, true);
  assert.equal(bypass.pendingPiCompactionNativeWindow, undefined);
  assert.equal(state.pendingPiCompactionNativeWindow, undefined);
  const outgoing = await rewriteCodexProviderRequest(payload, ctx, bypass);
  assert.ok(Value.Check(InputBodySchema, outgoing));
  assert.equal(
    outgoing.input.some((item) => item.type === "compaction"),
    false,
  );
  assert.equal(controller.requestState(state, "unrelated-session"), state);
  state.config.openai.verbosity = "high";
  assert.equal(
    controller.requestState(state, setup.binding.sessionId).config.openai.verbosity,
    "high",
  );
  controller.stop();
});

test("header-only Bearer auth restores a compatible committed checkpoint", async () => {
  const setup = await committedFixture();
  assert.equal(
    codexBackgroundAuthToken(undefined, { Authorization: `Bearer ${tokenFor(account)}` }),
    tokenFor(account),
  );
  assert.equal(
    codexBackgroundAuthToken(undefined, { authorization: `bearer ${tokenFor(account)}` }),
    tokenFor(account),
  );
  assert.equal(
    codexBackgroundAuthToken(undefined, { Authorization: "Basic synthetic" }),
    undefined,
  );
  const registry = setup.binding.ctx.modelRegistry;
  const getAuth = registry.getApiKeyAndHeaders.bind(registry);
  registry.getApiKeyAndHeaders = async (current) => {
    const auth = await getAuth(current);
    if (!auth?.ok || auth.apiKey === undefined) return auth;
    const headerAuth: NonNullable<Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>> = {
      ok: true,
      headers: { Authorization: `Bearer ${auth.apiKey}` },
    };
    if (auth.baseUrl !== undefined) headerAuth.baseUrl = auth.baseUrl;
    return headerAuth;
  };
  const controller = createCodexBackgroundIntegration({
    state: setup.state,
    resolveSettings: async () => ({ enabled: true, blockImages: false }),
    onInstalled: setup.binding.onInstalled,
  });
  controller.begin(setup.binding.ctx);
  assert.ok(await controller.refresh(setup.binding.ctx));
  assert.equal(
    setup.state.pendingPiCompactionNativeWindow?.sourceCompactionEntryId,
    setup.adoption.committedEntryId,
  );
  assert.deepEqual(setup.diagnostics, []);
  controller.stop();
});

test("stale session generation cannot install replay after settings await", async () => {
  const setup = await committedFixture();
  let release: ((settings: { enabled: boolean; blockImages: boolean }) => void) | undefined;
  const gate = new Promise<{ enabled: boolean; blockImages: boolean }>((resolve) => {
    release = resolve;
  });
  const controller = createCodexBackgroundIntegration({
    state: setup.state,
    resolveSettings: () => gate,
    onInstalled: () => assert.fail("stale adoption"),
  });
  controller.begin(setup.binding.ctx);
  const pending = controller.refresh(setup.binding.ctx);
  controller.stop();
  assert.ok(release);
  release({ enabled: true, blockImages: false });
  await pending;
  assert.equal(setup.state.pendingPiCompactionNativeWindow, undefined);
});

test("stale auth await cannot install a committed replay", async () => {
  const setup = await committedFixture();
  const registry = setup.binding.ctx.modelRegistry;
  const getAuth = registry.getApiKeyAndHeaders.bind(registry);
  let entered: (() => void) | undefined;
  let released: (() => void) | undefined;
  const enteredAuth = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const authGate = new Promise<void>((resolve) => {
    released = resolve;
  });
  registry.getApiKeyAndHeaders = async (current) => {
    entered?.();
    await authGate;
    return getAuth(current);
  };
  const controller = createCodexBackgroundIntegration({
    state: setup.state,
    resolveSettings: async () => ({ enabled: true, blockImages: false }),
    onInstalled: () => assert.fail("stale auth install"),
  });
  controller.begin(setup.binding.ctx);
  const pending = controller.refresh(setup.binding.ctx);
  await enteredAuth;
  controller.stop();
  assert.ok(released);
  released();
  assert.equal(await pending, undefined);
  assert.equal(setup.state.pendingPiCompactionNativeWindow, undefined);
});

test("only stale-context errors are contained; unrelated failures are rethrown", async () => {
  const setup = await fixture();
  const failure = new Error("unrelated fixture error");
  const failing = createCodexBackgroundIntegration({
    state: setup.state,
    resolveSettings: async () => {
      throw failure;
    },
    onInstalled: () => {},
  });
  failing.begin(setup.binding.ctx);
  await assert.rejects(failing.refresh(setup.binding.ctx), (cause) => cause === failure);
  failing.stop();
  const stale = createCodexBackgroundIntegration({
    state: setup.state,
    resolveSettings: async () => {
      throw new Error("This extension ctx is stale after session replacement or reload. fixture");
    },
    onInstalled: () => {},
  });
  stale.begin(setup.binding.ctx);
  assert.equal(await stale.refresh(setup.binding.ctx), undefined);
  stale.stop();
});

test("malformed committed background metadata reports incompatibility instead of silent loss", async () => {
  const setup = await committedFixture();
  assert.ok(isBackgroundNativeCompactionDetails(setup.prepared.details));
  setup.manager.appendCompaction("invalid checkpoint", "", 1000, {
    ...setup.prepared.details,
    prefixFingerprint: "",
  });
  const controller = createCodexBackgroundIntegration({
    state: setup.state,
    resolveSettings: async () => ({ enabled: true, blockImages: false }),
    onInstalled: () => assert.fail("invalid checkpoint install"),
  });
  controller.begin(setup.binding.ctx);
  assert.equal(await controller.refresh(setup.binding.ctx), undefined);
  assert.equal(setup.state.pendingPiCompactionNativeWindow, undefined);
  assert.match(setup.diagnostics.at(-1) ?? "", /incompatible.*invalid checkpoint metadata/);
  controller.stop();
});

test("lazy factory binds after construction; consumer attaches once and duplicate notifications settle once", async () => {
  const setup = await committedFixture();
  registerCodexBackgroundFactory(true);
  const factory = getRegistry().backendFactories.get("codex-native-v2");
  assert.ok(factory);
  const backend = await factory(setup.context);
  assert.deepEqual(await backend.capability(setup.context.providerScope), {
    supported: false,
    reason: "unsupported",
  });
  const consumers = new Set<AdoptionConsumer>();
  const participants = new Set<PreSnapshotParticipant>();
  const coordinator: CoordinatorApi = {
    ...setup.context,
    requestPreparation: async () => ({ accepted: false, reason: "busy" }),
    cancel: () => {},
    status: () => ({ ...setup.context, state: "idle" }),
    arbitrateHostCompaction: async () => ({ action: "proceed" }),
    arbitrateManualCompact: async () => ({ action: "proceed" }),
    registerConsumer: (consumer) => {
      consumers.add(consumer);
      return () => {
        consumers.delete(consumer);
      };
    },
    registerParticipant: (participant) => {
      participants.add(participant);
      return () => {
        participants.delete(participant);
      };
    },
    dispose: () => {},
  };
  getRegistry().coordinators.set(setup.context.ownerKey, coordinator);
  cleanupOwners.add(setup.context.ownerKey);
  let notifications = 0;
  const controller = createCodexBackgroundIntegration({
    state: setup.state,
    resolveSettings: async () => ({ enabled: true, blockImages: false }),
    onInstalled: () => {
      notifications++;
    },
  });
  controller.begin(setup.binding.ctx);
  await controller.refresh(setup.binding.ctx);
  assert.deepEqual(await backend.capability(setup.context.providerScope), { supported: true });
  await backend.capability(setup.context.providerScope);
  assert.equal(consumers.size, 1);
  assert.equal(participants.size, 0);
  const reloaded = notifications;
  for (const consumer of consumers) {
    await consumer.onAdopted(setup.adoption);
    await consumer.onAdopted(setup.adoption);
  }
  assert.equal(notifications, reloaded + 1);
  controller.stop();
  assert.equal(consumers.size, 0);
  assert.equal(participants.size, 0);
});

test("a malformed settings diagnostic is shown once per session, not on every refresh", async () => {
  const setup = await fixture();
  const controller = createCodexBackgroundIntegration({
    state: setup.state,
    resolveSettings: async () => ({
      enabled: false,
      blockImages: false,
      diagnostic: "fixture settings rejected",
    }),
    onInstalled: () => assert.fail("disabled adoption"),
  });
  controller.begin(setup.binding.ctx);
  await controller.refresh(setup.binding.ctx);
  await controller.refresh(setup.binding.ctx);
  // model_select and session_tree restart the generation for the same session.
  controller.begin(setup.binding.ctx);
  await controller.refresh(setup.binding.ctx);
  assert.deepEqual(setup.diagnostics, ["fixture settings rejected"]);
  controller.stop();
});

test("an incompatible checkpoint warns once per session and again for a newly bound session", async () => {
  const setup = await committedFixture();
  const controller = createCodexBackgroundIntegration({
    state: setup.state,
    resolveSettings: async () => ({ enabled: true, blockImages: false }),
    onInstalled: () => {},
  });
  await setup.credentials.modify(model.provider, async () => ({
    type: "oauth",
    access: tokenFor("changed-account"),
    refresh: "synthetic-unused-refresh",
    expires: Date.now() + 3600000,
  }));
  const warnings = () => setup.diagnostics.filter((message) => /incompatible/.test(message));
  controller.begin(setup.binding.ctx);
  assert.equal(await controller.refresh(setup.binding.ctx), undefined);
  assert.equal(controller.fence(setup.manager.getSessionId()).engaged, true);
  assert.equal(await controller.refresh(setup.binding.ctx), undefined);
  assert.equal(controller.fence(setup.manager.getSessionId()).engaged, true);
  // model_select and session_tree restart the generation for the same session.
  controller.begin(setup.binding.ctx);
  assert.equal(await controller.refresh(setup.binding.ctx), undefined);
  assert.equal(controller.fence(setup.manager.getSessionId()).engaged, true);
  assert.equal(warnings().length, 1);
  assert.match(warnings()[0] ?? "", /incompatible.*account/);
  const previousSession = setup.manager.getSessionId();
  const leafId = setup.manager.getLeafId();
  assert.ok(leafId);
  setup.manager.createBranchedSession(leafId);
  assert.notEqual(setup.manager.getSessionId(), previousSession);
  cleanupSessions.add(setup.manager.getSessionId());
  controller.begin(setup.binding.ctx);
  assert.equal(await controller.refresh(setup.binding.ctx), undefined);
  assert.equal(controller.fence(setup.manager.getSessionId()).engaged, true);
  assert.equal(warnings().length, 2);
  controller.stop();
});
