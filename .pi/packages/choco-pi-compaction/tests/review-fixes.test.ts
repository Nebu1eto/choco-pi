import assert from "node:assert/strict";
import test from "node:test";

import { arbitrationIntent } from "../src/background/arbitration.ts";
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
