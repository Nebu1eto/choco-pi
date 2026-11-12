import assert from "node:assert/strict";
import test from "node:test";

import { KeyedAsyncExecutionQueue } from "../extensions/agent-browser/lib/runtime-extension.ts";
import {
  getCurrentToolCallAdmission,
  ToolCallAdmissionGate,
} from "../extensions/agent-browser/lib/tool-call-admission.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Mirrors the runtime call shape: preflight may finish out of order, then the call waits
// for its turn, enters the session queue synchronously, and releases its turn.
async function admittedCall(
  queue: KeyedAsyncExecutionQueue,
  preflightMs: number,
  ran: string[],
  label: string,
): Promise<void> {
  const admission = getCurrentToolCallAdmission();
  await delay(preflightMs);
  if (admission) await admission.ready;
  const pending = queue.run("session", undefined, async () => {
    ran.push(label);
  });
  admission?.release();
  await pending;
}

test("sibling calls enter the session queue in call order despite out-of-order preflight", async () => {
  const gate = new ToolCallAdmissionGate();
  const queue = new KeyedAsyncExecutionQueue();
  const ran: string[] = [];
  await Promise.all([
    gate.run(() => admittedCall(queue, 30, ran, "open")),
    gate.run(() => admittedCall(queue, 15, ran, "snapshot")),
    gate.run(() => admittedCall(queue, 0, ran, "fill")),
  ]);
  assert.deepEqual(ran, ["open", "snapshot", "fill"]);
});

test("an early release does not let later calls pass an unreleased earlier call", async () => {
  const gate = new ToolCallAdmissionGate();
  const first = gate.reserve();
  const second = gate.reserve();
  const third = gate.reserve();
  let thirdReady = false;
  void third.ready.then(() => {
    thirdReady = true;
  });
  second.release();
  await delay(5);
  assert.equal(thirdReady, false);
  first.release();
  await third.ready;
  assert.equal(thirdReady, true);
});

test("a call that releases its turn can run nested calls through the same gate", async () => {
  const gate = new ToolCallAdmissionGate();
  const sibling = gate.reserve();
  const nestedLabels: string[] = [];
  const outer = gate.run(async () => {
    const outerAdmission = getCurrentToolCallAdmission();
    assert.ok(outerAdmission);
    outerAdmission.release();
    sibling.release();
    await outerAdmission.gate.run(async () => {
      const nested = getCurrentToolCallAdmission();
      assert.ok(nested);
      assert.notEqual(nested, outerAdmission);
      await nested.ready;
      nestedLabels.push("nested");
    });
  });
  await Promise.race([
    outer,
    delay(1_000).then(() => {
      throw new Error("nested admission deadlocked");
    }),
  ]);
  assert.deepEqual(nestedLabels, ["nested"]);
});

test("a failing call releases its turn", async () => {
  const gate = new ToolCallAdmissionGate();
  await assert.rejects(
    gate.run(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  const next = gate.reserve();
  await next.ready;
  next.release();
});
