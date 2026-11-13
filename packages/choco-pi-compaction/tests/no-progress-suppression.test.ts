/**
 * No-progress suppression: a lane attempt that ended with no legal cut is not
 * repeated while the cut fingerprint is unchanged (no time-based cooldown), and
 * lane records carry the additive attempt / fingerprint / trigger fields.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  type BackgroundCompactionSettings,
  DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
} from "../src/background/contract.ts";
import {
  type CandidateFailurePortEvent,
  createCoordinator,
  type CoordinatorPort,
  type SuppressedPortEvent,
} from "../src/background/coordinator.ts";
import { isLaneRecord, laneRecordsOf, LANE_RECORD_TYPE } from "../src/background/lane-journal.ts";
import type { SchedulerClock } from "../src/background/scheduler.ts";
import { cutFingerprint, fingerprintEntries } from "../src/background/snapshot.ts";
import { buildSnapshot, FakeBackend, seededToolPairs } from "./background-fakes.ts";

/** A fresh clock per fixture: coordinator cooldowns are keyed by clock. */
function frozenClock(): SchedulerClock {
  return { now: () => 0, setTimer: () => () => {} };
}

async function settle(coordinator: { waitForPreparation(): Promise<void> }): Promise<void> {
  for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  await coordinator.waitForPreparation();
}

function fixture() {
  const backend = new FakeBackend({});
  const entries: SessionEntry[] = seededToolPairs(1, 1);
  const failures: CandidateFailurePortEvent[] = [];
  const suppressed: SuppressedPortEvent[] = [];
  const salt = { value: "" };
  const port: CoordinatorPort = {
    getBranch: () => entries,
    getBranchKey: () => "branch-a",
    getProviderScope: () => ({ provider: "fixture", model: "fixture" }),
    getLatestCompactionEntry: () => null,
    appendAnchor: () => "anchor",
    proposeDraft: () => {},
    findCommittedCandidate: () => undefined,
  };
  let next = 0;
  const settings: BackgroundCompactionSettings = {
    ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
    enabled: true,
    text: true,
    cooldownMs: 10,
    retryBaseMs: 2,
    timeoutMs: 100,
  };
  const coordinator = createCoordinator({
    ownerKey: "no-progress-session",
    ownerGeneration: 1,
    isOwnerCurrent: () => true,
    isBackendEnabled: (_id, current) => current.text,
    port,
    backends: new Map([[backend.id, backend]]),
    appendRecord: () => {},
    settings,
    clock: frozenClock(),
    createCandidateId: () => `candidate-${++next}`,
    freezeSnapshot: (context) =>
      buildSnapshot({
        entries: context.entries,
        cutEntryId: context.entries.at(-1)?.id ?? "missing",
        tokenEstimate: 1000,
        prefixFingerprint: fingerprintEntries(context.entries),
      }),
    onCandidateFailure: (failure) => failures.push(failure),
    onSuppressed: (event) => suppressed.push(event),
    cutSalt: () => salt.value,
  });
  backend.result = { ok: false, reason: "no-legal-cut", retryable: false };
  const appendEntry = (): void => {
    const more = seededToolPairs(1, 1).map((entry, index) => ({
      ...entry,
      id: `extra-${entries.length}-${index}`,
    }));
    entries.push(...more);
  };
  return { coordinator, backend, entries, failures, suppressed, salt, appendEntry };
}

