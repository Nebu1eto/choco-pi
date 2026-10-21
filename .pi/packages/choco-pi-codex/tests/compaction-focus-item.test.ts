import assert from "node:assert/strict";
import test from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  COMPACTION_FOCUS_MAX_CODE_POINTS,
  compactionFocusItem,
  executeRemoteCompactionV2,
  rejectsCompactionFocus,
} from "../src/adapter/compaction/remote-v2-client.ts";
import { buildRemoteCompactionV2Window } from "../src/adapter/compaction/remote-v2-history.ts";
import { buildRequestBody } from "../src/providers/openai-codex-custom-provider.ts";

const model: Model<"openai-responses"> = {
  id: "fixture-responses",
  name: "Fixture",
  api: "openai-responses",
  provider: "fixture-openai",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 2048,
};

const CallbackSchema = Type.Function([Type.Unknown()], Type.Unknown());
const BodySchema = Type.Object(
  { input: Type.Array(Type.Unknown()) },
  { additionalProperties: true },
);

function assistant(stopReason: "stop" | "error", errorMessage?: string): AssistantMessage {
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
    stopReason,
    timestamp: Date.now(),
  };
  if (errorMessage !== undefined) message.errorMessage = errorMessage;
  return message;
}

interface Rejection {
  readonly status: number;
  readonly message: string;
}

/** A Responses provider that records every payload; `reject(n)` fails the n-th call (0-based). */
async function harness(reject: (call: number) => Rejection | undefined = () => undefined) {
  const payloads: Static<typeof BodySchema>[] = [];
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  runtime.registerProvider(model.provider, {
    api: "openai-responses",
    models: [model],
    streamSimple: (_model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const call = payloads.length;
      void (async () => {
        const onPayload = options && "onPayload" in options ? options.onPayload : undefined;
        if (!Value.Check(CallbackSchema, onPayload)) {
          stream.end();
          return;
        }
        const payload: unknown = await onPayload(
          buildRequestBody(model, normalizeContext(context)),
        );
        assert.ok(Value.Check(BodySchema, payload));
        payloads.push(payload);
        const rejection = reject(call);
        if (rejection !== undefined) {
          const onResponse = options && "onResponse" in options ? options.onResponse : undefined;
          if (Value.Check(CallbackSchema, onResponse))
            await onResponse({ status: rejection.status, headers: {} });
          stream.push({
            type: "error",
            reason: "error",
            error: assistant("error", rejection.message),
          });
          stream.end();
          return;
        }
        const onOutputItemDone =
          options && "onOutputItemDone" in options ? options.onOutputItemDone : undefined;
        if (Value.Check(CallbackSchema, onOutputItemDone))
          onOutputItemDone({ type: "compaction", id: "cmp-1", encrypted_content: "x" });
        stream.push({ type: "done", reason: "stop", message: assistant("stop") });
      })();
      return stream;
    },
  });
  return { payloads, registry: new ModelRegistry(runtime) };
}

const PROMPT_INPUT = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "earlier work" }] },
];

function run(registry: ModelRegistry, customInstructions: string | undefined) {
  return executeRemoteCompactionV2({
    runtime: {
      provider: model.provider,
      api: "openai-responses",
      apiFamily: "openai-responses",
      codexTransport: false,
      model: model.id,
      baseUrl: model.baseUrl,
      currentModel: model,
    },
    modelRegistry: registry,
    context: normalizeContext({ messages: [] }),
    promptInput: PROMPT_INPUT,
    promptInputSource: "reconstructed",
    requestOptions: {},
    tokensBefore: 1,
    sessionId: "focus-fixture",
    retryDelayMs: 0,
    maxRetries: 0,
    customInstructions,
  });
}

function inputOf(payload: Static<typeof BodySchema> | undefined): unknown[] {
  assert.ok(payload);
  return payload.input;
}

