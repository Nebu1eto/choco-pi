import assert from "node:assert/strict";
import test from "node:test";
import type { Message, Model, UserMessage } from "@earendil-works/pi-ai";
import {
  ContextInjectionHistory,
  type ContextInjectionMessage,
} from "../clients/context-injection-history.ts";
import { buildRequestBody } from "../../choco-pi-codex/src/providers/openai-codex/request-body.ts";
import { buildCachedWebSocketRequestBody } from "../../choco-pi-codex/src/providers/openai-codex/websocket-continuation.ts";
import { createInitialAssistantMessage } from "../../choco-pi-codex/src/providers/openai-codex/types.ts";

const user = (content: string, timestamp = 1): UserMessage => ({
  role: "user",
  content,
  timestamp,
});

test("consumed startup guidance remains in the exact serialized native continuation prefix", () => {
  const model: Model<"openai-codex-responses"> = {
    id: "gpt-6-astra",
    name: "serializer fixture",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: 6000,
  };
  const history = new ContextInjectionHistory<Message>();
  const original = [user("initial task"), user("Agent persona: pessimistic", 2)];
  const guidance = user("[choco-pi-lsp automated context — not a user request] guidance", 3);
  const first = buildRequestBody(model, { messages: history.apply("owner", original, [guidance]) });
  const reasoning = {
    type: "reasoning",
    id: "rs_fixture",
    summary: [],
    encrypted_content: "opaque-fixture",
  };
  const response = createInitialAssistantMessage(model);
  response.stopReason = "stop";
  response.content = [
    { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning) },
  ];
  const raw: Message[] = [...original, response, user("steer", 4)];
  const continuation = {
    lastRequestBody: first,
    lastResponseId: "r1",
    lastResponseItems: [reasoning],
  };
  const next = buildRequestBody(model, { messages: history.apply("owner", raw) });
  const prepared = buildCachedWebSocketRequestBody(continuation, next);
  assert.equal(prepared.decision, "delta");
  assert.equal(prepared.body.previous_response_id, "r1");
  assert.deepEqual(prepared.body.input, [
    { role: "user", content: [{ type: "input_text", text: "steer" }] },
  ]);
  // The original one-shot behavior drops guidance and cannot prove continuation.
  const dropped = buildRequestBody(model, { messages: raw });
  assert.notEqual(buildCachedWebSocketRequestBody(continuation, dropped).decision, "delta");
  const edited: Message[] = [user("changed original task"), ...raw.slice(1)];
  const changed = buildRequestBody(model, { messages: history.apply("owner", edited) });
  assert.notEqual(buildCachedWebSocketRequestBody(continuation, changed).decision, "delta");
});

test("before-final placement remains anchored across user steering and additional findings", () => {
  const history = new ContextInjectionHistory<ContextInjectionMessage>();
  const original = [user("first")];
  const guidance = user("guidance");
  assert.deepEqual(history.apply("a", original, [guidance], true), [guidance, ...original]);
  const next = [...original, { role: "assistant", content: "answer" }, user("steer")];
  assert.deepEqual(history.apply("a", next), [guidance, ...next]);
  assert.deepEqual(
    history.apply("a", next),
    [guidance, ...next],
    "replay does not duplicate guidance",
  );
  const finding = user("new finding");
  assert.deepEqual(history.apply("a", next, [finding], true), [
    guidance,
    ...next.slice(0, -1),
    finding,
    next.at(-1),
  ]);
  assert.deepEqual(history.apply("a", [...next, user("more")]), [
    guidance,
    ...next.slice(0, -1),
    finding,
    next.at(-1),
    user("more"),
  ]);
});

test("replay never splits an existing tool call and its result", () => {
  const history = new ContextInjectionHistory<ContextInjectionMessage>();
  const call = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call", name: "test", arguments: {} }],
  };
  const result = { role: "toolResult", content: "done" };
  const original = [call, result];
  const guidance = user("findings");
  assert.deepEqual(history.apply("a", original, [guidance]), [...original, guidance]);
  const next = [...original, { role: "assistant", content: "next" }, user("steer")];
  assert.deepEqual(history.apply("a", next), [call, result, guidance, ...next.slice(2)]);
});

test("owners, run cleanup and transcript rewrites cannot inherit stale guidance", () => {
  const history = new ContextInjectionHistory<UserMessage>();
  const original = [user("one"), user("two")];
  const guidance = user("guidance");
  history.apply("a", original, [guidance]);
  history.apply("b", original, [user("b guidance")]);
  assert.equal(history.apply("other", original), original);
  history.clear("a");
  assert.equal(history.apply("a", original), original);
  assert.deepEqual(history.apply("b", original), [...original, user("b guidance")]);
  assert.equal(
    history.apply("b", original.slice(0, 1)).length,
    1,
    "compaction/rewind drops anchors",
  );
  assert.equal(history.apply("b", original), original);
  history.apply(undefined, original, [guidance]);
  assert.equal(history.apply(undefined, original), original, "unknown owners are never retained");
});

test("retained guidance owns its data without mutating the host transcript", () => {
  const history = new ContextInjectionHistory<UserMessage>();
  const original = [user("task")];
  const guidance = user("original guidance");
  const rendered = history.apply("a", original, [guidance]);
  guidance.content = "mutated producer";
  rendered[1]!.content = "mutated consumer";
  assert.deepEqual(original, [user("task")]);
  assert.deepEqual(history.apply("a", original), [...original, user("original guidance")]);
  history.clear("a");
  assert.deepEqual(history.apply("a", [], [user("startup")]), [user("startup")]);
  assert.deepEqual(history.apply("a", []), [user("startup")]);
});
