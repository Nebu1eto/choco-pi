import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { obj, oneOf, str } from "@earendil-works/pi-schema";
import { makeStrictJsonSchema } from "../src/providers/constrained-sampling.ts";
import { parseOpenAICodexDeviceAuthPollResponse } from "../src/providers/openai-codex/oauth.ts";
import { buildRequestBody } from "../src/providers/openai-codex/request-body.ts";
import {
  type ResponsesBody,
  isCodexStreamEvent,
  isProtocolObject,
  isResponsesBody,
} from "../src/providers/openai-codex/types.ts";
import { supportsNativeSteeringTools } from "../src/providers/openai-codex/native-features.ts";
import { extractCodexTurnStateFromWebSocketEvent } from "../src/providers/openai-codex/turn-state.ts";
import { isEmptyArguments, isTextFrame, isWireEvent } from "../src/prototype/wire.ts";
import {
  publishTransportProbe,
  type TransportProbeRecord,
} from "../src/diagnostics/transport-probe-registry.ts";
import { isString, isNumber, isRevision } from "../src/providers/value-guards.ts";

const validBody: ResponsesBody = {
  model: "gpt-5.6-sol",
  store: false,
  stream: true,
  input: [{ role: "user", content: "hi" }],
  text: { verbosity: "low" },
  include: [],
  tool_choice: "auto",
  parallel_tool_calls: true,
};

test("value guards keep the TypeBox number and integer rejection of NaN and Infinity", () => {
  assert.ok(isString("a"));
  assert.ok(!isString(new String("a")));
  assert.ok(isNumber(1.5));
  assert.ok(!isNumber(Number.NaN) && !isNumber(Infinity) && !isNumber("1"));
  assert.ok(isRevision(0) && !isRevision(-1) && !isRevision(1.5) && !isRevision(Infinity));
});

test("isProtocolObject is open, allows top-level undefined and rejects nested undefined", () => {
  assert.ok(isProtocolObject({ a: 1, b: undefined, c: { d: [1, "x", null, true] } }));
  assert.ok(!isProtocolObject({ a: { b: undefined } }));
  assert.ok(!isProtocolObject({ a: Number.NaN }));
  assert.ok(!isProtocolObject({ a: 1n }));
  assert.ok(!isProtocolObject([]));
  assert.ok(!isProtocolObject(null));
});

test("isResponsesBody requires the wire fields and keeps extra keys open", () => {
  assert.ok(isResponsesBody(validBody));
  assert.ok(isResponsesBody({ ...validBody, extra: { anything: [1] } }));
  assert.ok(!isResponsesBody({ ...validBody, model: undefined }));
  assert.ok(!isResponsesBody({ ...validBody, tool_choice: "other" }));
  assert.ok(!isResponsesBody({ ...validBody, text: {} }));
  assert.ok(!isResponsesBody({ ...validBody, include: [1] }));
  assert.ok(!isResponsesBody({ ...validBody, input: [undefined] }));
});

test("isCodexStreamEvent accepts every JSON kind and nothing else", () => {
  for (const value of [{}, [], "s", 1, true, null]) assert.ok(isCodexStreamEvent(value));
  assert.ok(!isCodexStreamEvent(undefined));
  assert.ok(!isCodexStreamEvent(1n));
});

test("turn state extraction accepts both metadata event types and ignores other shapes", () => {
  const headers = { "X-Codex-Turn-State": "  abc  " };
  for (const type of ["response.metadata", "codex.response.metadata"]) {
    assert.equal(extractCodexTurnStateFromWebSocketEvent({ type, headers, extra: 1 }), "abc");
  }
  assert.equal(extractCodexTurnStateFromWebSocketEvent({ type: "other", headers }), undefined);
  assert.equal(
    extractCodexTurnStateFromWebSocketEvent({
      type: "response.metadata",
      headers: { "x-codex-turn-state": 3 },
    }),
    undefined,
  );
});

test("native steering tool ownership narrows namespace, function and custom tools", () => {
  const body = (tools: object[]) => ({ ...validBody, tools });
  assert.ok(supportsNativeSteeringTools(body([{ type: "function", name: "a" }])));
  assert.ok(
    supportsNativeSteeringTools(
      body([{ type: "namespace", tools: [{ type: "custom" }, { type: "function" }] }]),
    ),
  );
  assert.ok(!supportsNativeSteeringTools(body([{ type: "programmatic_tool_calling" }])));
  assert.ok(!supportsNativeSteeringTools(body([{ type: "namespace", tools: [{ type: "web" }] }])));
  assert.ok(!supportsNativeSteeringTools(body([{ name: "no-type" }])));
});

test("device auth poll responses accept open payloads and reject missing fields", async () => {
  const ok = await parseOpenAICodexDeviceAuthPollResponse(
    Response.json({ authorization_code: "c", code_verifier: "v", extra: true }),
  );
  assert.deepEqual(ok, {
    status: "complete",
    value: { authorization_code: "c", code_verifier: "v" },
  });
  const bad = await parseOpenAICodexDeviceAuthPollResponse(
    Response.json({ authorization_code: "c" }),
  );
  assert.equal(bad.status, "failed");
  for (const error of ["slow_down", { code: "slow_down" }]) {
    const slow = await parseOpenAICodexDeviceAuthPollResponse(
      Response.json({ error }, { status: 400 }),
    );
    assert.equal(slow.status, "slow_down");
  }
});

test("prototype wire validators keep their open and closed shapes", () => {
  assert.ok(isWireEvent({ type: "x", response: { usage: null, id: "r", extra: 1 }, other: 1 }));
  assert.ok(isWireEvent({ type: "x", error: { code: null }, item: { type: "t", async: true } }));
  assert.ok(!isWireEvent({ type: 1 }));
  assert.ok(!isWireEvent({ type: "x", item: { name: "n" } }));
  assert.ok(isEmptyArguments({}));
  assert.ok(!isEmptyArguments({ a: 1 }));
  assert.ok(!isEmptyArguments(null));
  assert.ok(isTextFrame("ok") && !isTextFrame(1));
});

test("transport probe records require finite counters and tolerate extra keys", () => {
  const seen: TransportProbeRecord[] = [];
  const record: TransportProbeRecord = {
    stream: "s",
    ts: "t",
    provider: "p",
    model: "m",
    continuation: "c",
    previousResponseId: false,
    fullInputItemCount: 1,
    sentInputItemCount: 1,
  };
  const key = Symbol.for("choco-pi.transport-probe");
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: { publish: (item: TransportProbeRecord) => seen.push(item) },
  });
  try {
    publishTransportProbe(record);
    publishTransportProbe({ ...record, fullInputItemCount: Number.NaN });
    assert.equal(seen.length, 1);
  } finally {
    Reflect.deleteProperty(globalThis, key);
  }
});

test("pi-schema enum parameters (no type keyword) serialise and stay strict-convertible", () => {
  const model: Model<"openai-codex-responses"> = {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 100_000,
  };
  const parameters = obj({ mode: oneOf(["a", "b"]), note: str() });
  const transcript = normalizeContext({
    systemPrompt: "s",
    tools: [{ name: "pick", description: "Pick", parameters }],
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
  });
  const body = buildRequestBody(model, transcript);
  assert.match(JSON.stringify(body.tools), /"enum":\["a","b"\]/);
  const strict = makeStrictJsonSchema(parameters);
  assert.deepEqual(strict["required"], ["mode", "note"]);
  assert.equal(strict["additionalProperties"], false);
});
