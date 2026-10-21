/**
 * xAI auth failures and the auth cooldown (D10): a compact 401 surfaces as a
 * cancel; a compaction while the gate still cools down after it falls back to
 * the local summarizer with an `auth-cooling` notice (no credential failed
 * now), unless an xAI checkpoint is committed, where the opaque guard
 * cancels instead. The auth cooldown is `min(cooldownMs, 300_000)` and never
 * doubles.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createXaiCapabilityGate } from "../src/xai/capability.ts";
import { isXaiDetails } from "../src/xai/details.ts";
import {
  compactionsOf,
  compactResponse,
  createXaiRig,
  recordingFetch,
  textForeground,
  XAI_MODEL,
} from "./xai-rig.ts";

const DEFAULT_COOLDOWN_MS = 60_000;

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: { message: "invalid credentials" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function manualClock() {
  let time = 1_000_000;
  return {
    now: () => time,
    setTimer: () => () => {},
    advance(ms: number) {
      time += ms;
    },
  };
}

const COOLING = /not used for this compaction \(auth-cooling\)/u;

test(
  "compact 401 cancels; inside the cooldown the local summarizer answers with an auth-cooling notice",
  { timeout: 30_000 },
  async () => {
    const clock = manualClock();
    const foreground = textForeground();
    const lane = recordingFetch(() => unauthorized());
    const rig = await createXaiRig({ foreground, lane, clock });
    try {
      await rig.session.prompt("XR-GO");
      await assert.rejects(rig.session.compact(), /Compaction cancelled/u);
      assert.equal(lane.sent.length, 1);
      assert.ok(rig.notices.some((notice) => /credentials \(auth\)/u.test(notice)));

      clock.advance(DEFAULT_COOLDOWN_MS - 1);
      const result = await rig.session.compact();
      assert.equal(lane.sent.length, 1, "no compact request inside the cooldown");
      assert.match(result.summary, /XR-LOCAL-SUMMARY/u);
      assert.equal(rig.notices.filter((notice) => COOLING.test(notice)).length, 1);
      const cooling = rig
        .records()
        .filter((record) => record.event === "fallback" && record.detail === "auth-cooling");
      assert.equal(cooling.length, 1);
      assert.equal(cooling[0]?.reason, "cooldown");
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "the auth cooldown ends after cooldownMs and does not double on a repeated 401",
  { timeout: 30_000 },
  async () => {
    const clock = manualClock();
    const foreground = textForeground();
    const lane = recordingFetch(() => unauthorized());
    const rig = await createXaiRig({ foreground, lane, clock });
    try {
      await rig.session.prompt("XR-GO");
      await assert.rejects(rig.session.compact(), /Compaction cancelled/u);
      clock.advance(DEFAULT_COOLDOWN_MS + 1);
      await assert.rejects(rig.session.compact(), /Compaction cancelled/u);
      assert.equal(lane.sent.length, 2, "the cooldown ended: the lane was asked again");
      clock.advance(DEFAULT_COOLDOWN_MS + 1);
      await assert.rejects(rig.session.compact(), /Compaction cancelled/u);
      assert.equal(lane.sent.length, 3, "a repeated auth failure does not double the cooldown");
    } finally {
      await rig.dispose();
    }
  },
);

test("the auth cooldown is capped at 300 000 ms whatever cooldownMs is", () => {
  let time = 0;
  const gate = createXaiCapabilityGate({ cooldownMs: 3_600_000, now: () => time });
  const scope = {
    provider: XAI_MODEL.provider,
    model: XAI_MODEL.id,
    baseUrl: XAI_MODEL.baseUrl,
    authMode: "api-key" as const,
  };
  gate.recordFailure(scope, "auth");
  time = 299_999;
  assert.deepEqual(gate.check(scope), { supported: false, reason: "auth" });
  time = 300_000;
  assert.deepEqual(gate.check(scope), { supported: true });
  gate.recordFailure(scope, "auth");
  time = 600_000;
  assert.deepEqual(gate.check(scope), { supported: true }, "a second auth failure does not double");
});

test(
  "with a committed xAI checkpoint the guard cancels instead of the cooling fallback",
  { timeout: 30_000 },
  async () => {
    const clock = manualClock();
    const foreground = textForeground();
    const lane = recordingFetch((index) => (index === 0 ? compactResponse() : unauthorized()));
    const rig = await createXaiRig({ foreground, lane, clock });
    try {
      await rig.session.prompt("XR-GO");
      await rig.session.compact();
      const checkpoint = compactionsOf(rig.manager).at(-1);
      assert.ok(checkpoint && isXaiDetails(checkpoint.details));
      await rig.session.prompt("XR-MORE");
      await assert.rejects(rig.session.compact(), /Compaction cancelled/u);
      assert.equal(lane.sent.length, 2);
      const summariesBefore = foreground.sent.length;
      await assert.rejects(rig.session.compact(), /Compaction cancelled/u);
      assert.equal(lane.sent.length, 2, "still cooling");
      assert.equal(foreground.sent.length, summariesBefore, "no local summary over the checkpoint");
      assert.ok(rig.notices.some((notice) => COOLING.test(notice)));
      assert.ok(rig.notices.some((notice) => /opaque xai server-side record/u.test(notice)));
      assert.equal(compactionsOf(rig.manager).at(-1)?.id, checkpoint.id);
    } finally {
      await rig.dispose();
    }
  },
);
