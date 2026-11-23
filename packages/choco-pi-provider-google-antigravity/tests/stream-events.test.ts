import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessageEvent, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { formatAntigravityErrorMessage, parseAntigravityErrorMessage } from "../src/errors.ts";
import { streamGoogleAntigravityWith } from "../src/stream/index.ts";
import { SseParser } from "../src/stream/sse.ts";
import {
  API_KEY,
  CAPTURE_SIGNATURE,
  SIG_A,
  SIG_B,
  collect,
  piFetch,
  sseEvent,
  sseResponse,
  streamFixture,
  terminalEvents,
  testModel,
  transcript,
} from "./fixtures/stream/harness.ts";
import { fakeFetch } from "./helpers.ts";

const context = transcript({
  systemPrompt: "sys",
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
});

async function replay(
  pieces: readonly string[],
  model: Model<"google-generative-ai"> = testModel(),
) {
  const fake = fakeFetch(() => sseResponse(pieces));
  const options: SimpleStreamOptions = { apiKey: API_KEY, reasoning: "low", fetch: piFetch(fake) };
  return collect(streamGoogleAntigravityWith(model, context, options, { env: {} }));
}

function summary(events: readonly AssistantMessageEvent[]): string[] {
  return events.map((event) => {
    if (event.type === "text_delta" || event.type === "thinking_delta") {
      return `${event.type}:${event.contentIndex}:${event.delta}`;
    }
    if (event.type === "done") return `done:${event.reason}`;
    if (event.type === "error") return `error:${event.reason}`;
    if (event.type === "start") return "start";
    return `${event.type}:${event.contentIndex}`;
  });
}

describe("SSE framing", () => {
  it("handles CRLF split across chunks, multi-line data, comments and a missing final blank line", () => {
    const parser = new SseParser();
    const events = [
      ...parser.push(': keepalive\r\ndata: {"a":\r'),
      ...parser.push("\ndata: 1}\r\n\r"),
      ...parser.push("\nevent: x\ndata: two\n\ndata: last"),
      ...parser.end(),
    ];
    assert.deepEqual(events, [
      { event: undefined, data: '{"a":\n1}' },
      { event: "x", data: "two" },
      { event: undefined, data: "last" },
    ]);
  });
});

