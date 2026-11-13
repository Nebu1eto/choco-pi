import assert from "node:assert/strict";
import test from "node:test";

import { type JsonObject, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  bindSessionProjection,
  capturesFor,
  createCapturingStreamSimple,
  recentResponsesFor,
  releaseSessionCaptures,
} from "../src/anthropic/capture.ts";
import { arbitrationIntent } from "../src/background/arbitration.ts";
import { thresholdLane } from "../src/background-host/owner-core.ts";
import { manualLanes } from "../src/background-host/routes.ts";
import {
  type CompactCommandHost,
  installCompactCommandBridge,
  liveCompactCommandDefers,
  releaseCompactCommandBridge,
} from "../src/background-host/host-command.ts";

const CAPTURE_MODEL: Model<"anthropic-messages"> = {
  id: "claude-haiku-5-5",
  name: "Synthetic Haiku",
  api: "anthropic-messages",
  provider: "review-fixes",
  baseUrl: "https://review-fixes.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4_096,
};

type Frame = JsonObject & { readonly type: string };

function anthropicText(text: string): Response {
  const frames: Frame[] = [
    {
      type: "message_start",
      message: {
        id: "review",
        type: "message",
        role: "assistant",
        model: CAPTURE_MODEL.id,
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

test("manual arbitration compares instructions symmetrically; automatic triggers take any candidate", () => {
  assert.equal(arbitrationIntent("ready", { reason: "manual" }, undefined), "adopt");
  assert.equal(arbitrationIntent("ready", { reason: "manual" }, "focus"), "discard-instructions");
  assert.equal(
    arbitrationIntent("ready", { reason: "manual", customInstructions: "focus" }, "focus"),
    "adopt",
  );
  assert.equal(
    arbitrationIntent("ready", { reason: "manual", customInstructions: "focus" }, undefined),
    "discard-instructions",
  );
  assert.equal(arbitrationIntent("ready", { reason: "threshold" }, "focus"), "adopt");
  assert.equal(arbitrationIntent("ready", { reason: "idle" }, "focus"), "adopt");
  assert.equal(arbitrationIntent("preparing", { reason: "threshold" }), "await-outstanding");
  assert.equal(arbitrationIntent("queued", { reason: "threshold" }), "await-outstanding");
  assert.equal(arbitrationIntent("preparing", { reason: "overflow" }), "cancel-overflow");
});

test("the typed /compact bridge keeps every live registration and releases only its own", () => {
  const root = async (host: CompactCommandHost): Promise<boolean> =>
    host.session.sessionId === "root";
  const child = async (): Promise<boolean> => false;
  installCompactCommandBridge(root);
  installCompactCommandBridge(child);
  try {
    assert.equal(liveCompactCommandDefers(), 2, "both registrations are live");
    releaseCompactCommandBridge(child);
    assert.equal(liveCompactCommandDefers(), 1, "the child's departure leaves the root's");
  } finally {
    releaseCompactCommandBridge(root);
    releaseCompactCommandBridge(child);
  }
});
test("the threshold route falls back from an Anthropic lane that cannot serve to the text lane", () => {
  const idle = { ownerKey: "k", ownerGeneration: 1, state: "idle" as const };
  const lanes = ["text", "anthropic-native", "codex-native-v2"];
  assert.equal(
    thresholdLane({
      selected: "anthropic-native",
      backendIds: lanes,
      hasAnthropicCapture: true,
      status: idle,
    }),
    "anthropic-native",
  );
  assert.equal(
    thresholdLane({
      selected: "anthropic-native",
      backendIds: lanes,
      hasAnthropicCapture: false,
      status: idle,
    }),
    "text",
    "no wire capture yet",
  );
  const refused = {
    ...idle,
    state: "failed" as const,
    backendId: "anthropic-native",
    reason: "no-legal-cut" as const,
  };
  assert.equal(
    thresholdLane({
      selected: "anthropic-native",
      backendIds: lanes,
      hasAnthropicCapture: true,
      status: refused,
    }),
    "text",
    "the Anthropic lane just refused the cut",
  );
  const codexRefused = { ...refused, backendId: "codex-native-v2" };
  assert.equal(
    thresholdLane({
      selected: "codex-native-v2",
      backendIds: lanes,
      hasAnthropicCapture: true,
      status: codexRefused,
    }),
    "codex-native-v2",
    "a Codex-owned model never yields to text; Codex's handler owns it",
  );
  const throttled = { ...refused, reason: "429" as const };
  assert.equal(
    thresholdLane({
      selected: "anthropic-native",
      backendIds: lanes,
      hasAnthropicCapture: true,
      status: throttled,
    }),
    "anthropic-native",
    "a transport failure retries the same lane after its cooldown",
  );
  assert.equal(
    thresholdLane({
      selected: "anthropic-native",
      backendIds: ["anthropic-native"],
      hasAnthropicCapture: false,
      status: idle,
    }),
    "anthropic-native",
    "no text lane to fall back to",
  );
  assert.equal(
    thresholdLane({
      selected: "anthropic-native",
      backendIds: lanes,
      hasAnthropicCapture: true,
      anthropicDisabled: true,
      status: idle,
    }),
    "text",
    "a replay-disabled Anthropic lane yields to text even with a capture",
  );
});
test("manual lanes: text and Anthropic owners keep their lanes, a Codex owner gets none", () => {
  const lanes = ["text", "anthropic-native", "codex-native-v2"];
  const core = (backendId: string | undefined) => ({
    backendId,
    backendIds: lanes,
    sessionId: "manual-lanes-no-capture",
    scope: {
      provider: "anthropic",
      model: "claude-test",
      baseUrl: "https://api.anthropic.com",
    },
  });
  assert.deepEqual(manualLanes(core("text")), ["text"]);
  assert.deepEqual(manualLanes(core("text"), "focus"), ["text"]);
  // No Anthropic capture for this session: the documented text fallback stays.
  assert.deepEqual(manualLanes(core("anthropic-native")), ["text"]);
  assert.deepEqual(manualLanes(core("anthropic-native"), "focus"), ["text"]);
  assert.deepEqual(manualLanes(core("codex-native-v2")), [], "Codex's foreground handler owns it");
  assert.deepEqual(manualLanes(core("codex-native-v2"), "focus"), []);
  assert.deepEqual(manualLanes(core(undefined)), [], "xAI server-side or no lane");
});

test("manual lanes over real captures: non-200 only, usable, disabled, and with instructions", async () => {
  const sessionId = "review-fixes-manual-lanes";
  const scope = {
    provider: CAPTURE_MODEL.provider,
    model: CAPTURE_MODEL.id,
    baseUrl: CAPTURE_MODEL.baseUrl,
  };
  const manager = SessionManager.inMemory("/review-fixes");
  manager.appendMessage({ role: "user", content: "REVIEW-PROMPT", timestamp: 0 });
  const unbind = bindSessionProjection(sessionId, () => manager.buildSessionProjection().entries);
  const statuses: number[] = [];
  const stream = createCapturingStreamSimple({
    fetch: async () => (statuses.shift() === 200 ? anthropicText("REVIEW-OK") : overloaded()),
  });
  const context = normalizeContext({
    messages: [{ role: "user", content: "REVIEW-PROMPT", timestamp: 0 }],
  });
  const send = async (status: number): Promise<void> => {
    statuses.push(status);
    const options = { apiKey: "review-non-secret-placeholder", sessionId };
    for await (const event of stream(CAPTURE_MODEL, context, options)) {
      if (event.type === "error") break;
    }
  };
  let disabled = false;
  const core = {
    backendId: "anthropic-native",
    backendIds: ["text", "anthropic-native", "codex-native-v2"],
    sessionId,
    scope,
    anthropicDisabled: () => disabled,
  };
  try {
    // The host's retry burst on a failing request: four non-200 answers, nothing usable.
    for (let attempt = 0; attempt < 4; attempt++) await send(529);
    assert.equal(capturesFor(sessionId).length, 0);
    assert.equal(recentResponsesFor(sessionId).length, 4, "kept for diagnostics only");
    assert.deepEqual(manualLanes(core), ["text"], "non-200 captures are not usable");
    await send(200);
    assert.deepEqual(manualLanes(core), ["anthropic-native", "text"]);
    // D9: the Anthropic lane applies `/compact <focus>` itself.
    assert.deepEqual(manualLanes(core, "focus"), ["anthropic-native", "text"]);
    // A later non-200 burst does not evict the usable capture.
    for (let attempt = 0; attempt < 4; attempt++) await send(529);
    assert.deepEqual(manualLanes(core), ["anthropic-native", "text"]);
    disabled = true;
    assert.deepEqual(manualLanes(core), ["text"], "a replay-disabled lane is skipped");
    assert.deepEqual(manualLanes(core, "focus"), ["text"]);
  } finally {
    unbind();
    releaseSessionCaptures(sessionId);
  }
});
