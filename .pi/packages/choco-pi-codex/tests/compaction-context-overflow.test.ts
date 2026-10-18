import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { executeRemoteCompactionV2 } from "../src/adapter/compaction/remote-v2-client.ts";
import {
  COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE,
  shrinkNativeCompactionRequestForEndpoint,
} from "../src/adapter/compaction/request-shrink.ts";
import type { ResponsesInputItem } from "../src/adapter/compaction/serializer.ts";

// Synthetic fixtures only: no session content, no network. The fake provider
// records every payload the compaction client would send.

const CallbackSchema = Type.Function([Type.Unknown()], Type.Unknown());
const PayloadSchema = Type.Object({ input: Type.Array(Type.Unknown()) });
const OVERFLOW =
  "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.";

/** Gpt-5.6-sol on the Codex transport: a Responses Lite id with a 272k window. */
const codexModel: Model<"openai-codex-responses"> = {
  id: "gpt-5.6-sol",
  name: "Fixture Sol",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
};

/** About `tokens` o200k tokens of varied prose. */
function prose(tokens: number): string {
  return "alpha beta gamma delta ".repeat(Math.ceil(tokens / 4));
}
const user = (text: string): ResponsesInputItem => ({
  role: "user",
  content: [{ type: "input_text", text }],
});
const assistant = (text: string): ResponsesInputItem => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});
const call = (id: string): ResponsesInputItem => ({
  type: "function_call",
  call_id: id,
  name: "exec_command",
  arguments: "{}",
});
const output = (id: string, text: string): ResponsesInputItem => ({
  type: "function_call_output",
  call_id: id,
  output: text,
});

type Reply = "overflow" | "ok";

function successMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: codexModel.api,
    provider: codexModel.provider,
    model: codexModel.id,
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
}

/** Runs one compaction against a fake Codex-transport stream; replies are used in order. */
async function runCompaction(
  promptInput: ResponsesInputItem[],
  tokensBefore: number,
  replies: Reply[],
  maxRetries?: number,
) {
  const sent: unknown[][] = [];
  let payloadAttempts = 0;
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  runtime.registerProvider(codexModel.provider, {
    api: "openai-codex-responses",
    models: [codexModel],
    streamSimple: (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const onPayload = options && "onPayload" in options ? options.onPayload : undefined;
        assert.ok(Value.Check(CallbackSchema, onPayload));
        const reply = replies[payloadAttempts++] ?? "ok";
        let body: unknown;
        try {
          body = await onPayload({
            model: codexModel.id,
            store: false,
            stream: true,
            input: [],
            text: { verbosity: "low" },
            include: [],
            tool_choice: "auto",
            parallel_tool_calls: true,
          });
        } catch (error) {
          const failed = successMessage();
          failed.stopReason = "error";
          failed.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", reason: "error", error: failed });
          return;
        }
        assert.ok(Value.Check(PayloadSchema, body));
        sent.push(body.input);
        if (reply === "overflow") {
          const failed = successMessage();
          failed.stopReason = "error";
          failed.errorMessage = OVERFLOW;
          stream.push({ type: "error", reason: "error", error: failed });
          return;
        }
        const onOutputItemDone =
          options && "onOutputItemDone" in options ? options.onOutputItemDone : undefined;
        assert.ok(Value.Check(CallbackSchema, onOutputItemDone));
        onOutputItemDone({ type: "compaction", id: "cmp-1", encrypted_content: "synthetic" });
        stream.push({ type: "done", reason: "stop", message: successMessage() });
      })();
      return stream;
    },
  });
  const result = await executeRemoteCompactionV2({
    runtime: {
      provider: codexModel.provider,
      api: codexModel.api,
      apiFamily: "openai-codex-responses",
      codexTransport: true,
      model: codexModel.id,
      baseUrl: codexModel.baseUrl,
      currentModel: codexModel,
    },
    modelRegistry: new ModelRegistry(runtime),
    context: normalizeContext({ messages: [] }),
    promptInput,
    promptInputSource: "reconstructed",
    requestOptions: {},
    tokensBefore,
    sessionId: "synthetic-overflow-session",
    transport: "sse",
    maxRetries,
  });
  return { result, sent, payloadAttempts };
}

function truncatedOutputs(input: readonly unknown[]): number {
  return input.filter((item) =>
    Value.Check(
      Type.Object({ output: Type.Literal(COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE) }),
      item,
    ),
  ).length;
}

