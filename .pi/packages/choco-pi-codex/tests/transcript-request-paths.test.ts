import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { serializeMessagesToResponsesInput } from "../src/adapter/compaction/serializer.ts";
import {
  buildCompactionTranscriptContext,
  buildNativeCompactionInput,
} from "../src/adapter/compaction/compaction.ts";
import { executeRemoteCompactionV2 } from "../src/adapter/compaction/remote-v2-client.ts";
import { createNativeCompactionDetails } from "../src/adapter/compaction/types.ts";
import { resolveLatestNativeCompactionEntry } from "../src/adapter/compaction/details-store.ts";
import { normalizePrewarmContext } from "../src/extension/runtime.ts";
import { streamCodeModeResponsesProxy } from "../src/providers/code-mode-proxy-provider.ts";
import { prewarmOpenAICodexWebSocket } from "../src/providers/openai-codex-custom-provider.ts";
import { openAICodexModelsWithDaybreak } from "../src/providers/openai-codex/model-catalog.ts";
import { buildRequestBody } from "../src/providers/openai-codex/request-body.ts";
import {
  prewarmWebSocket,
  sendPreparedWebSocketRequest,
} from "../src/providers/openai-codex/websocket-stream.ts";

const NamedToolSchema = Type.Object({ name: Type.String() });
const CallbackSchema = Type.Function([Type.Unknown()], Type.Unknown());
const EmittedBodySchema = Type.Object({
  type: Type.Literal("response.create"),
  instructions: Type.String(),
  input: Type.Array(Type.Unknown()),
  tools: Type.Optional(Type.Array(Type.Unknown())),
});
const RequestBodySchema = Type.Object({
  instructions: Type.String(),
  input: Type.Array(Type.Unknown()),
  tools: Type.Optional(Type.Array(Type.Unknown())),
});
const model: Model<"openai-responses"> = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  api: "openai-responses",
  provider: "fixture-provider",
  baseUrl: "https://invalid.example",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 100_000,
};
const toolA = {
  name: "toolA",
  description: "Removed tool.",
  parameters: Type.Object({ old: Type.String() }),
};
const toolB = {
  name: "toolB",
  description: "Current tool.",
  parameters: Type.Object({ current: Type.String() }),
};
const forcedPromptTranscript = normalizeContext({
  messages: [
    {
      role: "system",
      content: "SDK BASE PROMPT",
      sections: { base: "BASE SECTION" },
      toolsAdded: [toolA],
      timestamp: 0,
    },
    { role: "user", content: "Before delta.", timestamp: 1 },
    { role: "system", content: "", toolsAdded: [toolB], timestamp: 2 },
    { role: "user", content: "After delta.", timestamp: 3 },
  ],
});
const transcript = normalizeContext({
  messages: [
    {
      role: "system",
      content: "Transcript instructions.",
      toolsAdded: [toolA],
      timestamp: 0,
    },
    { role: "user", content: "Before delta.", timestamp: 1 },
    {
      role: "system",
      content: "",
      toolsAdded: [toolB],
      toolsRemoved: [{ name: "toolA" }],
      timestamp: 2,
    },
    { role: "user", content: "After delta.", timestamp: 3 },
  ],
});
const compatModel: Model<"openai-responses"> = {
  ...model,
  compat: {
    supportsMidConvoSystemMessages: true,
    supportsAdditionalTools: true,
    supportsToolSearch: true,
  },
};
const deferredTranscript = normalizeContext({
  messages: [
    {
      role: "system",
      content: "Transcript instructions.",
      toolsAdded: [toolA],
      timestamp: 0,
    },
    { role: "user", content: "Before delta.", timestamp: 1 },
    { role: "system", content: "Extra rules.", toolsAdded: [toolB], timestamp: 2 },
    { role: "user", content: "After delta.", timestamp: 3 },
  ],
});

