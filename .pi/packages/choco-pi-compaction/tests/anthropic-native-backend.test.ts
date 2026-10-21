/**
 * Anthropic native backend: capability gating, preparation, versioned details and the full
 * capture -> lane -> draft -> replay loop through a real `createAgentSession`
 * (INSTALLED Anthropic adapter, fake transports, no network): once with the
 * backend driven directly, once through the registered extension's owner and
 * coordinator (preparation, adoption with the owner's draft vetting, replay).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type AssistantMessage,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type JsonObject,
  type Message,
  type Model,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type CompactionEntry,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type ExtensionAPI,
  ModelRuntime,
  type ProjectedSessionEntry,
  type SessionEntry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type {
  FrozenSnapshot,
  PreparationBudget,
  PreparedCheckpoint,
  PrepareFailure,
  ProviderScope,
} from "../src/background/contract.ts";
import { isCandidateRecord } from "../src/background/contract.ts";
import {
  ANTHROPIC_BACKEND_ID,
  type AnthropicBackendDeps,
  chooseLegalCutEntry,
  createAnthropicNativeBackend,
} from "../src/anthropic/backend.ts";
import {
  AnthropicCapabilityGate,
  type AnthropicSupportEntry,
  authModeOf,
} from "../src/anthropic/capability.ts";
import {
  bindSessionProjection,
  capturesFor,
  mapWireToEntries,
  parseBetaHeader,
  parseWireBody,
  registerAnthropicCapture,
  releaseSessionCaptures,
  transportRefusals,
  type WireBody,
  type WireCapture,
} from "../src/anthropic/capture.ts";
import {
  type AnthropicDetails,
  COMPACT_BETA,
  isAnthropicDetails,
  isCompactionBlock,
  sameBlock,
} from "../src/anthropic/details.ts";
import { createReplayRewriteHandler } from "../src/anthropic/replay-rewrite.ts";
import { getCoordinator } from "../src/background/registry.ts";
import { readAdoptionIdentity } from "../src/background-host/adoption-signal.ts";
import registerCompaction, {
  type BackgroundAdoptionNotice,
  getBackgroundAdoptionSignal,
  mainOwnerKey,
} from "../src/index.ts";
import { persistedCustomEntry } from "./background-fakes.ts";

const PROVIDER = "native-backend";
const BASE_URL = "https://native.invalid";
const API_KEY = "native-non-secret-placeholder-key";
const MODEL: Model<"anthropic-messages"> = {
  id: "claude-haiku-5-5",
  name: "Synthetic Haiku",
  api: "anthropic-messages",
  provider: PROVIDER,
  baseUrl: BASE_URL,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4_096,
};
const ALLOW: AnthropicSupportEntry = {
  provider: PROVIDER,
  model: MODEL.id,
  baseUrl: BASE_URL,
  authMode: "api-key",
};
const SCOPE: ProviderScope = {
  provider: PROVIDER,
  model: MODEL.id,
  baseUrl: BASE_URL,
  authMode: "api-key",
};
/** Synthetic signed block with an unknown field; the signature is a placeholder. */
const BLOCK = {
  type: "compaction",
  content: "NATIVE backend synthetic prefix facts",
  signature: "native-backend-synthetic-signature",
  tool_changes: { added: ["step"], note: null },
};

type Frame = JsonObject & { readonly type: string };

/** Every key path in insertion order, so added or reordered fields are visible. */
function keyPaths<T>(value: T, prefix = ""): string[] {
  if (!(value instanceof Object)) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    `${prefix}${key}`,
    ...keyPaths(child, `${prefix}${key}.`),
  ]);
}

