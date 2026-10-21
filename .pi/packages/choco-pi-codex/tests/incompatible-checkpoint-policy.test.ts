import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import {
  assertCodexRequestAllowed,
  recordCodexRequestDecision,
} from "../src/extension/background-compaction.ts";
import { createOpenAICodexProviderStream } from "../src/providers/openai-codex-custom-provider.ts";
import { cleanupOpenAICodexTransportSession } from "../src/providers/openai-codex/transport-cleanup.ts";

const model: Model<"openai-codex-responses"> = {
  id: "gpt-6-luna",
  name: "Fixture",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 2048,
};

function tokenFor(id: string): string {
  return `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.fixture`;
}

function completed(): Response {
  const event = {
    type: "response.completed",
    response: {
      id: "fixture-response",
      status: "completed",
      output: [],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
      },
    },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function send(sessionId: string, fetch: typeof globalThis.fetch) {
  return createOpenAICodexProviderStream(
    model,
    normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }),
    { apiKey: tokenFor("fixture-account"), sessionId, transport: "sse", fetch, maxRetries: 0 },
    // The registration's prepared-payload hook, as register.ts installs it.
    { useResponsesLite: () => false, onPreparedPayload: assertCodexRequestAllowed },
  ).result();
}

test("a refused request fails before any transport call; the next request decides afresh", async () => {
  const sessionId = `refusal-${Date.now()}`;
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    return completed();
  };
  try {
    recordCodexRequestDecision(sessionId, "compaction cancelled: fixture exits text");
    const refused = await send(sessionId, fetch);
    assert.equal(refused.stopReason, "error");
    assert.equal(refused.errorMessage, "compaction cancelled: fixture exits text");
    assert.equal(calls, 0, "no transport call for a refused request");

    // The refusal was consumed; an allowed decision sends normally.
    recordCodexRequestDecision(sessionId, undefined);
    const allowed = await send(sessionId, fetch);
    assert.equal(allowed.stopReason, "stop");
    assert.equal(calls, 1);
  } finally {
    recordCodexRequestDecision(sessionId, undefined);
    cleanupOpenAICodexTransportSession(sessionId);
  }
});

test("a refusal for one session never blocks another session's request", async () => {
  const refusedSession = `refused-${Date.now()}`;
  const otherSession = `other-${Date.now()}`;
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    return completed();
  };
  try {
    recordCodexRequestDecision(refusedSession, "refused");
    const other = await send(otherSession, fetch);
    assert.equal(other.stopReason, "stop");
    assert.equal(calls, 1);
  } finally {
    recordCodexRequestDecision(refusedSession, undefined);
    cleanupOpenAICodexTransportSession(refusedSession);
    cleanupOpenAICodexTransportSession(otherSession);
  }
});
