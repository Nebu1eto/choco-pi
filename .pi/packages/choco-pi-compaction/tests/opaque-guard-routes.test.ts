/**
 * Opaque-history guard (D2) on the compaction routes, through a real session:
 * over a committed xAI checkpoint no summarizer answers unless the loss is
 * authorized (setting or `/compaction-allow-loss` for exactly that
 * checkpoint), and Codex opaque strategies get the same outcome at the guard
 * predicate (no Codex extension loaded).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import type { CompactionModes } from "../src/background-host/runtime.ts";
import { OPAQUE_GUARD_NOTICE } from "../src/opaque-checkpoint.ts";
import { guardBeforeLocalSummary, type OpaqueGuardRecord } from "../src/opaque-guard.ts";
import { releaseXaiSessionCaptures } from "../src/xai/capture.ts";
import { isXaiDetails } from "../src/xai/details.ts";
import {
  compactionsOf,
  compactResponse,
  createXaiRig,
  OTHER_MODEL,
  recordingFetch,
  textForeground,
  type XaiRig,
} from "./xai-rig.ts";

/** A committed xAI checkpoint (one captured turn, one native compaction); its entry id. */
async function commitXaiCheckpoint(rig: XaiRig, prompt = "XR-GO"): Promise<string> {
  await rig.session.prompt(prompt);
  await rig.session.compact();
  const latest = compactionsOf(rig.manager).at(-1);
  assert.ok(latest && isXaiDetails(latest.details), "a native xAI checkpoint was committed");
  return latest.id;
}

function guardRecords(rig: XaiRig, event: string) {
  return rig.records().filter((record) => record.event === event && record.provider === "xai");
}

/** One more turn after the checkpoint (the host compacts only new history), then drop its captures. */
async function turnWithoutCaptures(rig: XaiRig, prompt: string): Promise<void> {
  await rig.session.prompt(prompt);
  releaseXaiSessionCaptures(rig.manager.getSessionId());
}

test(
  "(a) /compact over an xAI checkpoint with no capture cancels with the exits notice and journals it",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => compactResponse());
    const rig = await createXaiRig({ foreground, lane });
    try {
      const checkpointId = await commitXaiCheckpoint(rig);
      await turnWithoutCaptures(rig, "XR-MORE");
      const requestsBefore = foreground.sent.length;
      await assert.rejects(rig.session.compact(), /Compaction cancelled/u);
      assert.equal(foreground.sent.length, requestsBefore, "no summarizer request");
      assert.equal(lane.sent.length, 1, "no second compact request");
      assert.equal(compactionsOf(rig.manager).at(-1)?.id, checkpointId);
      assert.ok(
        rig.notices.includes(OPAQUE_GUARD_NOTICE("xai", checkpointId)),
        "the exact exits notice",
      );
      assert.ok(rig.notices.some((notice) => /opaque xai server-side record/u.test(notice)));
      const cancels = guardRecords(rig, "cancel").filter(
        (record) => record.reason === "opaque-checkpoint",
      );
      assert.equal(cancels.length, 1);
      assert.equal(cancels[0]?.checkpointEntryId, checkpointId);
      assert.equal(cancels[0]?.route, "manual");
      assert.equal(cancels[0]?.from, "xai-native");
      assert.equal(cancels[0]?.to, "local");
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "(b) compactionOpaqueHistory=allow-loss: the local summary runs and the loss is journaled",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    const lane = recordingFetch(() => compactResponse());
    const rig = await createXaiRig({ foreground, lane, opaqueHistory: "allow-loss" });
    try {
      const checkpointId = await commitXaiCheckpoint(rig);
      await turnWithoutCaptures(rig, "XR-MORE");
      const result = await rig.session.compact();
      assert.match(result.summary, /XR-LOCAL-SUMMARY/u);
      const latest = compactionsOf(rig.manager).at(-1);
      assert.notEqual(latest?.id, checkpointId);
      assert.equal(isXaiDetails(latest?.details), false);
      const losses = guardRecords(rig, "loss").filter((record) => record.reason === "loss");
      assert.equal(losses.length, 1);
      assert.equal(losses[0]?.checkpointEntryId, checkpointId);
      assert.equal(guardRecords(rig, "cancel").length, 0);
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "(c) /compaction-allow-loss authorizes one checkpoint; a later xAI checkpoint re-arms the guard",
  { timeout: 30_000 },
  async () => {
    const foreground = textForeground();
    // Compact requests 1 and 3 fail (a transient outage), so the native lane falls through to the guard.
    const lane = recordingFetch((index) =>
      index % 2 === 1
        ? new Response(JSON.stringify({ error: { message: "synthetic outage" } }), { status: 503 })
        : compactResponse(),
    );
    const rig = await createXaiRig({ foreground, lane });
    try {
      const first = await commitXaiCheckpoint(rig);
      await rig.session.prompt("XR-MORE");
      await rig.session.prompt("/compaction-allow-loss");
      const summarizedBefore = foreground.sent.length;
      const result = await rig.session.compact();
      assert.match(result.summary, /XR-LOCAL-SUMMARY/u);
      assert.equal(foreground.sent.length, summarizedBefore + 1, "one local summary");
      assert.equal(
        guardRecords(rig, "loss").filter((record) => record.checkpointEntryId === first).length,
        1,
      );

      const second = await commitXaiCheckpoint(rig, "XR-AGAIN");
      assert.notEqual(second, first);
      await rig.session.prompt("XR-MORE-2");
      const before = foreground.sent.length;
      await assert.rejects(rig.session.compact(), /Compaction cancelled/u);
      assert.equal(lane.sent.length, 4, "the native attempt failed before the guard");
      assert.equal(foreground.sent.length, before, "the consent did not carry over");
      assert.ok(rig.notices.includes(OPAQUE_GUARD_NOTICE("xai", second)));
    } finally {
      await rig.dispose();
    }
  },
);

test(
  "(d) after switching to a non-xAI model, /compact over the xAI checkpoint cancels",
  { timeout: 30_000 },
  async () => {
    // The background text-candidate yield on the same switch is U-ANTH's (observeUsage).
    const foreground = textForeground();
    const lane = recordingFetch(() => compactResponse());
    const rig = await createXaiRig({ foreground, lane });
    try {
      const checkpointId = await commitXaiCheckpoint(rig);
      await rig.session.setModel(OTHER_MODEL);
      await rig.session.prompt("XR-ON-OTHER");
      const before = foreground.sent.length + rig.other.sent.length;
      await assert.rejects(rig.session.compact(), /Compaction cancelled/u);
      assert.equal(foreground.sent.length + rig.other.sent.length, before, "no summarizer request");
      assert.ok(rig.notices.includes(OPAQUE_GUARD_NOTICE("xai", checkpointId)));
      assert.equal(compactionsOf(rig.manager).at(-1)?.id, checkpointId);
    } finally {
      await rig.dispose();
    }
  },
);

// ---------------------------------------------------------------------------
// (e) Codex opaque strategies at the guard predicate
// ---------------------------------------------------------------------------

const PRESERVE: CompactionModes = {
  anthropic: "choco-pi",
  xai: "choco-pi",
  opaqueHistory: "preserve",
};

function codexBranch(strategy: string) {
  const manager = SessionManager.inMemory("/tmp");
  manager.appendMessage({ role: "user", content: "A", timestamp: 0 });
  const kept = manager.appendMessage({ role: "user", content: "B", timestamp: 0 });
  const entryId = manager.appendCompaction("placeholder", kept, 10, { strategy });
  return { manager, entryId };
}

function guardEvent(manager: SessionManager): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 0,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
    },
    branchEntries: manager.getBranch(),
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  };
}

