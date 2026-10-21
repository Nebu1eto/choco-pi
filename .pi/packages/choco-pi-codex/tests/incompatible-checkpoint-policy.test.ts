import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import {
  createEventBus,
  DEFAULT_COMPACTION_SETTINGS,
  DefaultResourceLoader,
  ExtensionRunner,
  SessionManager,
  type ExtensionError,
  type ExtensionFactory,
  type ModelSelectEvent,
  type SessionBeforeCompactEvent,
  type SessionShutdownEvent,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  assertCodexRequestAllowed,
  recordCodexRequestDecision,
} from "../src/extension/background-compaction.ts";
import { registerCodexEvents } from "../src/extension/events.ts";
import { createCodexExtensionRuntime } from "../src/extension/runtime.ts";
import { createSdkFixture } from "./sdk-fixture.ts";
import { createOpenAICodexProviderStream } from "../src/providers/openai-codex-custom-provider.ts";
import { cleanupOpenAICodexTransportSession } from "../src/providers/openai-codex/transport-cleanup.ts";
import {
  LaneRecordSchema,
  type LaneRecord,
} from "../../choco-pi-compaction/src/background/lane-journal.ts";
import {
  OPAQUE_GUARD_NOTICE,
  publishOpaqueConsent,
} from "../../choco-pi-compaction/src/opaque-checkpoint.ts";
import { pendingOpaqueBlock } from "../../choco-pi-compaction/src/opaque-block.ts";

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

function tokenFor(id: string): string {
  return `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.fixture`;
}

function completed(): Response {
  const event = {
    type: "response.completed",
    response: {
      id: "fixture-response",
      status: "completed",
      output: [],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
      },
    },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function send(sessionId: string, fetch: typeof globalThis.fetch) {
  return createOpenAICodexProviderStream(
    model,
    normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }),
    { apiKey: tokenFor("fixture-account"), sessionId, transport: "sse", fetch, maxRetries: 0 },
    // The registration's prepared-payload hook, as register.ts installs it.
    { useResponsesLite: () => false, onPreparedPayload: assertCodexRequestAllowed },
  ).result();
}

test("a refused request fails before any transport call; the next request decides afresh", async () => {
  const sessionId = `refusal-${Date.now()}`;
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    return completed();
  };
  try {
    recordCodexRequestDecision(sessionId, "compaction cancelled: fixture exits text");
    const refused = await send(sessionId, fetch);
    assert.equal(refused.stopReason, "error");
    assert.equal(refused.errorMessage, "compaction cancelled: fixture exits text");
    assert.equal(calls, 0, "no transport call for a refused request");

    // The refusal was consumed; an allowed decision sends normally.
    recordCodexRequestDecision(sessionId, undefined);
    const allowed = await send(sessionId, fetch);
    assert.equal(allowed.stopReason, "stop");
    assert.equal(calls, 1);
  } finally {
    recordCodexRequestDecision(sessionId, undefined);
    cleanupOpenAICodexTransportSession(sessionId);
  }
});

test("a refusal for one session never blocks another session's request", async () => {
  const refusedSession = `refused-${Date.now()}`;
  const otherSession = `other-${Date.now()}`;
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    return completed();
  };
  try {
    recordCodexRequestDecision(refusedSession, "refused");
    const other = await send(otherSession, fetch);
    assert.equal(other.stopReason, "stop");
    assert.equal(calls, 1);
  } finally {
    recordCodexRequestDecision(refusedSession, undefined);
    cleanupOpenAICodexTransportSession(refusedSession);
    cleanupOpenAICodexTransportSession(otherSession);
  }
});

// ---------------------------------------------------------------------------
// Opaque Codex checkpoint without native compaction or a sidecar (R3)
// ---------------------------------------------------------------------------

/** The SDK's generic event dispatch, typed by the runner itself per event. */
type Emit = ExtensionRunner["emit"];

const SESSION_START_EVENT: SessionStartEvent = { type: "session_start", reason: "resume" };
const SHUTDOWN_EVENT: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" };
const manualCompactEvent = (): SessionBeforeCompactEvent => ({
  type: "session_before_compact",
  preparation: {
    firstKeptEntryId: "kept",
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 0,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: DEFAULT_COMPACTION_SETTINGS,
  },
  branchEntries: [],
  reason: "manual",
  willRetry: false,
  signal: new AbortController().signal,
});
const modelSelectEvent = (selected: Model<Api>): ModelSelectEvent => ({
  type: "model_select",
  model: selected,
  previousModel: undefined,
  source: "set",
});