test("a non-blank focus is one developer message right before compaction_trigger", async () => {
  const { payloads, registry } = await harness();
  const result = await run(registry, "  keep the auth decisions  ");
  assert.ok(result.ok);
  assert.equal(result.focus, "forwarded");
  const input = inputOf(payloads[0]);
  assert.deepEqual(input.slice(-2), [
    {
      type: "message",
      role: "developer",
      content: [
        { type: "input_text", text: "Compaction focus from the user: keep the auth decisions" },
      ],
    },
    { type: "compaction_trigger" },
  ]);
  assert.equal(input.filter((item) => JSON.stringify(item).includes("Compaction focus")).length, 1);
  // The retained window is built from the prompt input, never from the request: no focus item.
  const window = buildRemoteCompactionV2Window(PROMPT_INPUT, result.compaction);
  assert.equal(JSON.stringify(window).includes("Compaction focus"), false);
  assert.equal(JSON.stringify(PROMPT_INPUT).includes("Compaction focus"), false);
});

test("a blank or absent focus adds nothing", async () => {
  for (const focus of [undefined, "", "   \n "]) {
    const { payloads, registry } = await harness();
    const result = await run(registry, focus);
    assert.ok(result.ok);
    assert.equal(result.focus, undefined);
    assert.deepEqual(inputOf(payloads[0]).at(-1), { type: "compaction_trigger" });
    assert.equal(JSON.stringify(payloads[0]).includes("developer"), false);
  }
  assert.equal(compactionFocusItem("  "), undefined);
});

test("a focus over 16,384 code points is an oversized failure and sends nothing", async () => {
  const { payloads, registry } = await harness();
  // Astral characters: 16,385 code points but 32,770 UTF-16 units.
  const result = await run(registry, "\u{1F600}".repeat(COMPACTION_FOCUS_MAX_CODE_POINTS + 1));
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.reason, "oversized");
  assert.equal(payloads.length, 0);
  const atLimit = await run(registry, "\u{1F600}".repeat(COMPACTION_FOCUS_MAX_CODE_POINTS));
  assert.ok(atLimit.ok);
});

test("a 4xx naming the focus item retries once without it and reports the focus ignored", async () => {
  const { payloads, registry } = await harness((call) =>
    call === 0
      ? {
          status: 400,
          message: `400 ${JSON.stringify({ error: { message: "Unsupported role", param: "input[1]" } })}`,
        }
      : undefined,
  );
  const result = await run(registry, "focus");
  assert.ok(result.ok);
  assert.equal(result.focus, "ignored");
  assert.equal(payloads.length, 2);
  assert.ok(JSON.stringify(payloads[0]).includes("Compaction focus"));
  assert.equal(JSON.stringify(payloads[1]).includes("Compaction focus"), false);
  assert.deepEqual(inputOf(payloads[1]).at(-1), { type: "compaction_trigger" });
});

test("other failures do not retry: a 5xx, an auth error, or an unrelated 4xx", async () => {
  for (const rejection of [
    { status: 500, message: "server error mentioning input[1]" },
    { status: 401, message: "developer token rejected" },
    { status: 400, message: "context too long for model" },
  ]) {
    const { payloads, registry } = await harness(() => rejection);
    const result = await run(registry, "focus");
    assert.equal(result.ok, false);
    assert.equal(payloads.length, 1, rejection.message);
  }
});

test("rejection heuristic: error.param path, item index, developer role or compaction_trigger text", () => {
  const failure = (message: string, status = 400) =>
    ({ ok: false, reason: "stream-error", errorMessage: message, status }) as const;
  assert.equal(rejectsCompactionFocus(failure('{"error":{"param":"input[3].role"}}'), 3), true);
  assert.equal(rejectsCompactionFocus(failure('{"error":{"param":"input[2]"}}'), 3), false);
  assert.equal(rejectsCompactionFocus(failure("Invalid input[3]: bad item"), 3), true);
  assert.equal(rejectsCompactionFocus(failure("role 'developer' is not allowed here"), 3), true);
  assert.equal(rejectsCompactionFocus(failure("compaction_trigger must be last"), 3), true);
  assert.equal(rejectsCompactionFocus(failure("anything", 429), 3), false);
  assert.equal(rejectsCompactionFocus(failure("developer"), undefined), false);
});
