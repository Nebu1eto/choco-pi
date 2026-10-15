import assert from "node:assert/strict";
import test from "node:test";

import { arbitrationIntent } from "../src/background/arbitration.ts";
import { thresholdLane } from "../src/background-host/owner-core.ts";
import {
  type CompactCommandHost,
  installCompactCommandBridge,
  liveCompactCommandDefers,
  releaseCompactCommandBridge,
} from "../src/background-host/host-command.ts";

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
test("the threshold route falls back from a native lane that cannot serve to the text lane", () => {
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
    backendId: "codex-native-v2",
    reason: "no-legal-cut" as const,
  };
  assert.equal(
    thresholdLane({
      selected: "codex-native-v2",
      backendIds: lanes,
      hasAnthropicCapture: true,
      status: refused,
    }),
    "text",
    "the native lane just refused the cut",
  );
  const throttled = { ...refused, reason: "429" as const };
  assert.equal(
    thresholdLane({
      selected: "codex-native-v2",
      backendIds: lanes,
      hasAnthropicCapture: true,
      status: throttled,
    }),
    "codex-native-v2",
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
});