function sse(frames: readonly Frame[]): Response {
  const body = frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  return new Response(body.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function messageStart(): Frame {
  return {
    type: "message_start",
    message: {
      id: "native",
      type: "message",
      role: "assistant",
      model: MODEL.id,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}

function compactionResponse(): Response {
  return sse([
    messageStart(),
    { type: "content_block_start", index: 0, content_block: BLOCK },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "compaction", stop_sequence: null },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        iterations: [{ type: "compaction", input_tokens: 115, output_tokens: 117 }],
      },
    },
    { type: "message_stop" },
  ]);
}

function textResponse(text: string): Response {
  return sse([
    messageStart(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

function toolResponse(id: string): Response {
  return sse([
    messageStart(),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name: "step", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ label: "one" }) },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

interface Sent {
  readonly headers: Headers;
  readonly text: string;
  readonly body: WireBody | undefined;
}

interface RecordingFetch {
  readonly sent: Sent[];
  readonly fetch: typeof globalThis.fetch;
}

function recordingFetch(respond: (index: number) => Response): RecordingFetch {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (_input, init) => {
      const text = String(init?.body ?? "");
      sent.push({ headers: new Headers(init?.headers), text, body: parseWireBody(text) });
      return respond(sent.length - 1);
    },
  };
}

function budget(overrides: Partial<PreparationBudget> = {}): PreparationBudget {
  return {
    maxInputTokens: 200_000,
    maxOutputTokens: 2_048,
    maxResultBytes: 1_048_576,
    deadlineMs: Date.now() + 10_000,
    maxAttempts: 2,
    ...overrides,
  };
}

function deps(
  lane: typeof globalThis.fetch,
  overrides: Partial<AnthropicBackendDeps> = {},
): AnthropicBackendDeps {
  return {
    gate: new AnthropicCapabilityGate({ enabled: true, cooldownMs: 60_000, allowList: [ALLOW] }),
    resolveModel: (scope) =>
      scope.provider === PROVIDER && scope.model === MODEL.id ? MODEL : undefined,
    resolveAuth: async () => ({ ok: true, apiKey: API_KEY }),
    findCapture: (snapshot) => capturesFor(snapshot.ownerKey).at(-1),
    fetch: lane,
    ...overrides,
  };
}

function isPrepared(
  result: PreparedCheckpoint<AnthropicDetails> | PrepareFailure,
): result is PreparedCheckpoint<AnthropicDetails> {
  return !("ok" in result);
}

// ---------------------------------------------------------------------------
// Synthetic capture (unit-level preparation tests)
// ---------------------------------------------------------------------------

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage,
    stopReason: "stop",
    timestamp: 0,
  };
}

const TRANSCRIPT: readonly Message[] = [
  { role: "user", content: "NATIVE-A", timestamp: 0 },
  assistantMessage("NATIVE-B"),
  { role: "user", content: "NATIVE-C", timestamp: 0 },
  assistantMessage("NATIVE-D"),
];

function entriesOf(messages: readonly Message[]): SessionEntry[] {
  return messages.map((message, index) => ({
    type: "message",
    id: `e${index + 1}`,
    parentId: index === 0 ? null : `e${index}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    message,
  }));
}

function syntheticCapture(entries: readonly SessionEntry[]): WireCapture {
  const body = parseWireBody(
    JSON.stringify({
      model: MODEL.id,
      max_tokens: 4096,
      stream: true,
      system: [{ type: "text", text: "NATIVE system" }],
      messages: [
        { role: "user", content: "NATIVE-A" },
        { role: "assistant", content: [{ type: "text", text: "NATIVE-B" }] },
        { role: "user", content: "NATIVE-C" },
        { role: "assistant", content: [{ type: "text", text: "NATIVE-D" }] },
      ],
    }),
  );
  assert.ok(body);
  const projection: ProjectedSessionEntry[] = entries.map((entry) => ({
    sourceEntry: entry,
    messages: entry.type === "message" ? [entry.message] : [],
  }));
  return {
    schemaVersion: 1,
    sessionId: "native-synthetic",
    sequence: 1,
    capturedAt: 0,
    provider: PROVIDER,
    modelId: MODEL.id,
    baseUrl: BASE_URL,
    endpoint: `${BASE_URL}/v1/messages`,
    betas: ["captured-beta"],
    status: 200,
    bodyText: JSON.stringify(body),
    body,
    mapping: mapWireToEntries(body.messages, projection),
  };
}

function snapshot(overrides: Partial<FrozenSnapshot> = {}): FrozenSnapshot {
  const entries = entriesOf(TRANSCRIPT);
  return {
    cutEntryId: "e2",
    prefixFingerprint: "native-fingerprint",
    priorCheckpointId: null,
    priorCheckpointVersion: null,
    ownerKey: "native-synthetic",
    ownerGeneration: 1,
    providerScope: SCOPE,
    entries,
    splitTurn: false,
    governingUserRequest: null,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    tokenEstimate: 100,
    capturedAt: 0,
    backendCapture: syntheticCapture(entries),
    ...overrides,
  };
}

test("prepare: frozen prefix only, exact block, validated string firstKeptEntryId", async () => {
  const lane = recordingFetch(() => compactionResponse());
  const backend = createAnthropicNativeBackend(deps(lane.fetch));
  assert.equal(backend.id, ANTHROPIC_BACKEND_ID);
  const frozen = snapshot();
  assert.deepEqual(backend.isLegalCut(frozen), { legal: true });
  const result = await backend.prepare(frozen, {
    signal: new AbortController().signal,
    budget: budget(),
    candidateId: "native-candidate",
  });
  assert.ok(isPrepared(result), JSON.stringify(result));
  assert.equal(lane.sent.length, 1);
  const request = lane.sent[0]?.body;
  assert.ok(request);
  assert.deepEqual(
    request.messages,
    [
      { role: "user", content: "NATIVE-A" },
      { role: "assistant", content: [{ type: "text", text: "NATIVE-B" }] },
    ],
    "no post-cut items",
  );
  assert.ok(
    parseBetaHeader(lane.sent[0]?.headers.get("anthropic-beta") ?? null).includes(COMPACT_BETA),
  );
  assert.equal(result.candidateId, "native-candidate");
  assert.equal(result.backendId, ANTHROPIC_BACKEND_ID);
  assert.equal(result.draft.firstKeptEntryId, "e3");
  assert.equal(result.draft.summary, BLOCK.content);
  assert.deepEqual(result.reasonCodes, ["prepared"]);
  assert.deepEqual(result.usage, {
    input: 115,
    output: 117,
    iterations: [{ input: 115, output: 117 }],
  });
  assert.ok(isAnthropicDetails(result.details));
  assert.equal(result.details, result.draft.details);
  assert.deepEqual(result.details.cut, { cutEntryId: "e2", firstKeptEntryId: "e3" });
  assert.equal(result.details.wire.prefixLength, 2);
  assert.equal(result.details.wire.capturedLength, 4);
  assert.deepEqual(result.details.betas, ["captured-beta", COMPACT_BETA]);
  assert.deepEqual(result.details.block, BLOCK, "exact, unknown fields kept");
  assert.deepEqual(keyPaths(result.details.block), keyPaths(BLOCK), "field order kept");
});

test("details persist exactly through JSON and the candidate record contract", async () => {
  const backend = createAnthropicNativeBackend(
    deps(recordingFetch(() => compactionResponse()).fetch),
  );
  const result = await backend.prepare(snapshot(), {
    signal: new AbortController().signal,
    budget: budget(),
    candidateId: "native-candidate",
  });
  assert.ok(isPrepared(result));
  const restored = (await persistedCustomEntry(result.details)).data;
  assert.ok(isAnthropicDetails(restored), "validator accepts the persisted form");
  assert.ok(Value.Equal(restored, result.details), "structural equality");
  assert.ok(sameBlock(restored.block, result.details.block), "exact content and signature");
  assert.deepEqual(keyPaths(restored.block), keyPaths(BLOCK), "no added or reordered fields");
  // Coordinator-added adoption keys are tolerated; malformed details are rejected.
  assert.ok(
    isAnthropicDetails({ ...restored, candidateId: "c", prefixFingerprint: "f", ownerKey: "o" }),
  );
  assert.equal(isAnthropicDetails({ ...restored, betas: ["other"] }), false, "beta required");
  assert.equal(
    isAnthropicDetails({ ...restored, block: { ...restored.block, signature: "" } }),
    false,
    "signature required",
  );
  assert.equal(isAnthropicDetails({ ...restored, schemaVersion: 2 }), false, "versioned");
  assert.equal(
    isAnthropicDetails({ ...restored, cut: { cutEntryId: "e2", firstKeptEntryId: "e2" } }),
    false,
    "kept entry differs from the cut",
  );
  // The shared candidate record accepts the draft unchanged.
  const record = {
    customType: "choco-compaction-candidate",
    schemaVersion: 1,
    candidateId: result.candidateId,
    backendId: result.backendId,
    identity: {
      cutEntryId: "e2",
      prefixFingerprint: "native-fingerprint",
      priorCheckpointId: null,
      priorCheckpointVersion: null,
      ownerKey: "native-synthetic",
      ownerGeneration: 1,
      providerScope: SCOPE,
    },
    createdAt: 0,
    checkpoint: result,
  };
  assert.ok(
    isCandidateRecord((await persistedCustomEntry(record)).data),
    "persistable as a version-1 candidate record",
  );
});

test("capability gating refuses unlisted combinations without any request", async () => {
  const refusals: {
    readonly name: string;
    readonly deps: Partial<AnthropicBackendDeps>;
    readonly scope: ProviderScope;
  }[] = [
    { name: "unlisted model", deps: {}, scope: { ...SCOPE, model: "claude-sonnet-5-5" } },
    { name: "unlisted auth mode", deps: {}, scope: { ...SCOPE, authMode: "oauth" } },
    {
      name: "missing auth mode",
      deps: {},
      scope: { provider: PROVIDER, model: MODEL.id, baseUrl: BASE_URL },
    },
    { name: "other base URL", deps: {}, scope: { ...SCOPE, baseUrl: "https://proxy.invalid" } },
    {
      name: "settings flag off",
      deps: {
        gate: new AnthropicCapabilityGate({ enabled: false, cooldownMs: 0, allowList: [ALLOW] }),
      },
      scope: SCOPE,
    },
    {
      name: "default policy (first-party OAuth only)",
      deps: { gate: new AnthropicCapabilityGate({ enabled: true, cooldownMs: 0 }) },
      scope: SCOPE,
    },
  ];
  for (const item of refusals) {
    const lane = recordingFetch(() => compactionResponse());
    const backend = createAnthropicNativeBackend(deps(lane.fetch, item.deps));
    assert.deepEqual(
      await backend.capability(item.scope),
      { supported: false, reason: "unsupported" },
      item.name,
    );
    const result = await backend.prepare(snapshot({ providerScope: item.scope }), {
      signal: new AbortController().signal,
      budget: budget(),
      candidateId: "native-candidate",
    });
    assert.deepEqual(result, { ok: false, reason: "unsupported", retryable: false }, item.name);
    assert.equal(lane.sent.length, 0, `${item.name}: no network`);
  }
  assert.equal(authModeOf("sk-ant-oat01-placeholder"), "oauth");
  assert.equal(authModeOf("sk-ant-api03-placeholder"), "api-key");
  assert.equal(authModeOf(undefined), undefined);
});

test("failures cool the combination down, boundedly, and no request is repeated", async () => {
  let clock = 1_000;
  const gate = new AnthropicCapabilityGate({
    enabled: true,
    cooldownMs: 1_000,
    maxCooldownMs: 3_000,
    allowList: [ALLOW],
    now: () => clock,
  });
  const lane = recordingFetch(
    () =>
      new Response(
        JSON.stringify({ type: "error", error: { type: "authentication_error", message: "no" } }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      ),
  );
  const backend = createAnthropicNativeBackend(deps(lane.fetch, { gate, now: () => clock }));
  const run = () =>
    backend.prepare(snapshot(), {
      signal: new AbortController().signal,
      budget: budget({ deadlineMs: clock + 10_000 }),
      candidateId: "native-candidate",
    });
  assert.deepEqual(await run(), { ok: false, reason: "auth", retryable: false });
  assert.equal(lane.sent.length, 1);
  assert.deepEqual(gate.check(SCOPE), { supported: false, reason: "auth" });
  assert.deepEqual(await run(), { ok: false, reason: "auth", retryable: false }, "gated");
  assert.equal(lane.sent.length, 1, "no second request while cooling down");
  clock += 1_000;
  assert.deepEqual(gate.check(SCOPE), { supported: true });
  // Hard failures back off exponentially but never beyond the cap.
  for (let index = 0; index < 6; index++) gate.recordFailure(SCOPE, "malformed");
  assert.equal(gate.cooldownRemaining(SCOPE), 3_000);
  gate.recordSuccess(SCOPE);
  assert.deepEqual(gate.check(SCOPE), { supported: true });
  // Transient failures honor retry-after and only cool down after a streak.
  gate.recordFailure(SCOPE, "529");
  gate.recordFailure(SCOPE, "529");
  assert.deepEqual(gate.check(SCOPE), { supported: true });
  gate.recordFailure(SCOPE, "429", 2_000);
  assert.deepEqual(gate.check(SCOPE), { supported: false, reason: "429" });
  assert.equal(gate.cooldownRemaining(SCOPE), 2_000);
  // Pre-request deferrals never count.
  gate.recordSuccess(SCOPE);
  gate.recordFailure(SCOPE, "no-legal-cut");
  gate.recordFailure(SCOPE, "canceled");
  assert.deepEqual(gate.check(SCOPE), { supported: true });
});

test("preparation refusals happen before any request", async () => {
  const cases: {
    readonly name: string;
    readonly snapshot: Partial<FrozenSnapshot>;
    readonly deps?: Partial<AnthropicBackendDeps>;
    readonly budget?: Partial<PreparationBudget>;
    readonly signal?: AbortSignal;
    readonly expected: PrepareFailure;
  }[] = [
    {
      name: "no retained entry yet: defer, never null",
      snapshot: { cutEntryId: "e4", entries: entriesOf(TRANSCRIPT) },
      expected: { ok: false, reason: "no-legal-cut", retryable: true, detail: "no-retained-entry" },
    },
    {
      name: "illegal wire cut",
      snapshot: { cutEntryId: "e1" },
      expected: {
        ok: false,
        reason: "no-legal-cut",
        retryable: false,
        detail: "first-kept-not-user",
      },
    },
    {
      name: "opaque capture of the wrong kind",
      snapshot: { backendCapture: { not: "a capture" } },
      expected: { ok: false, reason: "incompatible", retryable: false, detail: "no-capture" },
    },
    {
      name: "input over budget",
      snapshot: {},
      budget: { maxInputTokens: 1 },
      expected: { ok: false, reason: "oversized", retryable: false },
    },
    {
      name: "deadline already passed",
      snapshot: {},
      budget: { deadlineMs: 0 },
      expected: { ok: false, reason: "timeout", retryable: true },
    },
    {
      name: "resolved credential is a different auth mode",
      snapshot: {},
      deps: { resolveAuth: async () => ({ ok: true, apiKey: "sk-ant-oat01-placeholder" }) },
      expected: { ok: false, reason: "unsupported", retryable: false },
    },
    {
      name: "credential resolution failed",
      snapshot: {},
      deps: { resolveAuth: async () => ({ ok: false, error: "no credential" }) },
      expected: { ok: false, reason: "auth", retryable: false },
    },
    {
      name: "model not resolvable",
      snapshot: {},
      deps: { resolveModel: () => undefined },
      expected: { ok: false, reason: "unsupported", retryable: false },
    },
    {
      name: "pre-aborted",
      snapshot: {},
      signal: AbortSignal.abort(),
      expected: { ok: false, reason: "canceled", retryable: false },
    },
  ];
  for (const item of cases) {
    const lane = recordingFetch(() => compactionResponse());
    const backend = createAnthropicNativeBackend(deps(lane.fetch, item.deps));
    const result = await backend.prepare(snapshot(item.snapshot), {
      signal: item.signal ?? new AbortController().signal,
      budget: budget(item.budget),
      candidateId: "native-candidate",
    });
    assert.deepEqual(result, item.expected, item.name);
    assert.equal(lane.sent.length, 0, `${item.name}: no network`);
  }
});

// ---------------------------------------------------------------------------
// Full loop through a real host session
// ---------------------------------------------------------------------------

const STEP_TOOL = defineTool({
  name: "step",
  label: "step",
  description: "deterministic step",
  parameters: Type.Object({ label: Type.String() }),
  async execute(_id, params) {
    return { content: [{ type: "text", text: `result-${params.label}` }], details: {} };
  },
});

test(
  "capture -> legal cut -> lane -> committed draft -> replay verified at the transport",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "choco-pi-native-backend-"));
    const foreground = recordingFetch((index) =>
      index === 0 ? toolResponse("toolu_native_loop") : textResponse("NATIVE-FINAL"),
    );
    const lane = recordingFetch(() => compactionResponse());
    const backend = createAnthropicNativeBackend(deps(lane.fetch));
    const prepared: PreparedCheckpoint<AnthropicDetails>[] = [];
    const chosenCuts: string[] = [];
    let sessionId = "";
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
      refreshOnCreate: false,
      modelsPath: null,
    });
    runtime.registerProvider(PROVIDER, {
      api: "anthropic-messages",
      apiKey: API_KEY,
      models: [MODEL],
      streamSimple: () => {
        throw new Error("unwrapped provider stream used");
      },
    });
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 16_384 },
      retry: { enabled: false },
    });
    const extension = (pi: ExtensionAPI): void => {
      pi.registerTool(STEP_TOOL);
      registerAnthropicCapture(pi, PROVIDER, { fetch: foreground.fetch });
      pi.on("session_start", (_event, ctx) => {
        const manager = ctx.sessionManager;
        bindSessionProjection(
          manager.getSessionId(),
          () => manager.buildSessionProjection().entries,
        );
      });
      pi.on("turn_end", async (event, ctx) => {
        if (prepared.length > 0) return undefined;
        const branch = structuredClone(ctx.sessionManager.getBranch());
        const capture = capturesFor(ctx.sessionManager.getSessionId()).at(-1);
        assert.ok(capture, "the first request was captured");
        const go = branch.findIndex(
          (entry) =>
            entry.type === "message" && JSON.stringify(entry.message).includes("NATIVE-GO"),
        );
        const preferred = branch[go - 1]?.id;
        assert.ok(preferred);
        const cut = chooseLegalCutEntry(capture, preferred);
        assert.notEqual(cut, "defer");
        chosenCuts.push(preferred, cut);
        const frozen: FrozenSnapshot = {
          cutEntryId: cut,
          prefixFingerprint: "native-loop-fingerprint",
          priorCheckpointId: null,
          priorCheckpointVersion: null,
          ownerKey: ctx.sessionManager.getSessionId(),
          ownerGeneration: 1,
          providerScope: SCOPE,
          entries: branch,
          splitTurn: false,
          governingUserRequest: null,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
          tokenEstimate: 100,
          capturedAt: Date.now(),
        };
        assert.deepEqual(backend.isLegalCut(frozen), { legal: true });
        const result = await backend.prepare(frozen, {
          signal: new AbortController().signal,
          budget: budget(),
          candidateId: "native-loop-candidate",
        });
        assert.ok(isPrepared(result), JSON.stringify(result));
        prepared.push(result);
        return { entries: [...event.entries, result.draft] };
      });
      pi.on("before_provider_request", createReplayRewriteHandler());
    };
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [extension],
    });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    const a = manager.appendMessage({ role: "user", content: "NATIVE-PREFIX-A", timestamp: 0 });
    const b = manager.appendMessage(assistantMessage("NATIVE-PREFIX-B"));
    const c = manager.appendMessage({ role: "user", content: "NATIVE-KEPT-C", timestamp: 0 });
    let session: AgentSession | undefined;
    try {
      ({ session } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        model: MODEL,
        modelRuntime: runtime,
        resourceLoader: loader,
        sessionManager: manager,
        settingsManager: settings,
        noTools: "builtin",
      }));
      await session.bindExtensions({});
      sessionId = manager.getSessionId();
      await session.prompt("NATIVE-GO");

      // The preferred cut (just before GO) keeps C|GO adjacent users: legality moves it back to B.
      assert.equal(chosenCuts.length, 2);
      assert.notEqual(chosenCuts[0], b);
      assert.equal(chosenCuts[1], b);
      const [checkpoint] = prepared;
      assert.ok(checkpoint);
      assert.equal(checkpoint.draft.firstKeptEntryId, c);
      // The lane carried exactly the frozen wire prefix [A, B] and nothing after it.
      assert.equal(lane.sent.length, 1);
      const laneBody = lane.sent[0]?.body;
      assert.ok(laneBody);
      assert.equal(laneBody.messages.length, 2);
      assert.ok(lane.sent[0]?.text.includes("NATIVE-PREFIX-B"));
      assert.equal(lane.sent[0]?.text.includes("NATIVE-KEPT-C"), false);
      assert.equal(lane.sent[0]?.text.includes("NATIVE-GO"), false);
      // The draft committed as a real compaction entry with exact details.
      const committed = manager
        .getBranch()
        .filter((entry): entry is CompactionEntry => entry.type === "compaction");
      assert.equal(committed.length, 1);
      assert.equal(committed[0]?.firstKeptEntryId, c);
      assert.ok(Value.Equal(committed[0]?.details, checkpoint.details));
      const committedBlock = isAnthropicDetails(committed[0]?.details)
        ? committed[0].details.block
        : undefined;
      assert.ok(
        isCompactionBlock(committedBlock) && sameBlock(committedBlock, checkpoint.details.block),
      );
      // Request 2 replayed the block first, the kept tail after it, prefix gone.
      assert.equal(foreground.sent.length, 2, "no abort, no extra request");
      const replay = foreground.sent[1];
      assert.ok(replay?.body);
      assert.deepEqual(replay.body.messages[0], { role: "assistant", content: [BLOCK] });
      assert.equal(replay.text.includes("NATIVE-PREFIX-A"), false);
      assert.equal(replay.text.includes("NATIVE-PREFIX-B"), false);
      for (const text of ["NATIVE-KEPT-C", "NATIVE-GO", "toolu_native_loop"]) {
        assert.ok(replay.text.includes(text), text);
      }
      assert.ok(parseBetaHeader(replay.headers.get("anthropic-beta")).includes(COMPACT_BETA));
      assert.deepEqual(transportRefusals(sessionId), []);
      assert.equal(session.messages.at(-1)?.role, "assistant");
      assert.ok(JSON.stringify(session.messages.at(-1)).includes("NATIVE-FINAL"));
      assert.notEqual(a, b);
    } finally {
      session?.dispose();
      if (sessionId !== "") releaseSessionCaptures(sessionId);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// The same loop through the registered extension's owner and coordinator
// ---------------------------------------------------------------------------

const OWNER_MODEL: Model<"anthropic-messages"> = {
  ...MODEL,
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
};
const OWNER_OAUTH_KEY = "sk-ant-oat01-native-owner-non-secret-placeholder";

/** The owner loop's lane: its n-th answer is a distinct block, so the adopted one is identifiable. */
function ownerBlock(index: number) {
  return {
    type: "compaction",
    content: `NATIVE owner-loop summary ${index}`,
    signature: `native-owner-loop-signature-${index}`,
  };
}

function ownerBlockResponse(index: number): Response {
  return sse([
    messageStart(),
    { type: "content_block_start", index: 0, content_block: ownerBlock(index) },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "compaction", stop_sequence: null },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        iterations: [{ type: "compaction", input_tokens: 90, output_tokens: 30 }],
      },
    },
    { type: "message_stop" },
  ]);
}

const OwnerTextSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const OwnerBlockSchema = Type.Object({ type: Type.Literal("compaction"), content: Type.String() });

/** The test's own reading of a wire request: `<role>:<text>` per message. */
function ownerTurns(body: WireBody | undefined): string[] {
  return (body?.messages ?? []).map((message) => {
    const content: unknown = message.content;
    if (Value.Check(Type.String(), content)) return `${message.role}:${content}`;
    const blocks = Value.Check(Type.Array(Type.Unknown()), content) ? content : [];
    const parts = blocks.map((block) => {
      if (Value.Check(OwnerTextSchema, block)) return block.text;
      if (Value.Check(OwnerBlockSchema, block)) return `[compaction:${block.content}]`;
      return "[other]";
    });
    return `${message.role}:${parts.join("|")}`;
  });
}

/**
 * The lane prefix: the last captured request (three prompts, two answers), the
 * system prompt carried separately.
 */
const OWNER_LANE_TURNS = [
  "user:NATIVE-OWNER-0",
  "assistant:NATIVE-OWNER-ACK-0",
  "user:NATIVE-OWNER-1",
  "assistant:NATIVE-OWNER-ACK-1",
  "user:NATIVE-OWNER-2",
];

async function waitUntil(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test(
  "owner and coordinator: capture -> prepared candidate -> vetted adoption at the idle boundary -> replay",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "choco-pi-native-owner-"));
    const sidecar = join(dir, "background-compaction.json");
    // Native lane only; the usage threshold is never crossed, so only the explicit request prepares.
    await writeFile(
      sidecar,
      JSON.stringify({
        enabled: true,
        text: false,
        anthropicNative: true,
        prepareAt: 0.99,
        hysteresis: 0,
        reserveTokens: 0,
        retryBaseMs: 0,
        cooldownMs: 0,
        timeoutMs: 20_000,
        maxOutputTokens: 1_000,
      }),
    );
    const foreground = recordingFetch((index) => textResponse(`NATIVE-OWNER-ACK-${index}`));
    const lane = recordingFetch((index) => ownerBlockResponse(index));
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
      refreshOnCreate: false,
      modelsPath: null,
    });
    runtime.registerProvider("anthropic", {
      api: "anthropic-messages",
      apiKey: OWNER_OAUTH_KEY,
      models: [OWNER_MODEL],
      streamSimple: () => {
        throw new Error("unwrapped provider stream used");
      },
    });
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 16_384 },
      retry: { enabled: false },
    });
    const notices: string[] = [];
    const extension = (pi: ExtensionAPI): void => {
      pi.on("session_start", (_event, ctx) => {
        ctx.ui.notify = (message) => {
          notices.push(message);
        };
      });
      registerCompaction(pi, {
        retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
        compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 16_384 }),
        background: {
          settingsPaths: () => [sidecar],
          anthropic: {
            readMode: async () => "server-side",
            fetch: lane.fetch,
            capture: { fetch: foreground.fetch },
          },
        },
      });
    };
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [extension],
    });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    const adoptions: BackgroundAdoptionNotice[] = [];
    const unsubscribe = getBackgroundAdoptionSignal().subscribe((notice) => {
      if (notice.sessionId === manager.getSessionId()) adoptions.push(notice);
    });
    let session: AgentSession | undefined;
    try {
      ({ session } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        model: OWNER_MODEL,
        modelRuntime: runtime,
        resourceLoader: loader,
        sessionManager: manager,
        settingsManager: settings,
        noTools: "builtin",
      }));
      await session.bindExtensions({});
      for (const turn of ["NATIVE-OWNER-0", "NATIVE-OWNER-1", "NATIVE-OWNER-2"]) {
        await session.prompt(turn);
      }
      const ownerKey = mainOwnerKey(manager.getSessionId());
      const coordinator = getCoordinator(ownerKey);
      assert.ok(coordinator, "the main owner has a coordinator");
      const request = await coordinator.requestPreparation({
        trigger: "manual",
        backendId: "anthropic-native",
      });
      assert.ok(request.accepted, JSON.stringify(request));
      await waitUntil("a ready native candidate", () => coordinator.status().state === "ready");
      assert.equal(lane.sent.length, 1, "one paid lane request");
      // Prefix fidelity: the lane received the turns before the legal cut, as written here.
      assert.deepEqual(ownerTurns(lane.sent[0]?.body), OWNER_LANE_TURNS);
      assert.ok(
        parseBetaHeader(lane.sent[0]?.headers.get("anthropic-beta") ?? null).includes(COMPACT_BETA),
      );
      const [record, ...moreRecords] = persistedCandidates(manager);
      assert.ok(record, "the ready candidate was persisted before adoption");
      assert.equal(moreRecords.length, 0);
      assert.equal(record.backendId, "anthropic-native");
      assert.ok(isAnthropicDetails(record.checkpoint.draft.details));
      assert.deepEqual(record.checkpoint.draft.details.block, ownerBlock(0));

      // The next prompt's input hook adopts the ready candidate before its first request.
      const before = foreground.sent.length;
      await session.prompt("NATIVE-OWNER-NEXT");
      const committed = manager
        .getBranch()
        .filter((entry): entry is CompactionEntry => entry.type === "compaction");
      assert.equal(committed.length, 1, JSON.stringify(notices));
      const [entry] = committed;
      assert.ok(entry && isAnthropicDetails(entry.details), "the native draft was committed");
      assert.deepEqual(entry.details.block, ownerBlock(0));
      // The owner vetted this draft: its identity names this owner, and its kept entry is live.
      const identity = readAdoptionIdentity(entry);
      assert.equal(identity?.ownerKey, ownerKey);
      assert.ok(manager.getBranch().some((item) => item.id === entry.firstKeptEntryId));
      assert.equal(entry.firstKeptEntryId, record.checkpoint.draft.firstKeptEntryId);
      assert.deepEqual(
        adoptions.map((notice) => [notice.backendId, notice.committedEntryId]),
        [["anthropic-native", entry.id]],
      );
      assert.equal(coordinator.status().state, "installed");
      // That prompt's request already replays the adopted block first, prefix gone.
      assert.equal(foreground.sent.length, before + 1, "no extra or aborted request");
      const replay = foreground.sent.at(-1);
      assert.deepEqual(replay?.body?.messages[0], { role: "assistant", content: [ownerBlock(0)] });
      assert.ok(
        parseBetaHeader(replay?.headers.get("anthropic-beta") ?? null).includes(COMPACT_BETA),
      );
      assert.equal(replay?.text.includes("NATIVE-OWNER-0"), false, "the compacted prefix is gone");
      assert.ok(replay?.text.includes("NATIVE-OWNER-NEXT"));
      assert.deepEqual(transportRefusals(manager.getSessionId()), []);
    } finally {
      unsubscribe();
      session?.dispose();
      releaseSessionCaptures(manager.getSessionId());
      await rm(dir, { recursive: true, force: true });
    }
  },
);

/** The validated candidate records persisted on the session, in order. */
function persistedCandidates(manager: SessionManager) {
  return manager.getEntries().flatMap((entry) => {
    if (entry.type !== "custom") return [];
    const data: unknown = entry.data;
    return isCandidateRecord(data) ? [data] : [];
  });
}
