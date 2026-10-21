/**
 * Coordinator failure port: one call per candidate terminal transition, with
 * the trigger and reason; the overflow cancel carries its own detail code.
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
} from "../src/background/coordinator.ts";
import type { SchedulerClock } from "../src/background/scheduler.ts";
import { fingerprintEntries } from "../src/background/snapshot.ts";
import { buildSnapshot, FakeBackend, seededToolPairs } from "./background-fakes.ts";

/** A fresh clock per fixture: coordinator cooldowns are keyed by clock. */
function frozenClock(): SchedulerClock {
  return { now: () => 0, setTimer: () => () => {} };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 30; turn++) await Promise.resolve();
}

function fixture(
  options: { controlled?: boolean; settings?: Partial<BackgroundCompactionSettings> } = {},
) {
  const backend = new FakeBackend({ controlled: options.controlled });
  const entries: SessionEntry[] = seededToolPairs(1, 1);
  const failures: CandidateFailurePortEvent[] = [];
  let anchors = 0;
  const port: CoordinatorPort = {
    getBranch: () => entries,
    getBranchKey: () => "branch-a",
    getProviderScope: () => ({ provider: "fixture", model: "fixture" }),
    getLatestCompactionEntry: () => null,
    appendAnchor: () => `anchor-${++anchors}`,
    proposeDraft: () => {},
    findCommittedCandidate: () => undefined,
  };
  let next = 0;
  const coordinator = createCoordinator({
    ownerKey: "failure-port-session",
    ownerGeneration: 1,
    isOwnerCurrent: () => true,
    isBackendEnabled: (_id, settings) => settings.text,
    port,
    backends: new Map([[backend.id, backend]]),
    appendRecord: () => {},
    settings: {
      ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
      enabled: true,
      text: true,
      cooldownMs: 10,
      retryBaseMs: 2,
      timeoutMs: 100,
      ...options.settings,
    },
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
  });
  return { coordinator, backend, failures };
}

test("fail() reports once with the trigger and reason", async () => {
  const f = fixture();
  f.backend.result = { ok: false, reason: "auth", retryable: false };
  await f.coordinator.requestPreparation({ trigger: "manual", customInstructions: "focus" });
  await flush();
  assert.equal(f.coordinator.status().state, "failed");
  assert.deepEqual(f.failures, [
    {
      candidateId: "candidate-1",
      backendId: "fake",
      reason: "auth",
      trigger: "manual",
      customInstructions: "focus",
    },
  ]);
  // A later terminal request for the same candidate does not report again.
  f.coordinator.cancel();
  assert.equal(f.failures.length, 1);
  f.coordinator.dispose();
});

test("the overflow cancel reports detail 'overflow' once; a second terminal transition does not re-report", async () => {
  const f = fixture({ controlled: true });
  await f.coordinator.requestPreparation({ trigger: "threshold" });
  await flush();
  await f.coordinator.arbitrateHostCompaction({ reason: "overflow" });
  assert.equal(f.coordinator.status().state, "canceled");
  assert.deepEqual(f.failures, [
    {
      candidateId: "candidate-1",
      backendId: "fake",
      reason: "canceled",
      trigger: "threshold",
      detail: "overflow",
    },
  ]);
  // Status keeps no coordinator-only detail: the port alone carries "overflow".
  assert.equal(f.coordinator.status().detail, undefined);
  f.coordinator.cancel("stale-prefix");
  f.backend.pending[0]?.resolve({ ok: false, reason: "timeout", retryable: true });
  await f.coordinator.waitForPreparation();
  assert.equal(f.failures.length, 1);
  f.coordinator.dispose();
});

test("a user cancel reports the cancel reason without an overflow detail", async () => {
  const f = fixture({ controlled: true });
  await f.coordinator.requestPreparation({ trigger: "idle" });
  await flush();
  f.coordinator.cancel();
  assert.deepEqual(f.failures, [
    { candidateId: "candidate-1", backendId: "fake", reason: "canceled", trigger: "idle" },
  ]);
  f.backend.pending[0]?.resolve({ ok: false, reason: "canceled", retryable: false });
  await f.coordinator.waitForPreparation();
  f.coordinator.dispose();
});

test("a disposed coordinator does not report its torn-down candidate", async () => {
  const f = fixture({ controlled: true });
  await f.coordinator.requestPreparation({ trigger: "threshold" });
  await flush();
  f.coordinator.dispose();
  assert.equal(f.coordinator.status().state, "canceled");
  f.backend.pending[0]?.resolve({ ok: false, reason: "auth", retryable: false });
  await f.coordinator.waitForPreparation();
  assert.deepEqual(f.failures, []);
});