interface TranscriptBody {
  instructions?: string | undefined;
  input: readonly unknown[];
  tools?: readonly unknown[] | undefined;
}

function toolNames(body: TranscriptBody): Array<string | undefined> {
  return (body.tools ?? []).map((tool) =>
    Value.Check(NamedToolSchema, tool) ? tool.name : undefined,
  );
}

function assertCurrentTranscript(body: TranscriptBody): void {
  assert.equal(body.instructions, "Transcript instructions.");
  assert.equal(JSON.stringify(body).match(/Transcript instructions\./g)?.length, 1);
  assert.deepEqual(toolNames(body), ["toolB"]);
  assert.equal(
    body.input.some((item) => JSON.stringify(item).includes("Transcript instructions.")),
    false,
  );
}

test("WebSocket continuation sends the same normalized body used by SSE fallback", () => {
  const sseBody = buildRequestBody(model, transcript);
  let frame = "";
  sendPreparedWebSocketRequest(
    { send: (data) => (frame = data) },
    { kind: "send", body: sseBody },
    {
      stream: "response",
      ts: new Date(0).toISOString(),
      provider: model.provider,
      model: model.id,
      continuation: "disabled",
      fullInputItemCount: sseBody.input.length,
    },
  );
  const websocketBody: unknown = JSON.parse(frame);
  assert.ok(Value.Check(EmittedBodySchema, websocketBody));
  const emitted = websocketBody;
  assertCurrentTranscript(emitted);
  assertCurrentTranscript(sseBody);
  const { type: _type, ...emittedBody } = emitted;
  assert.deepEqual(emittedBody, JSON.parse(JSON.stringify(sseBody)));
});

test("prewarm boundary sends the current normalized request through its transport", async () => {
  let captured: TranscriptBody | undefined;
  const transport: typeof prewarmWebSocket = async (_url, body) => {
    captured = structuredClone(body);
    return { socketReused: false };
  };
  const tokenPayload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
  ).toString("base64url");
  await prewarmOpenAICodexWebSocket(
    model,
    normalizePrewarmContext("Transcript instructions.", [toolA, toolB], transcript.messages),
    { apiKey: `e30.${tokenPayload}.signature`, sessionId: "session-1", transport: "websocket" },
    { prewarmTransport: transport },
  );
  assert.ok(captured);
  assertCurrentTranscript(captured);
  const expected = buildRequestBody(model, normalizeContext({ messages: transcript.messages }));
  const actual = buildRequestBody(
    model,
    normalizePrewarmContext("Transcript instructions.", [toolA, toolB], transcript.messages),
  );
  assert.equal(actual.instructions, expected.instructions);
  assert.deepEqual(actual.input, expected.input);
  assert.deepEqual(actual.tools, expected.tools);
  assert.equal(JSON.stringify(actual).match(/Transcript instructions\./g)?.length, 1);
});

test("Code Mode proxy derives grammar-tool metadata after a toolsRemoved delta", async () => {
  let captured: TranscriptBody | undefined;
  const stream = streamCodeModeResponsesProxy(model, transcript, {
    apiKey: "fixture",
    onPayload: (payload) => {
      assert.ok(Value.Check(RequestBodySchema, payload));
      captured = structuredClone(payload);
      throw new Error("captured before transport");
    },
  });
  for await (const event of stream) {
    if (event.type === "error") break;
  }
  assert.ok(captured);
  assertCurrentTranscript(captured);
  assert.match(JSON.stringify(captured.tools), /toolB/);
  assert.doesNotMatch(JSON.stringify(captured.tools), /toolA/);
});