test("a Responses Lite request over the model window is shrunk before it is sent", async () => {
  // Overflow recovery hands over a history larger than the 272k window. The
  // 872k endpoint budget alone never shrank it; the last item is an assistant
  // message, so the upstream trailing-output pass had nothing to rewrite either.
  const input = [
    user("start"),
    call("c1"),
    output("c1", prose(150_000)),
    call("c2"),
    output("c2", prose(150_000)),
    assistant("done"),
  ];
  const { result, sent } = await runCompaction(input, 300_000, ["ok"]);
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  const first = sent[0]!;
  assert.ok(truncatedOutputs(first) >= 1, "an oversized tool output is truncated");
  assert.ok(JSON.stringify(first).length < 4 * 258_400, "the request fits 95% of the window");
  // Pairing is intact: both calls and both outputs are still present.
  assert.equal(first.filter((item) => JSON.stringify(item).includes('"call_id"')).length, 4);
});

test("a context-overflow rejection is classified and retried once with reduced input", async () => {
  // The host's estimate (100k) is under the budget, so the first attempt sends
  // the input unchanged; the provider still rejects it as over the window.
  const input = [user("start"), call("c1"), output("c1", prose(220_000)), assistant("done")];
  const { result, sent } = await runCompaction(input, 100_000, ["overflow", "ok"]);
  assert.equal(sent.length, 2, "exactly one reduced retry");
  assert.equal(truncatedOutputs(sent[0]!), 0);
  assert.equal(truncatedOutputs(sent[1]!), 1);
  assert.equal(result.ok, true);
});

test("an overflow the input cannot shrink below fails as context-overflow without resending", async () => {
  const input = [user("only")];
  const { result, sent, payloadAttempts } = await runCompaction(input, 1_000, ["overflow"]);
  assert.equal(sent.length, 1, "the identical input is not sent twice");
  assert.equal(payloadAttempts, 2);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "context-overflow");
});

test("a caller that disabled retries gets no reduced overflow retry", async () => {
  // The background lane passes maxRetries: 0 and owns its own attempt budget.
  const input = [user("start"), call("c1"), output("c1", prose(220_000)), assistant("done")];
  const { result, sent, payloadAttempts } = await runCompaction(input, 100_000, ["overflow"], 0);
  assert.equal(payloadAttempts, 1, "no second attempt is started");
  assert.equal(sent.length, 1);
  assert.equal(!result.ok && result.reason, "context-overflow");
});

test("the reduced retry never resends the input the provider already rejected", async () => {
  // One output over the budget: the first attempt already truncates it, and the
  // reduced attempt would truncate it to the very same marker.
  const input = [user("start"), call("c1"), output("c1", prose(300_000)), assistant("done")];
  const { result, sent, payloadAttempts } = await runCompaction(input, 300_000, ["overflow"]);
  assert.equal(truncatedOutputs(sent[0]!), 1, "the first attempt was already shrunk");
  assert.equal(payloadAttempts, 2);
  assert.equal(sent.length, 1, "the identical payload is not sent again");
  assert.equal(!result.ok && result.reason, "context-overflow");
});

test("trimming drops the oldest turns at a user boundary and keeps compaction items and pairs", async () => {
  const compaction = { type: "compaction", encrypted_content: "synthetic" };
  const input: ResponsesInputItem[] = [
    compaction,
    user(prose(40_000)),
    call("old"),
    output("old", "x"),
    assistant(prose(40_000)),
    user("recent"),
    call("new"),
    output("new", "y"),
    assistant("ok"),
  ];
  const shrunk = await shrinkNativeCompactionRequestForEndpoint(
    { model: codexModel.id, input },
    { budgetTokens: 20_000, tokensBefore: 90_000 },
  );
  assert.deepEqual(shrunk.request.input, [
    compaction,
    user("recent"),
    call("new"),
    { ...output("new", "y"), output: COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE },
    assistant("ok"),
  ]);
  assert.equal(shrunk.droppedItems, 4);
});

test("requests within budget are left untouched", async () => {
  const input = [user("a"), call("c"), output("c", "z"), assistant("b")];
  const shrunk = await shrinkNativeCompactionRequestForEndpoint(
    { model: codexModel.id, input },
    { budgetTokens: 258_400, tokensBefore: 10 },
  );
  assert.equal(shrunk.request.input, input);
  assert.equal(shrunk.rewrittenOutputs, 0);
  assert.equal(shrunk.droppedItems, 0);
});