test("cutFingerprint is stable for the same entries and salt, and changes with either", () => {
  const entries = seededToolPairs(2, 1);
  const same = cutFingerprint([...entries], "lane|keep=1");
  assert.equal(cutFingerprint(entries, "lane|keep=1"), same);
  assert.match(same, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(cutFingerprint(entries.slice(0, -1), "lane|keep=1"), same, "one entry fewer");
  const extended = [...entries, ...seededToolPairs(1, 1).map((e) => ({ ...e, id: "new-entry" }))];
  assert.notEqual(cutFingerprint(extended, "lane|keep=1"), same, "one new entry");
  assert.notEqual(cutFingerprint(entries, "lane|keep=2"), same, "different salt");
  assert.notEqual(cutFingerprint(entries.toReversed(), "lane|keep=1"), same, "order matters");
});

test("no-legal-cut is suppressed once per fingerprint, re-armed by a change, bypassed by manual", async () => {
  const f = fixture();

  // Attempt 1 runs and ends with no legal cut.
  assert.deepEqual(await f.coordinator.requestPreparation({ trigger: "threshold" }), {
    accepted: true,
    candidateId: "candidate-1",
  });
  await settle(f.coordinator);
  assert.equal(f.coordinator.status().reason, "no-legal-cut");
  assert.equal(f.backend.calls.length, 1);
  assert.equal(f.failures[0]?.attempt, 1);

  // Same fingerprint: not started; reported exactly once.
  for (let repeat = 0; repeat < 3; repeat++) {
    assert.deepEqual(
      await f.coordinator.requestPreparation({ trigger: "threshold", tokensAtTrigger: 900 }),
      { accepted: false, reason: "no-legal-cut" },
    );
  }
  assert.equal(f.backend.calls.length, 1, "no further lane attempt");
  assert.equal(f.suppressed.length, 1, "journaled at most once per fingerprint");
  assert.equal(f.suppressed[0]?.attempt, 2);
  assert.equal(f.suppressed[0]?.trigger, "threshold");
  assert.equal(f.suppressed[0]?.tokensAtTrigger, 900);
  assert.equal(f.suppressed[0]?.cutFingerprint, f.failures[0]?.cutFingerprint);

  // Manual and forced triggers bypass suppression, and count as the next attempt.
  const manual = await f.coordinator.requestPreparation({ trigger: "manual" });
  assert.equal(manual.accepted, true);
  await settle(f.coordinator);
  assert.equal(f.backend.calls.length, 2);
  assert.equal(f.failures[1]?.attempt, 2);
  assert.equal(f.failures[1]?.trigger, "manual");

  // A new entry changes the fingerprint: the lane is re-armed at attempt 1.
  f.appendEntry();
  const rearmed = await f.coordinator.requestPreparation({ trigger: "threshold" });
  assert.equal(rearmed.accepted, true);
  await settle(f.coordinator);
  assert.equal(f.backend.calls.length, 3);
  assert.equal(f.failures[2]?.attempt, 1);
  assert.notEqual(f.failures[2]?.cutFingerprint, f.failures[0]?.cutFingerprint);

  // ...and is suppressed again, with a fresh single report, for the new fingerprint.
  assert.equal((await f.coordinator.requestPreparation({ trigger: "idle" })).accepted, false);
  assert.equal((await f.coordinator.requestPreparation({ trigger: "idle" })).accepted, false);
  assert.equal(f.suppressed.length, 2);
  assert.equal(f.suppressed[1]?.trigger, "idle");

  // A change of the non-branch cut inputs (a new wire capture, say) re-arms as well.
  f.salt.value = "capture=2";
  assert.equal((await f.coordinator.requestPreparation({ trigger: "threshold" })).accepted, true);
  await settle(f.coordinator);
  assert.equal(f.backend.calls.length, 4);
  f.coordinator.dispose();
});

test("only a no-legal-cut attempt suppresses; other failures keep the existing behaviour", async () => {
  const f = fixture();
  f.backend.result = { ok: false, reason: "malformed", retryable: false };
  await f.coordinator.requestPreparation({ trigger: "threshold" });
  await settle(f.coordinator);
  assert.equal(f.coordinator.status().reason, "malformed");
  // Nothing was remembered as no-progress: the next request is not suppressed
  // (it may still be refused by the scope cooldown, which is a separate mechanism).
  await f.coordinator.requestPreparation({ trigger: "threshold" });
  await settle(f.coordinator);
  assert.equal(f.suppressed.length, 0);
  f.coordinator.dispose();
});

test("the failure port carries the trigger, attempt, fingerprint and tokens at trigger", async () => {
  const f = fixture();
  for (const trigger of ["threshold", "idle", "context-cap", "manual"] as const) {
    f.backend.result = { ok: false, reason: "auth", retryable: false };
    f.salt.value = trigger;
    await f.coordinator.requestPreparation({ trigger, tokensAtTrigger: 123 });
    await settle(f.coordinator);
  }
  assert.deepEqual(
    f.failures.map((failure) => [failure.trigger, failure.attempt, failure.tokensAtTrigger]),
    [
      ["threshold", 1, 123],
      ["idle", 1, 123],
      ["context-cap", 1, 123],
      ["manual", 1, 123],
    ],
  );
  f.coordinator.dispose();
});

test("lane records written before the new fields still load; the new fields validate", () => {
  const legacy = {
    customType: LANE_RECORD_TYPE,
    schemaVersion: 1,
    at: 1,
    sessionId: "s",
    provider: "anthropic",
    route: "threshold",
    event: "fallback",
    from: "anthropic-native",
    reason: "no-legal-cut",
    noticeAttempted: false,
  } as const;
  assert.ok(isLaneRecord(legacy));
  const fresh = {
    ...legacy,
    event: "suppressed",
    trigger: "threshold",
    attempt: 3,
    cutFingerprint: "sha256:abc",
    tokensAtTrigger: 1234,
  } as const;
  assert.ok(isLaneRecord(fresh));
  assert.ok(!isLaneRecord({ ...fresh, attempt: 0 }), "attempt is 1-based");
  assert.ok(!isLaneRecord({ ...fresh, cutFingerprint: "" }));
  assert.ok(!isLaneRecord({ ...fresh, tokensAtTrigger: -1 }));
  const entries = [
    { type: "custom", customType: LANE_RECORD_TYPE, data: legacy },
    { type: "custom", customType: LANE_RECORD_TYPE, data: fresh },
  ];
  assert.deepEqual(laneRecordsOf(entries), [legacy, fresh]);
});