test("native compaction serializer matches deferred-tool request input item-for-item", () => {
  const request = buildRequestBody(compatModel, deferredTranscript);
  const input = serializeMessagesToResponsesInput(compatModel, deferredTranscript.messages);
  const compactionContext = buildCompactionTranscriptContext(
    deferredTranscript.messages,
    "Transcript instructions.",
    [toolA, toolB],
  );
  const compactionRequest = buildRequestBody(compatModel, compactionContext);
  assert.deepEqual(input, request.input);
  assert.deepEqual(
    compactionRequest,
    buildRequestBody(
      compatModel,
      normalizePrewarmContext(
        "Transcript instructions.",
        [toolA, toolB],
        deferredTranscript.messages,
      ),
    ),
  );
  const declarations = JSON.stringify({
    tools: request.tools,
    input,
  });
  assert.equal(declarations.match(/"name":"toolA"/g)?.length, 1);
  assert.equal(declarations.match(/"name":"toolB"/g)?.length, 1);
  assert.match(JSON.stringify(input), /additional_tools|tool_search/);
});

test("reconstructed remote compaction sends the projected transcript exactly once", async () => {
  const projected = buildCompactionTranscriptContext(
    deferredTranscript.messages,
    "Transcript instructions.\n\nExtra rules.",
    [toolA, toolB],
  );
  const expected = buildRequestBody(compatModel, projected);
  const manager = SessionManager.inMemory("/project");
  for (const message of deferredTranscript.messages) manager.appendMessage(message);
  const built = buildNativeCompactionInput({
    model: compatModel,
    branchEntries: manager.getBranch(),
    allEntries: manager.getEntries(),
    leafId: manager.getLeafId(),
    latestNativeCompaction: { ok: false, reason: "no-compaction" },
    projectedContext: projected,
  });
  assert.ok(built);
  const projectedInput = built.input;
  assert.deepEqual(expected.input, projectedInput);
  let captured: unknown;
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  runtime.registerProvider(model.provider, {
    api: "openai-responses",
    models: [model],
    streamSimple: (_model, context, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const onPayload = options && "onPayload" in options ? options.onPayload : undefined;
        if (!Value.Check(CallbackSchema, onPayload)) {
          stream.end();
          return;
        }
        captured = await onPayload(buildRequestBody(compatModel, context));
        const onOutputItemDone =
          options && "onOutputItemDone" in options ? options.onOutputItemDone : undefined;
        if (Value.Check(CallbackSchema, onOutputItemDone)) {
          onOutputItemDone({ type: "compaction", id: "cmp-1", encrypted_content: "x" });
        }
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: "openai-responses",
          provider: model.provider,
          model: model.id,
          responseId: "response-1",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        };
        stream.push({ type: "done", reason: "stop", message });
      })();
      return stream;
    },
  });
  const registry = new ModelRegistry(runtime);
  await executeRemoteCompactionV2({
    runtime: {
      provider: model.provider,
      api: "openai-responses",
      apiFamily: "openai-responses",
      codexTransport: false,
      model: model.id,
      baseUrl: model.baseUrl,
      currentModel: compatModel,
    },
    modelRegistry: registry,
    context: projected,
    promptInput: projectedInput,
    promptInputSource: "reconstructed",
    requestOptions: {},
    tokensBefore: 1,
    sessionId: "projected-compaction",
    retryDelayMs: 0,
  });

  assert.ok(Value.Check(RequestBodySchema, captured));
  assert.deepEqual(captured.input.slice(0, -1), expected.input);
  assert.equal(JSON.stringify(captured).match(/Extra rules\./g)?.length, 1);
  assert.deepEqual(toolNames(captured), ["toolA", "toolB"]);
  assert.equal(JSON.stringify(captured.input).includes("additional_tools"), false);
});

test("catalog models preserve leading instructions and defer later tool additions", () => {
  const catalogModel = openAICodexModelsWithDaybreak().find(
    ({ id }) => id === "gpt-daybreak-blue-latest",
  );
  assert.ok(catalogModel);
  const request = buildRequestBody(catalogModel, deferredTranscript);
  assert.equal(request.instructions, "Transcript instructions.");
  assert.equal(
    request.input.filter((item) => /additional_tools|tool_search/.test(JSON.stringify(item)))
      .length,
    1,
  );
});

