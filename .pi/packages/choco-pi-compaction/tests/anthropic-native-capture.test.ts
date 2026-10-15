/**
 * Anthropic native transport capture.
 *
 * A real `createAgentSession` runs the INSTALLED Anthropic adapter behind the
 * capturing provider registered by an extension through the public
 * `registerProvider` seam; a fake base fetch answers, so nothing leaves the
 * process. The capture must hold the final serialized body (after every
 * before_provider_request handler), map it to branch entry IDs, report foreign
 * content and ambiguity, and keep no credentials.
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
  normalizeContext,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type ExtensionAPI,
  type ExtensionFactory,
  ModelRuntime,
  type SessionEntry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  bindSessionProjection,
  capturesFor,
  createCapturingStreamSimple,
  keyRef,
  mapWireToEntries,
  registerAnthropicCapture,
  releaseSessionCaptures,
  type WireCapture,
  WireBodySchema,
} from "../src/anthropic/capture.ts";

const PROVIDER = "native-capture";
const API_KEY = "native-non-secret-placeholder-key";
const MUTATION = "NATIVE-CAPTURE-LATER-MUTATION";

function nativeModel(): Model<"anthropic-messages"> {
  return {
    id: "claude-haiku-5-5",
    name: "Synthetic Haiku",
    api: "anthropic-messages",
    provider: PROVIDER,
    baseUrl: "https://native.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
  };
}

type Frame = JsonObject & { readonly type: string };

function sse(frames: readonly Frame[]): Response {
  const body = frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  return new Response(body.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function start(): Frame {
  return {
    type: "message_start",
    message: {
      id: "native-msg",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  };
}

function textReply(text: string): Response {
  return sse([
    start(),
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

function toolReply(id: string, label: string): Response {
  return sse([
    start(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "TOOL-TURN" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id, name: "step", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ label }) },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

const STEP_TOOL = defineTool({
  name: "step",
  label: "step",
  description: "deterministic step",
  parameters: Type.Object({ label: Type.String() }),
  async execute(_id, params) {
    return { content: [{ type: "text", text: `result-${params.label}` }], details: {} };
  },
});

interface Host {
  readonly session: AgentSession;
  readonly manager: SessionManager;
  readonly sessionId: string;
  readonly seed: { readonly a: string; readonly b: string; readonly c: string };
  readonly sent: { readonly url: string; readonly headers: Headers; readonly body: string }[];
  dispose(): Promise<void>;
}

/** Real session; capture installed by an extension, as the host wires it. */
async function createHost(
  respond: (index: number) => Response,
  extensions: readonly ExtensionFactory[],
  seedTexts: readonly [string, string, string] = ["NATIVE-A", "NATIVE-B", "NATIVE-C"],
): Promise<Host> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-native-capture-"));
  const model = nativeModel();
  const sent: { url: string; headers: Headers; body: string }[] = [];
  const baseFetch: typeof globalThis.fetch = async (input, init) => {
    sent.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    return respond(sent.length - 1);
  };
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
    models: [model],
    streamSimple: () => {
      throw new Error("unwrapped provider stream used");
    },
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 16_384 },
    retry: { enabled: false },
  });
  const wiring = (pi: ExtensionAPI): void => {
    pi.registerTool(STEP_TOOL);
    registerAnthropicCapture(pi, PROVIDER, { fetch: baseFetch });
    pi.on("session_start", (_event, ctx) => {
      const manager = ctx.sessionManager;
      bindSessionProjection(manager.getSessionId(), () => manager.buildSessionProjection().entries);
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
    extensionFactories: [wiring, ...extensions],
  });
  await loader.reload();
  const manager = SessionManager.inMemory(dir);
  const a = manager.appendMessage({ role: "user", content: seedTexts[0], timestamp: 0 });
  const b = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: seedTexts[1] }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  });
  const c = manager.appendMessage({ role: "user", content: seedTexts[2], timestamp: 0 });
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
    manager,
    sessionId,
    seed: { a, b, c },
    sent,
    async dispose() {
      session.dispose();
      releaseSessionCaptures(sessionId);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function messageEntry(entries: readonly SessionEntry[], role: string, text: string): string {
  const found = entries.find(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === role &&
      JSON.stringify(entry.message).includes(text),
  );
  assert.ok(found, `${role} entry containing ${text}`);
  return found.id;
}

function simplified(capture: WireCapture | undefined) {
  assert.ok(capture?.mapping, "capture is mapped");
  return capture.mapping.messages.map((message) => ({
    role: message.role,
    entryIds: [...message.entryIds],
    unmapped: message.unmapped.length,
    ambiguous: message.ambiguous.length,
  }));
}

test(
  "capture maps a 3-prefix + GO + tool pair session exactly, from the actual transport",
  { timeout: 20_000 },
  async () => {
    const host = await createHost(
      (index) => (index === 0 ? toolReply("toolu_native_1", "one") : textReply("FINAL")),
      [],
    );
    try {
      await host.session.prompt("NATIVE-GO");
      assert.equal(host.sent.length, 2, "two foreground requests");
      const captures = capturesFor(host.sessionId);
      assert.equal(captures.length, 2);
      const branch = host.manager.getBranch();
      const go = messageEntry(branch, "user", "NATIVE-GO");
      const toolCall = messageEntry(branch, "assistant", "toolu_native_1");
      const toolResult = messageEntry(branch, "toolResult", "toolu_native_1");
      assert.deepEqual(simplified(captures[0]), [
        { role: "user", entryIds: [host.seed.a], unmapped: 0, ambiguous: 0 },
        { role: "assistant", entryIds: [host.seed.b], unmapped: 0, ambiguous: 0 },
        { role: "user", entryIds: [host.seed.c], unmapped: 0, ambiguous: 0 },
        { role: "user", entryIds: [go], unmapped: 0, ambiguous: 0 },
      ]);
      assert.deepEqual(simplified(captures[1]), [
        { role: "user", entryIds: [host.seed.a], unmapped: 0, ambiguous: 0 },
        { role: "assistant", entryIds: [host.seed.b], unmapped: 0, ambiguous: 0 },
        { role: "user", entryIds: [host.seed.c], unmapped: 0, ambiguous: 0 },
        { role: "user", entryIds: [go], unmapped: 0, ambiguous: 0 },
        { role: "assistant", entryIds: [toolCall], unmapped: 0, ambiguous: 0 },
        { role: "user", entryIds: [toolResult], unmapped: 0, ambiguous: 0 },
      ]);
      const [first, second] = captures;
      assert.ok(first && second);
      // The capture is the exact serialized body the fake transport received.
      assert.equal(first.bodyText, host.sent[0]?.body);
      assert.equal(second.bodyText, host.sent[1]?.body);
      assert.equal(first.status, 200);
      assert.equal(first.endpoint, "https://native.invalid/v1/messages", "query dropped");
      assert.ok(host.sent[0]?.url.includes("?"), "the real request URL had a query");
      assert.equal(first.provider, PROVIDER);
      assert.equal(first.modelId, "claude-haiku-5-5");
      assert.ok(Object.isFrozen(first.body) && Object.isFrozen(first.body.messages));
      // No credential material is retained, though the transport saw it.
      assert.equal(host.sent[0]?.headers.get("x-api-key"), API_KEY);
      assert.equal(JSON.stringify(captures).includes(API_KEY), false);
      assert.equal("headers" in first, false);
    } finally {
      await host.dispose();
    }
  },
);

test(
  "a later handler's mutation is in the capture and reported as unmapped content",
  { timeout: 20_000 },
  async () => {
    const observed: string[] = [];
    const observer = (pi: ExtensionAPI): void => {
      pi.on("before_provider_request", (event) => {
        observed.push(JSON.stringify(event.payload));
        return undefined;
      });
    };
    const mutator = (pi: ExtensionAPI): void => {
      pi.on("before_provider_request", (event) => {
        if (!Value.Check(WireBodySchema, event.payload)) return undefined;
        return {
          ...event.payload,
          messages: [
            ...event.payload.messages,
            { role: "user", content: [{ type: "text", text: MUTATION }] },
          ],
        };
      });
    };
    const host = await createHost(() => textReply("OK"), [observer, mutator]);
    try {
      await host.session.prompt("NATIVE-GO");
      const [capture] = capturesFor(host.sessionId);
      assert.ok(capture?.mapping);
      assert.equal(observed[0]?.includes(MUTATION), false, "observer ran before the mutation");
      assert.ok(capture.bodyText.includes(MUTATION), "capture holds the final body");
      const injected = capture.mapping.messages.at(-1);
      assert.deepEqual(injected?.entryIds, []);
      assert.deepEqual(injected?.unmapped, [keyRef("text", MUTATION)]);
      assert.equal(JSON.stringify(capture.mapping).includes(MUTATION), false, "digest only");
    } finally {
      await host.dispose();
    }
  },
);

test(
  "repeated identical content resolves by position when the wire claims every owner",
  { timeout: 20_000 },
  async () => {
    const host = await createHost(
      () => textReply("OK"),
      [],
      ["NATIVE-SAME", "NATIVE-B", "NATIVE-SAME"],
    );
    try {
      await host.session.prompt("NATIVE-GO");
      const [capture] = capturesFor(host.sessionId);
      assert.ok(capture?.mapping);
      const [first, , third] = capture.mapping.messages;
      assert.deepEqual(first?.entryIds, [host.seed.a], "order-preserving pick");
      // Formerly every viable owner was recorded here. Both wire copies claim
      // both projected owners in order, so the monotone assignment is unique
      // and nothing is ambiguous; an unclaimed owner still is (see the
      // legality test "mapping failures refuse instead of guessing").
      assert.deepEqual(first?.ambiguous, []);
      assert.deepEqual(third?.entryIds, [host.seed.c]);
      assert.deepEqual(third?.ambiguous, [], "only one owner remains after the first");
    } finally {
      await host.dispose();
    }
  },
);

test("requests without a session ID or projection are not attributed", async () => {
  const sent: string[] = [];
  const stream = createCapturingStreamSimple({
    fetch: async (_input, init) => {
      sent.push(String(init?.body ?? ""));
      return textReply("OK");
    },
  });
  const context = normalizeContext({
    messages: [{ role: "user", content: "NATIVE-LONE", timestamp: 0 }],
  });
  for await (const event of stream(nativeModel(), context, { apiKey: API_KEY })) {
    assert.notEqual(event.type, "error");
  }
  assert.equal(sent.length, 1, "request still sent");
  const unbound = "native-unbound-session";
  for await (const event of stream(nativeModel(), context, {
    apiKey: API_KEY,
    sessionId: unbound,
  })) {
    assert.notEqual(event.type, "error");
  }
  const [capture] = capturesFor(unbound);
  assert.ok(capture, "captured under its session ID");
  assert.equal(capture.mapping, undefined, "no projection bound: unmapped, not guessed");
  releaseSessionCaptures(unbound);
});

test("mapping control: content no projected entry produced is reported", () => {
  const mapping = mapWireToEntries([{ role: "user", content: "never-in-branch" }], []);
  assert.deepEqual(mapping.messages, [
    {
      index: 0,
      role: "user",
      entryIds: [],
      unmapped: [keyRef("text", "never-in-branch")],
      ambiguous: [],
    },
  ]);
});
