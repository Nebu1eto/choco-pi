import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, JsonValue, Message, Tool } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { streamGoogleAntigravityWith } from "../src/stream/index.ts";
import {
  API_KEY,
  SIG_A,
  SIG_B,
  at,
  collect,
  piFetch,
  sentBodies,
  sseEvent,
  sseResponse,
  testModel,
  transcript,
} from "./fixtures/stream/harness.ts";
import { fakeFetch } from "./helpers.ts";

const tools: Tool[] = [
  {
    name: "read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

const signedTurn = [
  sseEvent({
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { text: "Need the file.", thought: true, thoughtSignature: SIG_A },
            { functionCall: { name: "read_file", args: { path: "/a" } }, thoughtSignature: SIG_B },
          ],
        },
        finishReason: "STOP",
      },
    ],
  }),
];

async function sentContents(
  messages: Message[],
  modelId = "gemini-3.8-flash",
  pieces: readonly string[] = [
    sseEvent({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }),
  ],
) {
  const fake = fakeFetch(() => sseResponse(pieces));
  const { result } = await collect(
    streamGoogleAntigravityWith(
      testModel(modelId),
      transcript({ systemPrompt: "sys", tools, messages }),
      { apiKey: API_KEY, reasoning: "low", fetch: piFetch(fake) },
      { env: {} },
    ),
  );
  return { contents: at(sentBodies(fake)[0], "request", "contents"), result };
}

async function signedAssistant(): Promise<AssistantMessage> {
  const { result } = await sentContents(
    [{ role: "user", content: "read /a", timestamp: 1 }],
    "gemini-3.8-flash",
    signedTurn,
  );
  assert.equal(result.stopReason, "toolUse");
  return result;
}

function toolCallId(message: AssistantMessage): string {
  const call = message.content.find((block) => block.type === "toolCall");
  assert.ok(call && call.type === "toolCall");
  return call.id;
}

function toolResult(id: string): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read_file",
    content: [{ type: "text", text: "file body" }],
    isError: false,
    timestamp: 3,
  };
}

function summary(text: string) {
  return { role: "compactionSummary" as const, summary: text, tokensBefore: 1000, timestamp: 0 };
}

function assertNoOrphanCalls(contents: JsonValue | undefined): void {
  assert.ok(Array.isArray(contents));
  assert.equal(at(contents, 0, "role"), "user", "contents must open with a user turn");
  for (let index = 0; index < contents.length; index += 1) {
    if (at(contents, index, "role") !== "model") continue;
    const parts: JsonValue | undefined = at(contents, index, "parts");
    assert.ok(Array.isArray(parts));
    const calls = parts.flatMap((_, part) => {
      const id: JsonValue | undefined = at(parts, part, "functionCall", "id");
      return id === undefined ? [] : [id];
    });
    if (calls.length === 0) continue;
    const answer: JsonValue | undefined = at(contents, index + 1, "parts");
    assert.ok(Array.isArray(answer), `model turn ${index} has no following user turn`);
    const answered = answer.flatMap((_, part) => {
      const id: JsonValue | undefined = at(answer, part, "functionResponse", "id");
      return id === undefined ? [] : [id];
    });
    assert.deepEqual(answered, calls);
  }
}

describe("thought signature replay", () => {
  it("round-trips thinking and tool-call signatures to the same model", async () => {
    const assistant = await signedAssistant();
    assert.equal(assistant.provider, "google");
    assert.equal(assistant.model, "gemini-3.8-flash");
    const id = toolCallId(assistant);
    const { contents } = await sentContents([
      { role: "user", content: "read /a", timestamp: 1 },
      assistant,
      toolResult(id),
    ]);
    assert.deepEqual(at(contents, 1), {
      role: "model",
      parts: [
        { thought: true, text: "Need the file.", thoughtSignature: SIG_A },
        { functionCall: { name: "read_file", args: { path: "/a" }, id }, thoughtSignature: SIG_B },
      ],
    });
    assertNoOrphanCalls(contents);
  });

  it("drops signatures and thinking for a different model or provider", async () => {
    const assistant = await signedAssistant();
    const id = toolCallId(assistant);
    const expectedModelTurn = {
      role: "model",
      parts: [{ functionCall: { name: "read_file", args: { path: "/a" }, id } }],
    };
    const otherModel = await sentContents(
      [{ role: "user", content: "read /a", timestamp: 1 }, assistant, toolResult(id)],
      "gemini-4-neon",
    );
    assert.deepEqual(at(otherModel.contents, 1), expectedModelTurn);

    const otherProvider = await sentContents([
      { role: "user", content: "read /a", timestamp: 1 },
      { ...assistant, provider: "google-vertex" },
      toolResult(id),
    ]);
    assert.deepEqual(at(otherProvider.contents, 1), expectedModelTurn);
  });

  it("keeps signatures when a compacted retained tail starts with a model functionCall turn", async () => {
    const assistant = await signedAssistant();
    const id = toolCallId(assistant);
    const textTurn: AssistantMessage = {
      ...assistant,
      content: [{ type: "text", text: "Done.", textSignature: SIG_A }],
      stopReason: "stop",
    };
    const messages = convertToLlm([
      summary("Earlier work summarized."),
      assistant,
      toolResult(id),
      textTurn,
      { role: "user", content: "continue", timestamp: 5 },
    ]);
    const { contents, result } = await sentContents(messages);
    assert.equal(result.stopReason, "stop");
    assert.ok(Array.isArray(contents));
    assert.deepEqual(
      contents.map((_, index) => at(contents, index, "role")),
      ["user", "model", "user", "model", "user"],
    );
    assert.match(String(at(contents, 0, "parts", 0, "text")), /Earlier work summarized\./u);
    assert.equal(at(contents, 1, "parts", 0, "thoughtSignature"), SIG_A);
    assert.equal(at(contents, 1, "parts", 1, "thoughtSignature"), SIG_B);
    assert.equal(at(contents, 3, "parts", 0, "thoughtSignature"), SIG_A);
    assertNoOrphanCalls(contents);
  });

  it("answers an unanswered retained functionCall so no call is orphaned", async () => {
    const assistant = await signedAssistant();
    const messages = convertToLlm([
      summary("Summary."),
      assistant,
      { role: "user", content: "never mind", timestamp: 5 },
    ]);
    const { contents } = await sentContents(messages);
    assertNoOrphanCalls(contents);
    assert.equal(at(contents, 1, "parts", 1, "thoughtSignature"), SIG_B);
  });
});
