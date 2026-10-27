/**
 * Every compaction this extension answers records what started it:
 * `details.trigger` on the checkpoint, `trigger` on the lane record of a
 * native attempt that gave way. The field is optional so older session files
 * parse unchanged.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { CompactionEntry, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { laneRecordsOf, LaneRecordSchema } from "../src/background/lane-journal.ts";
import registerCompaction from "../src/index.ts";
import {
  CompactionTriggerSchema,
  hostTriggerOf,
  triggerOfDetails,
  withTrigger,
} from "../src/trigger.ts";
import { Value } from "typebox/value";
import { compactionEntries, createHost, reply } from "./host-boundary-fixture.ts";
import { BACKGROUND_OFF_SETTINGS_PATHS } from "./host-harness.ts";

const RETRY = { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 };

test("withTrigger stamps details, keeps a producer's own trigger, and tolerates odd details", () => {
  assert.deepEqual(withTrigger({ details: { strategy: "local-reconciled" } }, "threshold"), {
    details: { strategy: "local-reconciled", trigger: "threshold" },
  });
  assert.deepEqual(
    withTrigger({ details: { strategy: "x", trigger: "idle" } }, "manual"),
    { details: { strategy: "x", trigger: "idle" } },
    "an adoption that knows its own route keeps it",
  );
  assert.deepEqual(withTrigger({ details: undefined }, "overflow"), {
    details: { trigger: "overflow" },
  });
  assert.deepEqual(withTrigger({ details: [1, 2] }, "overflow"), {
    details: { trigger: "overflow" },
  });
  assert.equal(triggerOfDetails({ trigger: "context-cap" }), "context-cap");
  assert.equal(triggerOfDetails({ trigger: "someday" }), undefined, "unknown values are ignored");
  assert.equal(
    triggerOfDetails({ strategy: "local-reconciled" }),
    undefined,
    "legacy details carry none",
  );
  assert.equal(triggerOfDetails("text"), undefined);
  assert.equal(hostTriggerOf({ reason: "overflow" }), "overflow");
  assert.ok(Value.Check(CompactionTriggerSchema, "manual"));
  assert.ok(!Value.Check(CompactionTriggerSchema, "auto"));
});

test("lane records accept the optional trigger and still accept records without it", () => {
  const base = {
    customType: "choco-compaction-lane",
    schemaVersion: 1,
    at: 1,
    sessionId: "s",
    provider: "anthropic",
    route: "manual",
    event: "fallback",
    from: "anthropic-native",
    reason: "no-legal-cut",
    noticeAttempted: false,
  } as const;
  assert.ok(Value.Check(LaneRecordSchema, base), "a legacy record without a trigger");
  assert.ok(Value.Check(LaneRecordSchema, { ...base, trigger: "threshold" }));
  assert.ok(!Value.Check(LaneRecordSchema, { ...base, trigger: "auto" }), "only the vocabulary");
});

/** The full extension, background off, answering the host's own compactions. */
function extension(pi: ExtensionAPI): void {
  registerCompaction(pi, {
    retryPolicy: RETRY,
    compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 0 }),
    background: { settingsPaths: () => [...BACKGROUND_OFF_SETTINGS_PATHS] },
  });
}

function triggerOf(entry: CompactionEntry | undefined): string | undefined {
  return entry === undefined ? undefined : triggerOfDetails(entry.details);
}

test(
  "manual /compact, with and without instructions, records trigger manual",
  { timeout: 30_000 },
  async () => {
    const host = await createHost({
      extensions: [extension],
      contextWindow: 100_000,
      respond: async (index) => reply(`R${index}`, { usageInput: 90_000 }),
    });
    try {
      await host.session.prompt("GO");
      await host.session.compact();
      await host.session.prompt("NEXT");
      await host.session.compact("focus on the tests");
      const entries = compactionEntries(host.manager.getBranch());
      assert.equal(entries.length, 2);
      assert.deepEqual(entries.map(triggerOf), ["manual", "manual"]);
    } finally {
      await host.dispose();
    }
  },
);

test("the host's threshold compaction records trigger threshold", { timeout: 30_000 }, async () => {
  const host = await createHost({
    extensions: [extension],
    contextWindow: 100_000,
    compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 20_000 },
    respond: async (index) => reply(`R${index}`, { usageInput: 90_000 }),
  });
  try {
    await host.session.prompt("GO");
    await host.session.prompt("NEXT");
    const entries = compactionEntries(host.manager.getBranch());
    assert.ok(entries.length >= 1, "usage above the threshold compacted automatically");
    assert.ok(
      entries.every((entry) => triggerOf(entry) === "threshold"),
      JSON.stringify(entries.map(triggerOf)),
    );
  } finally {
    await host.dispose();
  }
});

test(
  "a reply that overflows the window records trigger overflow",
  { timeout: 30_000 },
  async () => {
    const host = await createHost({
      extensions: [extension],
      contextWindow: 100_000,
      compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 },
      // A completed response that exceeded the configured window: overflow without retry.
      respond: async (index) => reply(`R${index}`, { usageInput: index === 0 ? 10 : 120_000 }),
    });
    try {
      await host.session.prompt("GO");
      await host.session.prompt("NEXT");
      const entries = compactionEntries(host.manager.getBranch());
      assert.ok(entries.length >= 1, "an overflowing reply compacted");
      assert.ok(
        entries.some((entry) => triggerOf(entry) === "overflow"),
        JSON.stringify(entries.map(triggerOf)),
      );
    } finally {
      await host.dispose();
    }
  },
);

test("legacy checkpoints without the field read as no trigger; lane records likewise", () => {
  const legacy: CompactionEntry = {
    type: "compaction",
    id: "k",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    summary: "s",
    firstKeptEntryId: "a",
    tokensBefore: 1,
    details: { strategy: "local-reconciled", schemaVersion: 1 },
  };
  assert.equal(triggerOf(legacy), undefined);
  assert.deepEqual(laneRecordsOf([]), []);
});