interface GuardTestContext {
  readonly sessionManager: SessionManager;
  readonly notices: string[];
}

for (const strategy of ["openai-responses-compaction-v2", "openai-native-compact-v1"]) {
  test(`(e) Codex ${strategy}: the local lane cancels, the Codex lane passes, loss is journaled`, () => {
    const { manager, entryId } = codexBranch(strategy);
    const notices: string[] = [];
    const records: OpaqueGuardRecord[] = [];
    const announce = (ctx: GuardTestContext, record: OpaqueGuardRecord, text: string) => {
      records.push(record);
      ctx.notices.push(text);
    };
    const ctx: GuardTestContext = { sessionManager: manager, notices };
    const event = guardEvent(manager);
    assert.deepEqual(
      guardBeforeLocalSummary(
        { modes: PRESERVE, owner: "local", announce, lossAuthorized: () => false },
        event,
        ctx,
      ),
      { cancel: true },
    );
    assert.deepEqual(notices, [OPAQUE_GUARD_NOTICE("codex", entryId)]);
    assert.equal(records[0]?.event, "cancel");
    assert.equal(records[0]?.reason, "opaque-checkpoint");
    assert.equal(records[0]?.from, "codex-native-v2");
    assert.equal(records[0]?.checkpointEntryId, entryId);

    assert.equal(
      guardBeforeLocalSummary(
        { modes: PRESERVE, owner: "codex-native", announce, lossAuthorized: () => false },
        event,
        ctx,
      ),
      undefined,
      "the Codex lane can replay its own record",
    );
    assert.equal(records.length, 1);

    assert.equal(
      guardBeforeLocalSummary(
        {
          modes: { ...PRESERVE, opaqueHistory: "allow-loss" },
          owner: "local",
          announce,
          lossAuthorized: () => false,
        },
        event,
        ctx,
      ),
      undefined,
    );
    assert.equal(records[1]?.event, "loss");
    assert.equal(
      guardBeforeLocalSummary(
        {
          modes: PRESERVE,
          owner: "xai-native",
          announce,
          lossAuthorized: (_sessionId, consented) => consented === entryId,
        },
        event,
        ctx,
      ),
      undefined,
      "a consent for exactly this checkpoint authorizes the loss",
    );
    assert.equal(records[2]?.event, "loss");
  });
}
