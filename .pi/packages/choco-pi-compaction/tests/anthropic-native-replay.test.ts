/**
 * Anthropic native replay rewrite verified at the transport.
 *
 * A real `createAgentSession` resumes a branch whose latest compaction entry
 * is an `anthropic-compaction-on-demand-v1` checkpoint. The rewrite runs as an
 * ordinary `before_provider_request` handler; the capturing provider (INSTALLED
 * adapter, fake base fetch) verifies the serialized body. Benign later handlers
 * keep the block first; hostile ones make the request fail closed before it is
 * transmitted.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";
import { streamSimple as installedStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import {
  bindSessionProjection,
  capturesFor,
  createCapturingStreamSimple,
  parseBetaHeader,
  parseWireBody,
  releaseSessionCaptures,
  transportRefusals,
  TRANSPORT_REFUSAL_PREFIX,
  type WireBody,
  WireBodySchema,
} from "../src/anthropic/capture.ts";
import {
  type AnthropicDetails,
  COMPACT_BETA,
  isAnthropicDetails,
  isCompactionBlock,
  sameBlock,
} from "../src/anthropic/details.ts";
import {
  createReplayRewriteHandler,
  type ReplayDiagnostic,
} from "../src/anthropic/replay-rewrite.ts";

const API_KEY = "native-non-secret-placeholder-key";
/** Synthetic signed block; the signature is a placeholder, not a credential. */
const BLOCK = {
  type: "compaction",
  content: "NATIVE replay synthetic prefix facts",
  signature: "native-replay-synthetic-signature",
  tool_changes: { added: ["step"] },
};

function nativeModel(managedEffort: boolean): Model<"anthropic-messages"> {
  const model: Model<"anthropic-messages"> = {
    id: "claude-haiku-5-5",
    name: "Synthetic Haiku",
    api: "anthropic-messages",
    provider: "native-replay",
    baseUrl: "https://native.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
  };
  if (managedEffort) model.compat = { supportsMidConvoEffort: true };
  return model;
}

function details(overrides: Partial<AnthropicDetails["wire"]> = {}): AnthropicDetails {
  const value = {
    strategy: "anthropic-compaction-on-demand-v1",
    schemaVersion: 1,
    block: structuredClone(BLOCK),
    scope: {
      provider: "native-replay",
      model: "claude-haiku-5-5",
      baseUrl: "https://native.invalid",
      authMode: "api-key",
    },
    betas: [COMPACT_BETA],
    cut: { cutEntryId: "placeholder-cut", firstKeptEntryId: "placeholder-kept" },
    wire: {
      prefixLength: 2,
      capturedLength: 4,
      keptThinking: false,
      systemDigest: "captured-system",
      toolsDigest: "captured-tools",
      unmappedPrefixKeys: 0,
      ...overrides,
    },
    laneUsage: { input: 105, output: 20 },
    stopReason: "compaction",
    preparedAt: 0,
  };
  assert.ok(isAnthropicDetails(value));
  return value;
}

type Frame = JsonObject & { readonly type: string };

