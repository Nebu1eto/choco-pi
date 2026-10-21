/**
 * Usable capture ring (D8): only an HTTP 200 answer to a mapped request is a
 * usable capture. The host's retries of a failing request (Pi's default
 * `maxRetries` is 3, so four non-200 answers per prompt) go to a separate
 * diagnostics ring and never evict the last usable capture; lane selection
 * consults the usable ring for the owner's own scope.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { type JsonObject, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { hasUsableCapture } from "../src/anthropic/backend.ts";
import {
  bindSessionProjection,
  capturesFor,
  createCapturingStreamSimple,
  recentResponsesFor,
  releaseSessionCaptures,
} from "../src/anthropic/capture.ts";
import type { CoordinatorStatus, ProviderScope } from "../src/background/contract.ts";
import { thresholdLane } from "../src/background-host/owner-core.ts";
import { manualLanes } from "../src/background-host/routes.ts";

const API_KEY = "capture-ring-non-secret-placeholder-key";
const MODEL: Model<"anthropic-messages"> = {
  id: "claude-haiku-5-5",
  name: "Synthetic Haiku",
  api: "anthropic-messages",
  provider: "capture-ring",
  baseUrl: "https://capture-ring.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4_096,
};
const SCOPE: ProviderScope = {
  provider: MODEL.provider,
  model: MODEL.id,
  baseUrl: MODEL.baseUrl,
};
const LANES = ["anthropic-native", "text"];
const IDLE: CoordinatorStatus = { ownerKey: "o", ownerGeneration: 1, state: "idle" };

type Frame = JsonObject & { readonly type: string };

function textReply(text: string): Response {
  const frames: Frame[] = [
    {
      type: "message_start",
      message: {
        id: "ring",
        type: "message",
        role: "assistant",
        model: MODEL.id,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  const body = frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  return new Response(body.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function overloaded(): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "synthetic" } }),
    { status: 529, headers: { "content-type": "application/json" } },
  );
}

/** A session with one projected user message, and a captured stream answering per `respond`. */
function rig(sessionId: string, respond: (index: number) => Response) {
  const manager = SessionManager.inMemory("/capture-ring");
  manager.appendMessage({ role: "user", content: "RING-PROMPT", timestamp: 0 });
  const unbind = bindSessionProjection(sessionId, () => manager.buildSessionProjection().entries);
  let index = 0;
  const stream = createCapturingStreamSimple({
    fetch: async () => respond(index++),
  });
  const context = normalizeContext({
    messages: [{ role: "user", content: "RING-PROMPT", timestamp: 0 }],
  });
  return {
    async send(model: Model<"anthropic-messages"> = MODEL): Promise<void> {
      for await (const event of stream(model, context, { apiKey: API_KEY, sessionId })) {
        if (event.type === "error") break;
      }
    },
    dispose(): void {
      unbind();
      releaseSessionCaptures(sessionId);
    },
  };
}

test("four non-200 answers (host retry burst) do not evict the last usable capture", async () => {
  const sessionId = "capture-ring-burst";
  const host = rig(sessionId, (index) => (index === 0 ? textReply("RING-OK") : overloaded()));
  try {
    await host.send();
    const [usable] = capturesFor(sessionId);
    assert.ok(usable?.mapping, "the 200 answer is a mapped, usable capture");
    assert.equal(usable.status, 200);
    for (let attempt = 0; attempt < 4; attempt++) await host.send();
    assert.deepEqual(
      capturesFor(sessionId).map((capture) => capture.sequence),
      [usable.sequence],
      "the retries left the usable ring unchanged",
    );
    const responses = recentResponsesFor(sessionId);
    assert.deepEqual(
      responses.map((response) => response.status),
      [529, 529, 529, 529],
      "the retries are kept for diagnostics only",
    );
    assert.equal(hasUsableCapture(sessionId, SCOPE), true);
    assert.equal(
      thresholdLane({
        selected: "anthropic-native",
        backendIds: LANES,
        hasAnthropicCapture: hasUsableCapture(sessionId, SCOPE),
        status: IDLE,
      }),
      "anthropic-native",
    );
    assert.deepEqual(
      manualLanes({ backendId: "anthropic-native", backendIds: LANES, sessionId, scope: SCOPE }),
      ["anthropic-native", "text"],
    );
  } finally {
    host.dispose();
  }
});

test("the diagnostics ring is bounded at eight responses per session", async () => {
  const sessionId = "capture-ring-bounded";
  const host = rig(sessionId, () => overloaded());
  try {
    for (let attempt = 0; attempt < 11; attempt++) await host.send();
    const responses = recentResponsesFor(sessionId);
    assert.equal(responses.length, 8);
    const sequences = responses.map((response) => response.sequence);
    assert.deepEqual(
      sequences,
      [...sequences].sort((a, b) => a - b),
      "oldest first",
    );
    assert.equal(capturesFor(sessionId).length, 0);
  } finally {
    host.dispose();
  }
  assert.equal(recentResponsesFor(sessionId).length, 0, "released with the session");
});

test("a 200 capture of another model is not usable for this owner's scope", async () => {
  const sessionId = "capture-ring-other-model";
  const host = rig(sessionId, () => textReply("RING-OTHER"));
  try {
    await host.send({ ...MODEL, id: "claude-other-5-5" });
    assert.equal(capturesFor(sessionId).length, 1, "captured under the other model");
    assert.equal(hasUsableCapture(sessionId, SCOPE), false);
    assert.equal(
      hasUsableCapture(sessionId, { ...SCOPE, model: "claude-other-5-5" }),
      true,
      "usable for its own scope",
    );
    assert.deepEqual(
      manualLanes({ backendId: "anthropic-native", backendIds: LANES, sessionId, scope: SCOPE }),
      ["text"],
    );
  } finally {
    host.dispose();
  }
});

test("only non-200 captures: manual and threshold work select the text lane", async () => {
  const sessionId = "capture-ring-failing";
  const host = rig(sessionId, () => overloaded());
  try {
    for (let attempt = 0; attempt < 4; attempt++) await host.send();
    assert.equal(capturesFor(sessionId).length, 0);
    assert.equal(hasUsableCapture(sessionId, SCOPE), false);
    assert.deepEqual(
      manualLanes({ backendId: "anthropic-native", backendIds: LANES, sessionId, scope: SCOPE }),
      ["text"],
    );
    assert.equal(
      thresholdLane({
        selected: "anthropic-native",
        backendIds: LANES,
        hasAnthropicCapture: hasUsableCapture(sessionId, SCOPE),
        status: IDLE,
      }),
      "text",
    );
  } finally {
    host.dispose();
  }
});

test("a session whose Anthropic lane is disabled selects text despite a usable capture", async () => {
  const sessionId = "capture-ring-disabled";
  const host = rig(sessionId, () => textReply("RING-OK"));
  try {
    await host.send();
    assert.equal(hasUsableCapture(sessionId, SCOPE), true);
    assert.deepEqual(
      manualLanes({
        backendId: "anthropic-native",
        backendIds: LANES,
        sessionId,
        scope: SCOPE,
        anthropicDisabled: () => true,
      }),
      ["text"],
    );
    assert.equal(
      thresholdLane({
        selected: "anthropic-native",
        backendIds: LANES,
        hasAnthropicCapture: true,
        anthropicDisabled: true,
        status: IDLE,
      }),
      "text",
    );
  } finally {
    host.dispose();
  }
});