test("auxiliary contexts project the active forced prompt and current transcript tools", () => {
  const expected = buildRequestBody(
    model,
    normalizeContext({
      messages: [
        { role: "system", content: "ACTIVE", toolsAdded: [toolA, toolB], timestamp: 0 },
        { role: "user", content: "Before delta.", timestamp: 1 },
        { role: "user", content: "After delta.", timestamp: 3 },
      ],
    }),
  );
  for (const context of [
    normalizePrewarmContext("ACTIVE", [toolA, toolB], forcedPromptTranscript.messages),
    buildCompactionTranscriptContext(forcedPromptTranscript.messages, "ACTIVE", [toolA, toolB]),
  ]) {
    const actual = buildRequestBody(model, context);
    assert.equal(actual.instructions, "ACTIVE");
    assert.doesNotMatch(JSON.stringify(actual), /SDK BASE PROMPT|BASE SECTION/);
    assert.deepEqual(actual.input, expected.input);
    assert.deepEqual(actual.tools, expected.tools);
  }
});

test("auxiliary context with empty history keeps active prompt and supplied tools", () => {
  for (const context of [
    normalizePrewarmContext("ACTIVE", [toolA, toolB], []),
    buildCompactionTranscriptContext([], "ACTIVE", [toolA, toolB]),
  ]) {
    assert.equal(context.messages.length, 1);
    const body = buildRequestBody(model, context);
    assert.equal(body.instructions, "ACTIVE");
    assert.deepEqual(toolNames(body), ["toolA", "toolB"]);
  }
});

test("checkpoint reconstruction projects the forced prompt and current tools once", () => {
  const manager = SessionManager.inMemory("/project");
  manager.appendMessage({
    role: "system",
    content: "BASE",
    toolsAdded: [toolA],
    timestamp: 0,
  });
  const kept = manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
  manager.appendCompaction(
    "native",
    kept,
    100,
    createNativeCompactionDetails({
      provider: compatModel.provider,
      api: compatModel.api,
      model: compatModel.id,
      baseUrl: compatModel.baseUrl,
      compactedWindow: [{ type: "compaction", encrypted_content: "fixture" }],
    }),
  );
  manager.appendMessage({
    role: "system",
    content: "MANDATORY TAIL RULE",
    sections: { base: "STALE SDK BASE" },
    toolsAdded: [toolB],
    timestamp: 2,
  });
  manager.appendMessage({ role: "user", content: "after checkpoint", timestamp: 3 });
  const branch = manager.getBranch();
  const projected = buildCompactionTranscriptContext(
    convertToLlm(buildSessionContext(branch).messages),
    "BASE\n\nMANDATORY TAIL RULE",
    [toolA, toolB],
  );
  const built = buildNativeCompactionInput({
    model: {
      ...compatModel,
      compat: { supportsMidConvoSystemMessages: false, supportsAdditionalTools: true },
    },
    branchEntries: branch,
    allEntries: manager.getEntries(),
    leafId: manager.getLeafId(),
    latestNativeCompaction: resolveLatestNativeCompactionEntry(branch, {
      provider: compatModel.provider,
      api: compatModel.api,
      baseUrl: compatModel.baseUrl,
    }),
    projectedContext: projected,
  });
  assert.ok(built);
  const serialized = JSON.stringify(built.input);
  assert.equal(serialized.match(/MANDATORY TAIL RULE/g)?.length ?? 0, 0);
  assert.equal(serialized.match(/STALE SDK BASE/g)?.length ?? 0, 0);
  assert.equal(serialized.match(/"name":"toolA"/g)?.length ?? 0, 0);
  assert.equal(serialized.match(/"name":"toolB"/g)?.length, 1);
  assert.equal(
    built.input
      .filter((item) => "role" in item && item.role === "developer")
      .every((item) => "type" in item && item.type === "additional_tools"),
    true,
  );
});
