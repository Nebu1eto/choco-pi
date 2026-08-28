import assert from "node:assert/strict";
import test from "node:test";
import type { Context, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { buildRequestBody } from "../src/providers/openai-codex/request-body.ts";

const MODEL: Model<"openai-codex-responses"> = {
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

const CONTEXT: Context = {
  systemPrompt: "Keep the request prefix stable.",
  messages: [{ role: "user", content: "Inspect the request.", timestamp: 1 }],
  tools: [
    {
      name: "zeta",
      description: "Runs after alpha alphabetically but first by registration.",
      parameters: Type.Object({ value: Type.String() }),
    },
    {
      name: "alpha",
      description: "Runs before zeta alphabetically but second by registration.",
      parameters: Type.Object({ count: Type.Number() }),
    },
  ],
};

test("buildRequestBody keeps session cache identity and request ordering stable", () => {
  const sessionId = `session-${"😀".repeat(80)}`;
  const expectedCacheKey = Array.from(sessionId).slice(0, 64).join("");

  const first = buildRequestBody(MODEL, CONTEXT, { sessionId });
  const second = buildRequestBody(MODEL, CONTEXT, { sessionId });

  assert.equal(first.prompt_cache_key, expectedCacheKey);
  assert.equal(second.prompt_cache_key, expectedCacheKey);
  assert.deepEqual(first.client_metadata, { session_id: sessionId, thread_id: sessionId });
  assert.deepEqual(first, second);

  const firstJson = JSON.stringify(first);
  assert.equal(firstJson, JSON.stringify(second));
  assert.ok(firstJson.indexOf('"instructions"') < firstJson.indexOf('"tools"'));
  assert.ok(firstJson.indexOf('"name":"zeta"') < firstJson.indexOf('"name":"alpha"'));
});

test("buildRequestBody omits unsupported prompt cache retention", () => {
  const previous = process.env.PI_CACHE_RETENTION;
  process.env.PI_CACHE_RETENTION = "long";
  try {
    const body = buildRequestBody(MODEL, CONTEXT, { sessionId: "session-stable" });
    assert.equal("prompt_cache_retention" in body, false);
  } finally {
    if (previous === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = previous;
  }
});