describe("stream normalization", () => {
  it("replays the captured SSE, keeping the signature from the empty final part", async () => {
    const { events, result } = await replay([await streamFixture("capture-response.sse")]);
    assert.deepEqual(summary(events), [
      "start",
      "text_start:0",
      "text_delta:0:OK",
      "text_end:0",
      "done:stop",
    ]);
    assert.deepEqual(result.content, [
      { type: "text", text: "OK", textSignature: CAPTURE_SIGNATURE },
    ]);
    assert.equal(result.stopReason, "stop");
    assert.equal(result.rawStopReason, "STOP");
    assert.equal(result.provider, "google");
    assert.equal(result.api, "google-generative-ai");
    assert.equal(result.model, "gemini-3.8-flash");
    assert.equal(result.responseModel, "gemini-3.8-flash");
    assert.equal(result.responseId, "redacted-response-id");
    assert.equal(result.providerThinkingLevel, "low");
    const { cost, ...tokens } = result.usage;
    assert.deepEqual(tokens, {
      input: 8697,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 8698,
    });
    assert.equal(cost.total, 0);
  });

  it("merges split thought and text deltas across arbitrary chunk boundaries", async () => {
    const body = [
      sseEvent({
        candidates: [{ content: { role: "model", parts: [{ text: "Let me", thought: true }] } }],
      }),
      sseEvent({
        candidates: [
          { content: { parts: [{ text: " think", thought: true, thoughtSignature: SIG_A }] } },
        ],
      }),
      sseEvent({ candidates: [{ content: { parts: [{ text: "Hel" }] } }] }),
      sseEvent({ candidates: [{ content: { parts: [{ text: "lo" }] } }], usageMetadata: {} }),
      sseEvent({
        candidates: [
          { content: { parts: [{ text: "", thoughtSignature: SIG_B }] }, finishReason: "STOP" },
        ],
      }),
    ].join("");
    const pieces = [body.slice(0, 7), body.slice(7, 40)];
    for (let index = 40; index < body.length; index += 13)
      pieces.push(body.slice(index, index + 13));
    const { events, result } = await replay(pieces);
    assert.deepEqual(summary(events), [
      "start",
      "thinking_start:0",
      "thinking_delta:0:Let me",
      "thinking_delta:0: think",
      "thinking_end:0",
      "text_start:1",
      "text_delta:1:Hel",
      "text_delta:1:lo",
      "text_end:1",
      "done:stop",
    ]);
    assert.deepEqual(result.content, [
      { type: "thinking", thinking: "Let me think", thinkingSignature: SIG_A },
      { type: "text", text: "Hello", textSignature: SIG_B },
    ]);
  });

  it("starts a new block instead of overwriting a different signature", async () => {
    const { result } = await replay([
      sseEvent({ candidates: [{ content: { parts: [{ text: "a", thoughtSignature: SIG_A }] } }] }),
      sseEvent({
        candidates: [
          { content: { parts: [{ text: "", thoughtSignature: SIG_B }] }, finishReason: "STOP" },
        ],
      }),
    ]);
    assert.deepEqual(result.content, [
      { type: "text", text: "a", textSignature: SIG_A },
      { type: "text", text: "", textSignature: SIG_B },
    ]);
  });

  it("emits tool calls with signatures, keeps a trailing signature-only part, and ends in toolUse", async () => {
    const { events, result } = await replay([
      sseEvent({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: "read_file", args: { path: "/a" } },
                  thoughtSignature: SIG_A,
                },
                { functionCall: { name: "read_file", args: { path: "/b" } } },
              ],
            },
          },
        ],
      }),
      sseEvent({
        candidates: [
          { content: { parts: [{ text: "", thoughtSignature: SIG_B }] }, finishReason: "STOP" },
        ],
      }),
    ]);
    assert.equal(result.stopReason, "toolUse");
    assert.deepEqual(
      summary(events).filter((entry) => entry.startsWith("toolcall")),
      [
        "toolcall_start:0",
        "toolcall_delta:0",
        "toolcall_end:0",
        "toolcall_start:1",
        "toolcall_delta:1",
        "toolcall_end:1",
      ],
    );
    const [first, second, trailing] = result.content;
    assert.equal(first?.type, "toolCall");
    assert.equal(second?.type, "toolCall");
    if (first?.type !== "toolCall" || second?.type !== "toolCall") return;
    assert.deepEqual(first.arguments, { path: "/a" });
    assert.equal(first.thoughtSignature, SIG_A);
    assert.equal(second.thoughtSignature, undefined);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(trailing, { type: "text", text: "", textSignature: SIG_B });
  });

  it("keeps backend tool-call ids for Claude and generates valid unique ones when absent or duplicated", async () => {
    const { result } = await replay(
      [
        sseEvent({
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: "read_file", args: {}, id: "toolu_01" } },
                  { functionCall: { name: "read_file", args: {}, id: "toolu_01" } },
                  { functionCall: { name: "run.command", args: {} } },
                ],
              },
              finishReason: "STOP",
            },
          ],
        }),
      ],
      testModel("claude-opus-5-5"),
    );
    const ids = result.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
    assert.equal(ids[0], "toolu_01");
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,64}$/u);
  });

  it("maps usage with cache and thoughts and prices it with Pi's calculator", async () => {
    const priced = { ...testModel(), cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } };
    const { result } = await replay(
      [
        sseEvent({
          candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "MAX_TOKENS" }],
          usageMetadata: {
            promptTokenCount: 1000,
            cachedContentTokenCount: 400,
            candidatesTokenCount: 10,
            thoughtsTokenCount: 50,
            totalTokenCount: 1060,
          },
        }),
      ],
      priced,
    );
    assert.equal(result.stopReason, "length");
    assert.equal(result.usage.input, 600);
    assert.equal(result.usage.output, 60);
    assert.equal(result.usage.cacheRead, 400);
    assert.equal(result.usage.reasoning, 50);
    assert.equal(result.usage.totalTokens, 1060);
    const close = (actual: number, expected: number) =>
      assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
    close(result.usage.cost.input, 600 / 1e6);
    close(result.usage.cost.output, 120 / 1e6);
    close(result.usage.cost.cacheRead, 200 / 1e6);
    close(result.usage.cost.total, 920 / 1e6);
  });

  it("accepts bare (unwrapped) response chunks", async () => {
    const { result } = await replay([
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "bare" }] }, finishReason: "STOP" }] })}\n\n`,
    ]);
    assert.deepEqual(result.content, [{ type: "text", text: "bare" }]);
  });

  for (const [name, data] of [
    ["non-JSON data", "{not json"],
    ["an object with neither response nor error", '{"foo":1}'],
    ["a response that breaks the schema", '{"response":{"candidates":"nope"}}'],
  ] as const) {
    it(`fails with malformed_response on ${name}`, async () => {
      const { events, result } = await replay([
        sseEvent({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }),
        `data: ${data}\n\n`,
      ]);
      assert.equal(terminalEvents(events).length, 1);
      assert.equal(result.stopReason, "error");
      assert.equal(
        parseAntigravityErrorMessage(result.errorMessage ?? "")?.kind,
        "malformed_response",
      );
    });
  }

  it("treats a stream that ends without a finish reason as a retryable network error", async () => {
    const { result } = await replay([
      sseEvent({ candidates: [{ content: { parts: [{ text: "cut" }] } }] }),
    ]);
    assert.equal(result.stopReason, "error");
    assert.equal(parseAntigravityErrorMessage(result.errorMessage ?? "")?.kind, "network");
    assert.equal(isRetryableAssistantError(result), true);
  });

  it("reports a safety stop as a non-retryable invalid_request", async () => {
    const { result } = await replay([
      sseEvent({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "SAFETY" }] }),
    ]);
    assert.equal(result.stopReason, "error");
    assert.equal(result.rawStopReason, "SAFETY");
    assert.equal(
      result.errorMessage,
      formatAntigravityErrorMessage({
        kind: "invalid_request",
        detail: "the model stopped with finish reason SAFETY",
      }),
    );
    assert.equal(isRetryableAssistantError(result), false);
  });
});
