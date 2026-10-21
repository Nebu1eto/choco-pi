/**
 * A committed xAI checkpoint across registrations, mode switches and model
 * switches: a new registration over the same session replays it in either
 * mode (the binding follows the committed checkpoint), journals the resume,
 * and guards `/compact` until a turn is captured; a provider rejection that
 * resolves after a model switch rebound the session is stale and never
 * disables server-side, while a fresh one on the new binding does.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { OPAQUE_GUARD_NOTICE } from "../src/opaque-checkpoint.ts";
import { isXaiDetails } from "../src/xai/details.ts";
import type { XaiCompactionMode } from "../src/xai/mode.ts";
import {
  carriesItem,
  compactionsOf,
  compactResponse,
  createXaiRig,
  recordingFetch,
  textForeground,
  textResponse,
  XAI_MODEL,
  XAI_MODEL_B,
} from "./xai-rig.ts";

for (const mode of ["server-side", "choco-pi"] as const satisfies readonly XaiCompactionMode[]) {
  test(
    `new registration in ${mode} mode: guard before a captured turn, then the checkpoint is replayed`,
    { timeout: 30_000 },
    async () => {
      // Under choco-pi mode the binding depends on U-ANTH (bind when the branch's newest compaction is xAI).
      const foreground = textForeground();
      const lane = recordingFetch(() => compactResponse());
      const first = await createXaiRig({ foreground, lane });
      await first.session.prompt("XR-GO");
      await first.session.compact();
      const latest = compactionsOf(first.manager).at(-1);
      assert.ok(latest && isXaiDetails(latest.details));
      const checkpointId = latest.id;
      // One more turn, captured by the first registration only.
      await first.session.prompt("XR-AFTER");
      await first.dispose({ keepDir: true });

      const rig = await createXaiRig({
        foreground,
        lane,
        mode,
        manager: first.manager,
        dir: first.dir,
      });
      try {
        assert.equal(rig.manager.getSessionId(), first.manager.getSessionId());
        const before = foreground.sent.length;
        await assert.rejects(rig.session.compact(), /Compaction cancelled/u);
        assert.equal(foreground.sent.length, before, "no summarizer request");
        assert.equal(lane.sent.length, 1, "no compact request without a capture");
        assert.ok(rig.notices.includes(OPAQUE_GUARD_NOTICE("xai", checkpointId)));
        if (mode === "server-side") {
          const resumed = rig
            .records()
            .filter((record) => record.route === "resume" && record.reason === "no-capture");
          assert.equal(resumed.length, 1);
          assert.equal(resumed[0]?.checkpointEntryId, checkpointId);
        }

        await rig.session.prompt("XR-RESUMED");
        const sent = foreground.sent.at(-1);
        assert.ok(carriesItem(sent), `the item is replayed under ${mode}`);
        assert.equal(sent?.text.includes("xAI server-side compaction checkpoint"), false);
      } finally {
        await rig.dispose();
      }
    },
  );
}

function rejection(): Response {
  return new Response(JSON.stringify({ error: { param: "input[0]", message: "bad item" } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

test(
  "a rejection that resolves after a model switch rebound the session is stale; a fresh one disables",
  { timeout: 30_000 },
  async () => {
    let release: (() => void) | undefined;
    let mode: "answer" | "hold" | "reject" = "answer";
    let called: (() => void) | undefined;
    const foreground = recordingFetch(async () => {
      if (mode === "answer") return textResponse("XR-ANSWER");
      if (mode === "reject") return rejection();
      called?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return rejection();
    });
    const lane = recordingFetch(() => compactResponse());
    const rig = await createXaiRig({ foreground, lane });
    try {
      await rig.session.prompt("XR-GO");
      await rig.session.compact();
      assert.ok(isXaiDetails(compactionsOf(rig.manager).at(-1)?.details));

      mode = "hold";
      const reached = new Promise<void>((resolve) => {
        called = resolve;
      });
      const held = rig.session.prompt("XR-HELD");
      await reached;
      assert.ok(carriesItem(foreground.sent.at(-1)), "the held request was a replay");
      await rig.session.setModel(XAI_MODEL_B);
      release?.();
      await held;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const disables = () => rig.records().filter((record) => record.event === "disable");
      assert.equal(disables().length, 0, "a stale rejection neither disables nor journals");
      assert.equal(
        rig.notices.some((notice) => /off for this session/u.test(notice)),
        false,
      );

      await rig.session.setModel(XAI_MODEL);
      mode = "answer";
      await rig.session.prompt("XR-STILL-ON");
      assert.ok(carriesItem(foreground.sent.at(-1)), "server-side is still on");

      mode = "reject";
      await rig.session.prompt("XR-REJECTED");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(disables().length, 1, "a fresh rejection on the new binding disables once");
      assert.equal(rig.notices.filter((notice) => /off for this session/u.test(notice)).length, 1);
      mode = "answer";
      await rig.session.prompt("XR-AFTER");
      assert.equal(carriesItem(foreground.sent.at(-1)), false, "replay is off");
    } finally {
      await rig.dispose();
    }
  },
);