const OTHER_PROVIDER_MODEL: Model<"openai-completions"> = {
  id: "corp-large",
  name: "Corp",
  api: "openai-completions",
  provider: "corp",
  baseUrl: "https://corp.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 2048,
};

/**
 * A headless host runner whose notices the rig still observes: the SDK reports a UI only for a
 * non-default UI context, and the rig binds one solely to capture `notify`.
 */
class HeadlessRunner extends ExtensionRunner {
  override hasUI(): boolean {
    return false;
  }
}

/**
 * The Codex extension's real event handlers over a resumed session whose
 * newest checkpoint is an opaque Codex record, with `responsesCompaction`
 * off in an isolated agent dir and no background sidecar anywhere.
 */
async function opaqueSession(run: (rig: Awaited<ReturnType<typeof opaqueRig>>) => Promise<void>) {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-opaque-guard-"));
  await writeFile(
    join(agentDir, "choco-pi-codex.json"),
    JSON.stringify({ compaction: { responsesCompaction: false } }),
  );
  const previous = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  const rig = await opaqueRig();
  try {
    await run(rig);
  } finally {
    recordCodexRequestDecision(rig.sessionId, undefined);
    cleanupOpenAICodexTransportSession(rig.sessionId);
    await rig.emit(SHUTDOWN_EVENT);
    rig.dispose();
    if (previous === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
    else process.env["PI_CODING_AGENT_DIR"] = previous;
    await rm(agentDir, { recursive: true, force: true });
  }
}

async function opaqueRig() {
  const manager = SessionManager.inMemory();
  const kept = manager.appendMessage({ role: "user", content: "earlier work", timestamp: 1 });
  const entryId = manager.appendCompaction("placeholder", kept, 1000, {
    strategy: "openai-responses-compaction-v2",
    schemaVersion: 1,
  });
  manager.appendMessage({ role: "user", content: "after the checkpoint", timestamp: 2 });
  const sessionId = manager.getSessionId();
  const records: LaneRecord[] = [];
  const notices: string[] = [];
  const sdk = await createSdkFixture();
  const cwd = process.cwd();
  // The SDK loader builds the real `ExtensionAPI`; the production handlers register through it.
  const factory: ExtensionFactory = (pi) => {
    const runtime = createCodexExtensionRuntime(pi);
    runtime.configureDiagnostics = () => Promise.resolve();
    runtime.startPrewarm = () => undefined;
    runtime.execEnv = () => ({});
    registerCodexEvents(
      pi,
      runtime,
      { applyConfig() {}, ensureOptionalTools() {} },
      {
        invalidateUsageStatus() {},
        applyConfig() {},
        refreshUsageStatus: () => Promise.resolve(),
      },
      {
        prepare: () => Promise.resolve(),
        refreshPromptTools: (prompt: string) => prompt,
        checkpointNotebook: () => Promise.resolve(),
        shutdownHost: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
      { applyConfig() {}, shutdown() {} },
    );
  };
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    eventBus: createEventBus(),
    extensionFactories: [{ name: "codex-opaque-guard", factory }],
    noExtensions: true,
    disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((entry) => entry.path === "<inline:codex-opaque-guard>");
  assert.ok(extension);
  const extensionRuntime = loaded.runtime;
  const runner = new HeadlessRunner(
    [extension],
    extensionRuntime,
    cwd,
    manager,
    sdk.ctx.modelRegistry,
  );
  let currentModel: Model<Api> = model;
  // The fixture session's bound actions, with only entry appends redirected to the rig.
  runner.bindCore(
    {
      ...sdk.pi,
      // `ExtensionAPI` exposes no tool refresh; the rig registers no tools.
      refreshTools() {},
      appendEntry: (name, data) => {
        if (Value.Check(LaneRecordSchema, data)) records.push(data);
        manager.appendCustomEntry(name, data);
      },
    },
    {
      getModel: () => currentModel,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => false,
      getSignal: () => undefined,
      abort() {},
      hasPendingMessages: () => false,
      shutdown() {},
      getContextUsage: () => undefined,
      compact() {},
      getSystemPrompt: () => "system",
    },
  );
  runner.setUIContext({
    ...runner.getUIContext(),
    notify: (message: string) => {
      notices.push(message);
    },
  });
  // The runner contains handler failures; the rig fails the test on any of them instead.
  const failures: ExtensionError[] = [];
  runner.onError((error) => {
    failures.push(error);
  });
  const settle = () => {
    const failure = failures.shift();
    if (failure) throw new Error(`${failure.event} handler failed: ${failure.error}`);
  };
  /** Dispatch one event through the SDK runner, as the host does. */
  const emit: Emit = async (event) => {
    const result = await runner.emit(event);
    settle();
    return result;
  };
  let fetchCalls = 0;
  /** One prompt's provider call: the host runs `before_provider_request` as the payload hook. */
  const prompt = () =>
    createOpenAICodexProviderStream(
      model,
      normalizeContext({ messages: [{ role: "user", content: "next", timestamp: 3 }] }),
      {
        apiKey: tokenFor("fixture-account"),
        sessionId,
        transport: "sse",
        maxRetries: 0,
        fetch: async () => {
          fetchCalls++;
          return completed();
        },
        onPayload: async (payload) => {
          const next = await runner.emitBeforeProviderRequest(payload);
          settle();
          return next;
        },
      },
      { useResponsesLite: () => false, onPreparedPayload: assertCodexRequestAllowed },
    ).result();
  return {
    dispose: () => {
      extensionRuntime.invalidate();
      sdk.session.dispose();
    },
    manager,
    setModel: (selected: Model<Api>) => {
      currentModel = selected;
    },
    sessionId,
    entryId,
    records,
    notices,
    emit,
    prompt,
    fetchCalls: () => fetchCalls,
  };
}

const CancelSchema = Type.Object({ cancel: Type.Literal(true) });

test("opaque Codex checkpoint, responsesCompaction off, no sidecar: the prompt is refused before any fetch", async () => {
  await opaqueSession(async (rig) => {
    await rig.emit(SESSION_START_EVENT);
    const exits = OPAQUE_GUARD_NOTICE("codex", rig.entryId);
    const refused = await rig.prompt();
    assert.equal(refused.stopReason, "error");
    assert.equal(refused.errorMessage, exits);
    assert.equal(rig.fetchCalls(), 0, "nothing reached the transport");
    assert.deepEqual(rig.notices, [exits], "one notice");
    const refusals = rig.records.filter((record) => record.event === "refuse");
    assert.equal(refusals.length, 1, "one refuse record");
    assert.equal(refusals[0]?.reason, "opaque-checkpoint");
    assert.equal(refusals[0]?.checkpointEntryId, rig.entryId);
    assert.equal(refusals[0]?.provider, "codex");
    // A host compaction over the checkpoint is cancelled with the same exits text.
    const cancelled = await rig.emit(manualCompactEvent());
    assert.ok(Value.Check(CancelSchema, cancelled));
    assert.equal(rig.records.filter((record) => record.event === "cancel").length, 1);

    // Loss authorized for this checkpoint: the prompt is sent and the loss journaled once.
    const unpublish = publishOpaqueConsent(
      (id, entry) => id === rig.sessionId && entry === rig.entryId,
    );
    try {
      const sent = await rig.prompt();
      assert.equal(sent.stopReason, "stop");
      assert.equal(rig.fetchCalls(), 1);
      const losses = rig.records.filter((record) => record.event === "loss");
      assert.equal(losses.length, 1);
      assert.equal(losses[0]?.checkpointEntryId, rig.entryId);
      assert.equal(await rig.emit(manualCompactEvent()), undefined);
    } finally {
      unpublish();
    }
  });
});

test("opaque Codex checkpoint on another provider's model: a pending block guards its first request", async () => {
  await opaqueSession(async (rig) => {
    rig.setModel(OTHER_PROVIDER_MODEL);
    await rig.emit(SESSION_START_EVENT);
    assert.deepEqual(pendingOpaqueBlock(rig.sessionId), {
      entryId: rig.entryId,
      owner: "codex-native",
    });
    // That provider's guard announces it; Codex shows and records nothing for it.
    assert.deepEqual(rig.notices, []);
    assert.equal(rig.records.filter((record) => record.event === "refuse").length, 0);
    const unpublish = publishOpaqueConsent(
      (id, entry) => id === rig.sessionId && entry === rig.entryId,
    );
    try {
      assert.equal(pendingOpaqueBlock(rig.sessionId), undefined, "loss authorized");
    } finally {
      unpublish();
    }
    // Back on the Codex transport the block is withdrawn: the Codex transport refuses itself.
    rig.setModel(model);
    await rig.emit(modelSelectEvent(model));
    assert.equal(pendingOpaqueBlock(rig.sessionId), undefined);
    rig.setModel(OTHER_PROVIDER_MODEL);
    await rig.emit(modelSelectEvent(OTHER_PROVIDER_MODEL));
    assert.ok(pendingOpaqueBlock(rig.sessionId));
    await rig.emit(SHUTDOWN_EVENT);
    assert.equal(pendingOpaqueBlock(rig.sessionId), undefined, "shutdown withdraws the block");
  });
});
