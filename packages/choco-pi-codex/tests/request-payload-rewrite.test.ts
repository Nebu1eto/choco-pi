import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import {
  prepareCodexRequestBody,
  prewarmOpenAICodexWebSocket,
} from "../src/providers/openai-codex-custom-provider.ts";
import type { CodexFastModeDecision } from "../src/providers/openai-codex/fast-mode-decision.ts";
import { isResponsesBody, type ResponsesBody } from "../src/providers/openai-codex/types.ts";

const model: Model<"openai-codex-responses"> = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
};

const context = normalizeContext({
  systemPrompt: "Original instructions.",
  messages: [{ role: "user", content: "Original input.", timestamp: 1 }],
});

function apiKey(): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
  ).toString("base64url");
  return `e30.${payload}.signature`;
}

test("prewarm transport receives a full payload-hook replacement with arrays intact", async () => {
  let transported: ResponsesBody | undefined;
  await prewarmOpenAICodexWebSocket(
    model,
    context,
    {
      apiKey: apiKey(),
      sessionId: "replacement-transport",
      transport: "websocket",
      onPayload: (body) => {
        assert.ok(isResponsesBody(body));
        return {
          ...body,
          input: [{ type: "message", content: [{ type: "input_text", text: "Rewritten." }] }],
          include: ["reasoning.encrypted_content"],
          rewrite_marker: { nested: ["kept", { value: 7 }] },
        };
      },
    },
    {
      useResponsesLite: () => false,
      prewarmTransport: async (_url, body) => {
        transported = structuredClone(body);
        return { socketReused: false };
      },
    },
  );

  assert.ok(transported);
  assert.deepEqual(transported.input, [
    { type: "message", content: [{ type: "input_text", text: "Rewritten." }] },
  ]);
  assert.deepEqual(transported.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(transported["rewrite_marker"], { nested: ["kept", { value: 7 }] });
});

test("Responses Lite does not resurrect instructions removed by the payload hook", async () => {
  const body = await prepareCodexRequestBody(
    model,
    context,
    {
      onPayload: (original) => {
        assert.ok(isResponsesBody(original));
        const { instructions: _instructions, ...replacement } = original;
        return {
          ...replacement,
          input: [{ type: "additional_tools", role: "developer", tools: [] }],
        };
      },
    },
    true,
  );

  assert.equal("instructions" in body, false);
  assert.deepEqual(body.input[0], { type: "additional_tools", role: "developer", tools: [] });
  assert.doesNotMatch(JSON.stringify(body), /Original instructions\./);
});

test("frozen fast-mode tier is applied after the payload replacement", async () => {
  const decision: CodexFastModeDecision = Object.freeze({
    sessionId: "replacement-tier",
    requested: true,
    source: "explicit",
    revision: 1,
    supported: true,
    active: true,
    serviceTier: "priority",
  });
  const body = await prepareCodexRequestBody(
    model,
    context,
    {
      fastModeDecision: decision,
      onPayload: (original) => {
        assert.ok(isResponsesBody(original));
        return { ...original, service_tier: "default" };
      },
    },
    false,
  );

  assert.equal(body.service_tier, "priority");
});