function okResponse(): Response {
  const frames: Frame[] = [
    {
      type: "message_start",
      message: {
        id: "native",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

type Checkpoint = "anthropic" | "text" | "invalid-anthropic";

interface HostOptions {
  readonly before?: readonly ExtensionFactory[];
  readonly after?: readonly ExtensionFactory[];
  readonly checkpoint?: Checkpoint;
  readonly details?: AnthropicDetails;
  readonly managedEffort?: boolean;
  /** false: the provider is NOT wrapped by the capturing transport. */
  readonly wrapped?: boolean;
}

interface Host {
  readonly session: AgentSession;
  readonly sessionId: string;
  readonly compactionId: string;
  readonly sent: {
    readonly headers: Headers;
    readonly body: WireBody | undefined;
    readonly text: string;
  }[];
  readonly diagnostics: ReplayDiagnostic[];
  dispose(): Promise<void>;
}

async function createHost(options: HostOptions = {}): Promise<Host> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-native-replay-"));
  const model = nativeModel(options.managedEffort === true);
  const sent: Host["sent"][number][] = [];
  const baseFetch: typeof globalThis.fetch = async (_input, init) => {
    const text = String(init?.body ?? "");
    sent.push({ headers: new Headers(init?.headers), body: parseWireBody(text), text });
    return okResponse();
  };
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  runtime.registerProvider(model.provider, {
    api: "anthropic-messages",
    apiKey: API_KEY,
    models: [model],
    streamSimple:
      options.wrapped === false
        ? (requested, context, streamOptions) => {
            if (requested.api !== "anthropic-messages") throw new Error("unexpected api");
            return installedStreamSimple(model, context, { ...streamOptions, fetch: baseFetch });
          }
        : createCapturingStreamSimple({ fetch: baseFetch }),
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 16_384 },
    retry: { enabled: false },
  });
  const diagnostics: ReplayDiagnostic[] = [];
  const binder = (pi: ExtensionAPI): void => {
    pi.on("session_start", (_event, ctx) => {
      const manager = ctx.sessionManager;
      bindSessionProjection(manager.getSessionId(), () => manager.buildSessionProjection().entries);
    });
  };
  const rewrite = (pi: ExtensionAPI): void => {
    pi.on(
      "before_provider_request",
      createReplayRewriteHandler({ onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) }),
    );
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
    extensionFactories: [binder, ...(options.before ?? []), rewrite, ...(options.after ?? [])],
  });
  await loader.reload();
  const manager = SessionManager.inMemory(dir);
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = (text: string) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop" as const,
    timestamp: 0,
  });
  manager.appendMessage({ role: "user", content: "NATIVE-PREFIX-A", timestamp: 0 });
  manager.appendMessage(assistant("NATIVE-PREFIX-B"));
  const kept = manager.appendMessage({ role: "user", content: "NATIVE-KEPT-C", timestamp: 0 });
  manager.appendMessage(assistant("NATIVE-KEPT-D"));
  const checkpoint = options.checkpoint ?? "anthropic";
  const compactionDetails =
    checkpoint === "text"
      ? { strategy: "local-reconciled", schemaVersion: 1 }
      : checkpoint === "invalid-anthropic"
        ? { strategy: "anthropic-compaction-on-demand-v1", schemaVersion: 1 }
        : (options.details ?? details());
  const compactionId = manager.appendCompaction(BLOCK.content, kept, 100, compactionDetails);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager: settings,
    noTools: "builtin",
  });
  await session.bindExtensions({});
  const sessionId = manager.getSessionId();
  return {
    session,
    sessionId,
    compactionId,
    sent,
    diagnostics,
    async dispose() {
      session.dispose();
      releaseSessionCaptures(sessionId);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function lastAssistant(session: AgentSession) {
  const last = session.messages.at(-1);
  assert.ok(last?.role === "assistant");
  return last;
}

function handler(mutate: (payload: WireBody) => WireBody): ExtensionFactory {
  return (pi) => {
    pi.on("before_provider_request", (event) =>
      Value.Check(WireBodySchema, event.payload) ? mutate(event.payload) : undefined,
    );
  };
}

test(
  "replay places the exact block first and appends the beta, verified at the transport",
  { timeout: 20_000 },
  async () => {
    const benign = handler((payload) => ({ ...payload, metadata: { user_id: "native-later" } }));
    for (const after of [[], [benign]]) {
      const host = await createHost({ after });
      try {
        await host.session.prompt("NATIVE-NEXT");
        assert.equal(host.sent.length, 1, "transmitted once");
        const [request] = host.sent;
        assert.ok(request?.body);
        const [first, ...rest] = request.body.messages;
        assert.deepEqual(first, { role: "assistant", content: [BLOCK] });
        const sentBlock = Array.isArray(first?.content) ? first.content[0] : undefined;
        assert.ok(isCompactionBlock(sentBlock) && isCompactionBlock(BLOCK));
        assert.ok(sameBlock(sentBlock, BLOCK), "structural + exact content/signature");
        assert.ok(request.text.includes(JSON.stringify(BLOCK)), "block serialized byte-exact");
        assert.deepEqual(
          rest.map((message) => message.role),
          ["user", "assistant", "user"],
        );
        assert.ok(JSON.stringify(rest[0]).includes("NATIVE-KEPT-C"));
        assert.ok(JSON.stringify(rest[1]).includes("NATIVE-KEPT-D"));
        assert.ok(JSON.stringify(rest[2]).includes("NATIVE-NEXT"));
        assert.equal(request.text.includes("NATIVE-PREFIX"), false, "summarized prefix absent");
        assert.equal(request.text.includes("<summary>"), false, "no text fallback");
        assert.ok(parseBetaHeader(request.headers.get("anthropic-beta")).includes(COMPACT_BETA));
        if (after.length > 0) assert.deepEqual(request.body.metadata, { user_id: "native-later" });
        assert.equal(lastAssistant(host.session).stopReason, "stop");
        assert.deepEqual(
          host.diagnostics.map((diagnostic) => diagnostic.kind),
          ["rewritten"],
        );
        assert.equal(JSON.stringify(host.diagnostics).includes(BLOCK.signature), false);
        // The replayed block maps back to the committed checkpoint entry.
        const [capture] = capturesFor(host.sessionId);
        assert.deepEqual(capture?.mapping?.messages[0]?.entryIds, [host.compactionId]);
        assert.deepEqual(transportRefusals(host.sessionId), []);
      } finally {
        await host.dispose();
      }
    }
  },
);

test(
  "hostile later handlers make the request fail closed before transmission",
  { timeout: 20_000 },
  async () => {
    const hostile: {
      readonly name: string;
      readonly code: string;
      readonly factory: ExtensionFactory;
    }[] = [
      {
        name: "drops the block and betas",
        code: "block-missing",
        factory: handler((payload) => ({
          ...payload,
          messages: payload.messages.slice(1),
          betas: [],
        })),
      },
      {
        name: "strips only the beta",
        code: "beta-missing",
        factory: handler((payload) => ({ ...payload, betas: [] })),
      },
      {
        name: "alters the signature",
        code: "block-altered",
        factory: handler((payload) => ({
          ...payload,
          messages: [
            { role: "assistant", content: [{ ...BLOCK, signature: "tampered" }] },
            ...payload.messages.slice(1),
          ],
        })),
      },
      {
        name: "restores the summary text after the block",
        code: "summary-duplicated",
        factory: handler((payload) => {
          const [first, ...rest] = payload.messages;
          assert.ok(first);
          const summary = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${BLOCK.content}\n</summary>`;
          return { ...payload, messages: [first, { role: "user", content: summary }, ...rest] };
        }),
      },
    ];
    for (const item of hostile) {
      const host = await createHost({ after: [item.factory] });
      try {
        await host.session.prompt("NATIVE-NEXT");
        assert.equal(host.sent.length, 0, `${item.name}: nothing transmitted`);
        assert.deepEqual(
          transportRefusals(host.sessionId).map((refusal) => refusal.code),
          [item.code],
          item.name,
        );
        const failed = lastAssistant(host.session);
        assert.equal(failed.stopReason, "error", item.name);
        assert.ok(
          failed.errorMessage?.includes(`${TRANSPORT_REFUSAL_PREFIX}: ${item.code}`),
          `${item.name}: visible reason code (${failed.errorMessage})`,
        );
        assert.equal(isRetryableAssistantError(failed), false, `${item.name}: no retry loop`);
        assert.deepEqual(
          capturesFor(host.sessionId),
          [],
          `${item.name}: refused request not captured`,
        );
      } finally {
        await host.dispose();
      }
    }
  },
);

test("rewrite refusals also fail closed with a reason code", { timeout: 20_000 }, async () => {
  const earlier = handler((payload) => ({
    ...payload,
    messages: [{ role: "user", content: "NATIVE-INJECTED-FIRST" }, ...payload.messages],
  }));
  const cases: { readonly name: string; readonly options: HostOptions; readonly code: string }[] = [
    { name: "summary not first", options: { before: [earlier] }, code: "summary-not-first" },
    {
      name: "invalid native details",
      options: { checkpoint: "invalid-anthropic" },
      code: "details-invalid",
    },
    {
      name: "system/tools changed with kept thinking",
      options: { details: details({ keptThinking: true }) },
      code: "binding-mismatch",
    },
  ];
  for (const item of cases) {
    const host = await createHost(item.options);
    try {
      await host.session.prompt("NATIVE-NEXT");
      assert.equal(host.sent.length, 0, item.name);
      assert.deepEqual(
        transportRefusals(host.sessionId).map((refusal) => refusal.code),
        [item.code],
        item.name,
      );
      assert.deepEqual(
        host.diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic.code]),
        [["refused", item.code]],
        item.name,
      );
    } finally {
      await host.dispose();
    }
  }
});

test(
  "a changed system/tools without kept thinking still replays",
  { timeout: 20_000 },
  async () => {
    const host = await createHost({ details: details({ keptThinking: false }) });
    try {
      await host.session.prompt("NATIVE-NEXT");
      assert.equal(host.sent.length, 1);
      assert.deepEqual(host.sent[0]?.body?.messages[0], { role: "assistant", content: [BLOCK] });
    } finally {
      await host.dispose();
    }
  },
);

test(
  "thinking binding: the provider's drop_block is kept on replay",
  { timeout: 20_000 },
  async () => {
    const host = await createHost({ managedEffort: true });
    try {
      await host.session.prompt("NATIVE-NEXT");
      const [request] = host.sent;
      assert.ok(request?.body);
      assert.deepEqual(request.body.messages[0], { role: "assistant", content: [BLOCK] });
      assert.deepEqual(request.body.thinking, {
        type: "adaptive",
        display: "summarized",
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      });
      const betas = parseBetaHeader(request.headers.get("anthropic-beta"));
      assert.ok(
        betas.includes(COMPACT_BETA) && betas.includes("thinking-binding-controls-2026-08-01"),
      );
    } finally {
      await host.dispose();
    }
  },
);

test("non-native latest checkpoints are left untouched", { timeout: 20_000 }, async () => {
  const host = await createHost({ checkpoint: "text" });
  try {
    await host.session.prompt("NATIVE-NEXT");
    assert.equal(host.sent.length, 1);
    assert.equal(host.sent[0]?.text.includes(BLOCK.signature), false);
    assert.ok(host.sent[0]?.text.includes("<summary>"));
    assert.deepEqual(host.diagnostics, []);
  } finally {
    await host.dispose();
  }
});

test(
  "without the capturing transport the rewrite is not applied unverified",
  { timeout: 20_000 },
  async () => {
    const host = await createHost({ wrapped: false });
    try {
      await host.session.prompt("NATIVE-NEXT");
      assert.equal(host.sent.length, 1);
      assert.equal(host.sent[0]?.text.includes(BLOCK.signature), false, "no unverifiable block");
      assert.deepEqual(
        host.diagnostics.map((diagnostic) => diagnostic.kind),
        ["unverifiable"],
      );
    } finally {
      await host.dispose();
    }
  },
);
