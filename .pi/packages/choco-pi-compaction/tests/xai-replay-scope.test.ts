/**
 * Replay scope (D11) and the request-boundary opaque guard (D2) of the xAI
 * replay, through a real session: a checkpoint replays only on the model
 * that made it; elsewhere an xAI call is refused locally (never disabling
 * server-side), a non-xAI request is published as a pending opaque block for
 * capturing transports, and authorized loss sends the placeholder.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { OPAQUE_GUARD_NOTICE } from "../src/opaque-checkpoint.ts";
import { pendingOpaqueBlock } from "../src/opaque-guard.ts";
import { XAI_TRANSPORT_REFUSAL_PREFIX, xaiTransportRefusals } from "../src/xai/capture.ts";
import { isXaiDetails } from "../src/xai/details.ts";
import {
  carriesItem,
  compactionsOf,
  compactResponse,
  createXaiRig,
  OTHER_MODEL,
  recordingFetch,
  textForeground,
  XAI_MODEL,
  XAI_MODEL_B,
  type XaiRig,
} from "./xai-rig.ts";

const PLACEHOLDER = "xAI server-side compaction checkpoint";

async function commitXaiCheckpoint(rig: XaiRig): Promise<string> {
  await rig.session.prompt("XR-GO");
  await rig.session.compact();
  const latest = compactionsOf(rig.manager).at(-1);
  assert.ok(latest && isXaiDetails(latest.details));
  assert.equal(latest.details.scope.model, XAI_MODEL.id);
  return latest.id;
}

function lastAssistantError(rig: XaiRig): string | undefined {
  for (const entry of rig.manager.getBranch().toReversed()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      return entry.message.errorMessage;
    }
  }
  return undefined;
}

test(
  "another xAI model: refused locally with scope-mismatch, no fetch, one notice, not disabled",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => compactResponse());
    const rig = await createXaiRig({ foreground, lane });
    try {
      const checkpointId = await commitXaiCheckpoint(rig);
      const sessionId = rig.manager.getSessionId();
      await rig.session.setModel(XAI_MODEL_B);
      const before = foreground.sent.length;
      await rig.session.prompt("XR-ON-B");
      await rig.session.prompt("XR-ON-B-AGAIN");
      assert.equal(foreground.sent.length, before, "nothing was transmitted");
      assert.deepEqual(
        xaiTransportRefusals(sessionId).map((refusal) => refusal.code),
        ["scope-mismatch", "scope-mismatch"],
      );
      const error = lastAssistantError(rig) ?? "";
      assert.ok(error.includes(XAI_TRANSPORT_REFUSAL_PREFIX), error);
      assert.ok(XAI_TRANSPORT_REFUSAL_PREFIX.startsWith("choco-pi compaction:"));
      assert.ok(error.includes(OPAQUE_GUARD_NOTICE("xai", checkpointId)), "local exits text");
      const guardNotices = rig.notices.filter((notice) =>
        notice.includes("request not sent (scope-mismatch)"),
      );
      assert.equal(guardNotices.length, 1, "one notice per checkpoint and reason");
      assert.equal(
        rig.notices.some((notice) => /off for this session/u.test(notice)),
        false,
        "a local refusal never disables",
      );
      const refusals = rig
        .records()
        .filter((record) => record.event === "refuse" && record.reason === "scope-mismatch");
      assert.equal(refusals.length, 1);
      assert.equal(refusals[0]?.checkpointEntryId, checkpointId);

      // Same provider, model and base URL again: rewritten.
      await rig.session.setModel(XAI_MODEL);
      await rig.session.prompt("XR-BACK");
      const sent = foreground.sent.at(-1);
      assert.ok(carriesItem(sent), "the item is replayed on the checkpoint's model");
      assert.equal(sent?.text.includes(PLACEHOLDER), false);
      assert.equal(
        rig.records().some((record) => record.event === "disable"),
        false,
      );
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "another xAI model with loss authorized: the placeholder is sent and the loss journaled",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => compactResponse());
    const rig = await createXaiRig({ foreground, lane, opaqueHistory: "allow-loss" });
    try {
      const checkpointId = await commitXaiCheckpoint(rig);
      await rig.session.setModel(XAI_MODEL_B);
      const before = foreground.sent.length;
      await rig.session.prompt("XR-ON-B");
      assert.equal(foreground.sent.length, before + 1, "the request was sent");
      const sent = foreground.sent.at(-1);
      assert.equal(carriesItem(sent), false);
      assert.ok(sent?.text.includes(PLACEHOLDER), "placeholder summary sent");
      const losses = rig
        .records()
        .filter((record) => record.event === "loss" && record.route === "replay");
      assert.equal(losses.length, 1);
      assert.equal(losses[0]?.reason, "loss");
      assert.equal(losses[0]?.detail, "scope-mismatch");
      assert.equal(losses[0]?.checkpointEntryId, checkpointId);
      assert.deepEqual(xaiTransportRefusals(rig.manager.getSessionId()), []);
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "a non-xAI model: the request is published as a pending opaque block, notified once and journaled",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => compactResponse());
    const rig = await createXaiRig({ foreground, lane });
    try {
      const checkpointId = await commitXaiCheckpoint(rig);
      const sessionId = rig.manager.getSessionId();
      await rig.session.setModel(OTHER_MODEL);
      await rig.session.prompt("XR-ON-OTHER");
      await rig.session.prompt("XR-ON-OTHER-AGAIN");
      // No capturing transport for this provider: the host sends the placeholder (residual gap).
      assert.equal(rig.other.sent.length, 2);
      assert.deepEqual(pendingOpaqueBlock(sessionId), {
        entryId: checkpointId,
        owner: "xai-native",
      });
      const exits = rig.notices.filter((notice) =>
        notice.includes(OPAQUE_GUARD_NOTICE("xai", checkpointId)),
      );
      assert.equal(exits.length, 1, "notified once per checkpoint and reason");
      const unauthorized = rig
        .records()
        .filter(
          (record) =>
            record.event === "loss" &&
            record.reason === "opaque-checkpoint" &&
            record.detail === "unauthorized-send",
        );
      assert.equal(unauthorized.length, 1);
      assert.equal(unauthorized[0]?.checkpointEntryId, checkpointId);

      // Consent for exactly this checkpoint lifts the block.
      await rig.session.prompt("/compaction-allow-loss");
      assert.equal(pendingOpaqueBlock(sessionId), undefined);

      // Back on the checkpoint's model, a replayable request clears it for good.
      await rig.session.setModel(XAI_MODEL);
      await rig.session.prompt("XR-BACK");
      assert.ok(carriesItem(foreground.sent.at(-1)));
      assert.equal(pendingOpaqueBlock(sessionId), undefined);
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "the block is cleared when the session's replay binding is released",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => compactResponse());
    const rig = await createXaiRig({ foreground, lane });
    const sessionId = rig.manager.getSessionId();
    try {
      await commitXaiCheckpoint(rig);
      await rig.session.setModel(OTHER_MODEL);
      await rig.session.prompt("XR-ON-OTHER");
      assert.ok(pendingOpaqueBlock(sessionId));
    } finally {
      await rig.dispose();
    }
    assert.equal(pendingOpaqueBlock(sessionId), undefined, "shutdown unbinds and clears");
  },
);
