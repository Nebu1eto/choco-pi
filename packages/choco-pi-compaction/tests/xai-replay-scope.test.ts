/**
 * Replay scope (D11) and the request-boundary opaque guard (D2) of the xAI
 * replay, through a real session: a checkpoint replays only on the model
 * that made it; elsewhere an xAI call is refused locally (never disabling
 * server-side), a non-xAI request is refused at the provider boundary (zero
 * transmissions) through the pending opaque block, and authorized loss sends
 * the placeholder. A provider registered as a native `Provider` is overlaid
 * through the real model runtime too.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Model, Provider } from "@earendil-works/pi-ai";
import { streamSimple as installedStreamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { OPAQUE_GUARD_NOTICE } from "../src/opaque-checkpoint.ts";
import {
  clearOpaqueBlock,
  OPAQUE_BLOCK_REFUSAL_PREFIX,
  pendingOpaqueBlock,
  setOpaqueBlock,
} from "../src/opaque-guard.ts";
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

/** A model of a provider registered as a native `Provider` object. */
const NATIVE_MODEL: Model<"openai-responses"> = {
  ...OTHER_MODEL,
  id: "native-test-1",
  name: "Synthetic native",
  provider: "native-llm",
  baseUrl: "https://native.example/v1",
};

/** A native provider whose requests go to `transport`. */
function nativeProvider(transport: ReturnType<typeof textForeground>): Provider {
  return {
    id: NATIVE_MODEL.provider,
    name: "Synthetic native",
    auth: {
      apiKey: {
        name: "Native key",
        resolve: async () => ({
          auth: { apiKey: "native-non-secret-placeholder" },
          source: "test",
        }),
      },
    },
    getModels: () => [NATIVE_MODEL],
    stream: (_model, context) =>
      installedStreamSimple(NATIVE_MODEL, context, {
        apiKey: "native-non-secret-placeholder",
        fetch: transport.fetch,
      }),
    streamSimple: (_model, context, options) =>
      installedStreamSimple(NATIVE_MODEL, context, { ...options, fetch: transport.fetch }),
  };
}

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
  "a non-xAI model: refused at the provider boundary with zero transmissions, notified once, journaled as refuse",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => compactResponse());
    const rig = await createXaiRig({ foreground, lane });
    try {
      const checkpointId = await commitXaiCheckpoint(rig);
      const sessionId = rig.manager.getSessionId();
      await rig.session.setModel(OTHER_MODEL);
      const foregroundBefore = foreground.sent.length;
      await rig.session.prompt("XR-ON-OTHER");
      await rig.session.prompt("XR-ON-OTHER-AGAIN");
      assert.equal(rig.other.sent.length, 0, "nothing reached the other provider's transport");
      assert.equal(foreground.sent.length, foregroundBefore, "nor the xAI transport");
      const error = lastAssistantError(rig) ?? "";
      assert.ok(error.includes(OPAQUE_BLOCK_REFUSAL_PREFIX), error);
      assert.ok(error.includes(OPAQUE_GUARD_NOTICE("xai", checkpointId)), "the exits");
      assert.deepEqual(pendingOpaqueBlock(sessionId), {
        entryId: checkpointId,
        owner: "xai-native",
      });
      const exits = rig.notices.filter((notice) =>
        notice.includes(OPAQUE_GUARD_NOTICE("xai", checkpointId)),
      );
      assert.equal(exits.length, 1, "notified once per checkpoint and reason");
      const refusals = rig
        .records()
        .filter((record) => record.event === "refuse" && record.reason === "opaque-checkpoint");
      assert.equal(refusals.length, 1, "one refuse record per checkpoint and reason");
      assert.equal(refusals[0]?.checkpointEntryId, checkpointId);
      assert.equal(refusals[0]?.provider, "xai");
      assert.equal(
        rig.records().some((record) => record.detail === "unauthorized-send"),
        false,
        "no unauthorized send happened",
      );

      // Consent for exactly this checkpoint lifts the block; the placeholder is then sent.
      await rig.session.prompt("/compaction-allow-loss");
      assert.equal(pendingOpaqueBlock(sessionId), undefined);
      await rig.session.prompt("XR-ON-OTHER-CONSENTED");
      assert.equal(rig.other.sent.length, 1, "sent once the loss is authorized");
      assert.ok(rig.other.sent[0]?.text.includes(PLACEHOLDER));
      const losses = rig
        .records()
        .filter((record) => record.event === "loss" && record.reason === "loss");
      assert.equal(losses.length, 1, "the authorized loss is journaled");

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
  "the provider overlay wraps the xAI capture transport too: another owner's block is enforced there",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => compactResponse());
    const rig = await createXaiRig({ foreground, lane });
    const sessionId = rig.manager.getSessionId();
    try {
      // The xAI capture is registered at session start; the overlay must sit on top of it.
      await rig.session.prompt("XR-CAPTURED");
      const before = foreground.sent.length;
      assert.ok(before > 0);
      setOpaqueBlock(sessionId, { entryId: "codex-checkpoint-1", owner: "codex-native" });
      await rig.session.prompt("XR-BLOCKED");
      assert.equal(foreground.sent.length, before, "the xAI transport sent nothing");
      const error = lastAssistantError(rig) ?? "";
      assert.ok(error.includes(OPAQUE_GUARD_NOTICE("codex", "codex-checkpoint-1")), error);
      const refusals = rig
        .records()
        .filter((record) => record.event === "refuse" && record.provider === "codex");
      assert.equal(refusals.length, 1);
      assert.equal(refusals[0]?.from, "codex-native-v2");
      // The xAI lane never clears another owner's block.
      assert.deepEqual(pendingOpaqueBlock(sessionId), {
        entryId: "codex-checkpoint-1",
        owner: "codex-native",
      });

      clearOpaqueBlock(sessionId, "codex-checkpoint-1");
      await rig.session.prompt("XR-UNBLOCKED");
      assert.equal(foreground.sent.length, before + 1, "sent once the block is gone");
    } finally {
      clearOpaqueBlock(sessionId);
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

test(
  "a native Provider registration is overlaid: a blocked request is refused with zero transmissions",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => compactResponse());
    const transport = textForeground();
    const native = nativeProvider(transport);
    const rig = await createXaiRig({
      foreground,
      lane,
      after: [(pi: ExtensionAPI) => pi.registerProvider(native)],
    });
    const sessionId = rig.manager.getSessionId();
    try {
      await rig.session.setModel(NATIVE_MODEL);
      await rig.session.prompt("XR-NATIVE");
      assert.equal(transport.sent.length, 1, "an unblocked request is sent");
      const registered = rig.ctx().modelRegistry.getRegisteredNativeProvider(NATIVE_MODEL.provider);
      assert.ok(
        registered !== undefined && registered !== native,
        "the native provider is overlaid",
      );

      setOpaqueBlock(sessionId, { entryId: "codex-checkpoint-native", owner: "codex-native" });
      await rig.session.prompt("XR-NATIVE-BLOCKED");
      assert.equal(transport.sent.length, 1, "zero transmissions while blocked");
      const error = lastAssistantError(rig) ?? "";
      assert.ok(error.includes(OPAQUE_BLOCK_REFUSAL_PREFIX), error);
      assert.ok(error.includes(OPAQUE_GUARD_NOTICE("codex", "codex-checkpoint-native")), error);
      const refusals = rig
        .records()
        .filter((record) => record.event === "refuse" && record.provider === "codex");
      assert.equal(refusals.length, 1, "one refuse record");
      assert.equal(refusals[0]?.checkpointEntryId, "codex-checkpoint-native");

      clearOpaqueBlock(sessionId, "codex-checkpoint-native");
      await rig.session.prompt("XR-NATIVE-UNBLOCKED");
      assert.equal(transport.sent.length, 2, "sent once the block is gone");
    } finally {
      clearOpaqueBlock(sessionId);
      await rig.dispose();
    }
  },
);
