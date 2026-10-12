import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { CompactionEntryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  CANDIDATE_TRANSITIONS,
  DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
  type BackgroundCompactionSettings,
  type CandidateState,
  type ProviderScope,
} from "../src/background/contract.ts";
import { CandidateMachine } from "../src/background/state-machine.ts";
import {
  createCoordinator,
  type CoordinatorPort,
  type SnapshotContext,
} from "../src/background/coordinator.ts";
import { type SchedulerClock } from "../src/background/scheduler.ts";
import { parseRecord } from "../src/background/candidate-record.ts";
import {
  fingerprintEntries,
  freezeSnapshot,
  isSnapshotRefusal,
  readFirstKeptEntryId,
} from "../src/background/snapshot.ts";
import {
  buildCheckpoint,
  buildSnapshot,
  deferred,
  FakeBackend,
  FakeConsumer,
  FakeParticipant,
  fakeAppendRecordSink,
  persistedCustomEntry,
  seededToolPairs,
  type Deferred,
} from "./background-fakes.ts";

class Clock implements SchedulerClock {
  time = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  private next = 0;
  now(): number {
    return this.time;
  }
  setTimer(callback: () => void, delayMs: number): () => void {
    const id = this.next++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return () => {
      this.timers.delete(id);
    };
  }
  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.time || !this.timers.has(id)) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 30; turn++) await Promise.resolve();
}

interface FixtureState {
  entries: SessionEntry[];
  branchKey: string;
  scope: ProviderScope;
  ownerCurrent: boolean;
  latest: { id: string; version: number } | null;
  calls: number;
  anchors: number;
  proposals: CompactionEntryDraft[];
  committed: { id: string; candidateId: string; fingerprint: string } | undefined;
}
interface AnchorGate {
  value?: Deferred<string>;
}
interface PersistenceGate {
  value?: Deferred<void>;
}
const DraftIdentitySchema = Type.Object(
  { candidateId: Type.String(), prefixFingerprint: Type.String() },
  { additionalProperties: true },
);

function fixture(
  options: {
    controlled?: boolean;
    clock?: Clock;
    useCanonicalSnapshot?: boolean;
    generation?: number;
    ownerKey?: string;
    staleError?: Error;
    settings?: Partial<BackgroundCompactionSettings>;
  } = {},
) {
  const clock = options.clock ?? new Clock();
  const backend = new FakeBackend({ controlled: options.controlled });
  const sink = fakeAppendRecordSink();
  const history = seededToolPairs(1, 1);
  const state: FixtureState = {
    entries: structuredClone(history),
    branchKey: "branch-a",
    scope: { provider: "fixture", model: "fixture" },
    ownerCurrent: true,
    latest: null,
    calls: 0,
    anchors: 0,
    proposals: [],
    committed: undefined,
  };
  const access = () => {
    assert.equal(state.ownerCurrent, true, "port touched after owner invalidation");
    state.calls++;
  };
  const anchorGate: AnchorGate = {};
  const persistenceGate: PersistenceGate = {};
  const port: CoordinatorPort = {
    getBranch() {
      access();
      return state.entries;
    },
    getBranchKey() {
      access();
      return state.branchKey;
    },
    getProviderScope() {
      access();
      return state.scope;
    },
    getLatestCompactionEntry() {
      access();
      return state.latest;
    },
    appendAnchor() {
      access();
      state.anchors++;
      if (anchorGate.value) return anchorGate.value.promise;
      const id = `anchor-${state.anchors}`;
      state.entries.push({
        type: "custom",
        id,
        parentId: state.entries.at(-1)?.id ?? null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "compaction-anchor",
        data: {},
      });
      return id;
    },
    proposeDraft(draft) {
      access();
      state.proposals.push(draft);
    },
    findCommittedCandidate() {
      access();
      return state.committed;
    },
  };
  let next = 0;
  const snapshots: SnapshotContext[] = [];
  const coordinator = createCoordinator({
    ownerKey: options.ownerKey ?? "session-1",
    ownerGeneration: options.generation ?? 1,
    isOwnerCurrent: () => state.ownerCurrent,
    isBackendEnabled: (_id, settings) => settings.text,
    port,
    backends: new Map([[backend.id, backend]]),
    appendRecord: async (record) => {
      sink.appendRecord(record);
      if (persistenceGate.value) await persistenceGate.value.promise;
    },
    isStaleContextError: (cause) =>
      options.staleError !== undefined && cause === options.staleError,
    settings: {
      ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
      enabled: true,
      text: true,
      cooldownMs: 10,
      retryBaseMs: 2,
      timeoutMs: 100,
      ...options.settings,
    },
    clock,
    createCandidateId: () => `candidate-${++next}`,
    freezeSnapshot(context) {
      snapshots.push(context);
      if (options.useCanonicalSnapshot) {
        const selected = freezeSnapshot(context.entries, {
          ownerKey: context.ownerKey,
          ownerGeneration: context.ownerGeneration,
          providerScope: context.providerScope,
          capturedAt: context.capturedAt,
          keepRecentTokens: 0,
        });
        return isSnapshotRefusal(selected) ? null : selected;
      }
      return buildSnapshot({
        entries: context.entries,
        cutEntryId: context.entries.at(-1)?.id ?? "missing",
        tokenEstimate: 1000,
        prefixFingerprint: fingerprintEntries(context.entries),
      });
    },
  });
  function appendSuffix(id = "suffix-1"): void {
    state.entries.push({
      type: "message",
      id,
      parentId: state.entries.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: id, timestamp: 1 },
    });
  }
  function commit(): void {
    const draft = state.proposals.at(-1);
    assert.ok(draft);
    const details: unknown = draft.details;
    assert.ok(Value.Check(DraftIdentitySchema, details));
    const id = "host-assigned-entry";
    state.committed = {
      id,
      candidateId: details.candidateId,
      fingerprint: details.prefixFingerprint,
    };
    state.entries.push({
      type: "compaction",
      id,
      parentId: state.entries.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: draft.summary,
      firstKeptEntryId: draft.firstKeptEntryId ?? id,
      tokensBefore: 1000,
      details,
    });
    state.latest = { id, version: 1 };
  }
  return {
    coordinator,
    backend,
    state,
    history,
    clock,
    sink,
    snapshots,
    port,
    anchorGate,
    persistenceGate,
    appendSuffix,
    commit,
  };
}

async function ready(f: ReturnType<typeof fixture>): Promise<void> {
  assert.equal((await f.coordinator.requestPreparation()).accepted, true);
  await f.coordinator.waitForPreparation();
  assert.equal(f.coordinator.status().state, "ready");
}

const states: CandidateState[] = [
  "idle",
  "queued",
  "preparing",
  "ready",
  "adopting",
  "installed",
  "canceled",
  "failed",
  "discarded-stale",
];
test("all lifecycle edges match the frozen table; every illegal transition throws", () => {
  for (const state of states) for (const next of states) assertTransitionEdge(state, next);
});

/** A legal edge moves the machine; an illegal one throws and leaves the state unchanged. */
function assertTransitionEdge(state: CandidateState, next: CandidateState): void {
  const machine = new CandidateMachine();
  machine.state = state;
  if (CANDIDATE_TRANSITIONS[state].includes(next)) {
    machine.transition(next);
    assert.equal(machine.state, next);
    return;
  }
  assert.throws(() => machine.transition(next), /Illegal compaction transition/);
  assert.equal(machine.state, state);
}

test("reservation is immediate; fire-and-forget and ready candidates block a second candidate", async () => {
  const f = fixture({ controlled: true });
  void f.coordinator.requestPreparation();
  assert.equal(f.coordinator.status().state, "queued");
  assert.deepEqual(await f.coordinator.requestPreparation(), { accepted: false, reason: "busy" });
  await flush();
  assert.equal(f.backend.calls.length, 1);
  f.backend.pending[0]?.resolve(buildCheckpoint("candidate-1"));
  await f.coordinator.waitForPreparation();
  assert.deepEqual(await f.coordinator.requestPreparation(), { accepted: false, reason: "busy" });
  f.coordinator.dispose();
  assert.equal(f.clock.timers.size, 0);
});

test("simultaneous manual/automatic arbitration proposes once; acknowledgment installs and notifies once", async () => {
  const f = fixture();
  const consumer = new FakeConsumer();
  f.coordinator.registerConsumer(consumer);
  await ready(f);
  f.appendSuffix();
  const [manual, automatic] = await Promise.all([
    f.coordinator.arbitrateManualCompact(),
    f.coordinator.arbitrateHostCompaction(),
  ]);
  assert.equal([manual, automatic].filter((result) => result.action === "adopt").length, 1);
  assert.equal(f.state.proposals.length, 1);
  assert.equal(f.coordinator.status().state, "adopting");
  assert.equal(consumer.adoptions.length, 0);
  assert.equal(f.state.proposals[0]?.firstKeptEntryId, "suffix-1");
  f.commit();
  await Promise.all([
    f.coordinator.reconcileCommit(),
    f.coordinator.reconcileCommit(),
    f.coordinator.arbitrateHostCompaction(),
  ]);
  assert.equal(f.coordinator.status().state, "installed");
  assert.equal(f.coordinator.status().committedEntryId, "host-assigned-entry");
  assert.equal(consumer.adoptions.length, 1);
  assert.equal(consumer.counts.values().next().value, 1);
  await f.coordinator.reconcileCommit(true);
  assert.equal(consumer.adoptions.length, 1);
  f.coordinator.dispose();
});

test("dropped/replaced drafts and host refusals never notify; explicit boundary settlement revalidates", async () => {
  const f = fixture();
  const consumer = new FakeConsumer();
  f.coordinator.registerConsumer(consumer);
  await ready(f);
  f.appendSuffix();
  await f.coordinator.arbitrateHostCompaction();
  f.state.committed = { id: "other-entry", candidateId: "other-candidate", fingerprint: "other" };
  await f.coordinator.reconcileCommit();
  assert.equal(f.coordinator.status().state, "adopting");
  await f.coordinator.hostRefused();
  assert.equal(f.coordinator.status().state, "ready");
  assert.equal(f.coordinator.status().reason, "draft-not-committed");
  assert.equal(consumer.adoptions.length, 0);
  assert.equal(f.backend.calls.length, 1);
  f.state.latest = { id: "replacement", version: 1 };
  await f.coordinator.arbitrateHostCompaction();
  assert.equal(f.coordinator.status().state, "discarded-stale");
  assert.equal(consumer.adoptions.length, 0);
  f.coordinator.dispose();
});

test("empty suffix gets a real custom anchor and a CompactionResult with a string retention ID", async () => {
  const f = fixture();
  await ready(f);
  const result = await f.coordinator.arbitrateHostCompaction({ reason: "idle" });
  assert.equal(result.action, "adopt");
  if (result.action === "adopt") {
    assert.equal(result.compaction.firstKeptEntryId, "anchor-1");
    assert.equal(result.compaction.tokensBefore, 1000);
    assert.ok(f.state.entries.some((entry) => entry.id === result.compaction.firstKeptEntryId));
  }
  assert.equal(f.state.anchors, 1);
  f.coordinator.dispose();
});

test("suffix growth is valid, frozen prefix is detached, and exact first current suffix is retained", async () => {
  const f = fixture({ controlled: true });
  await f.coordinator.requestPreparation();
  await flush();
  const snapshot = f.backend.calls[0]?.snapshot;
  assert.ok(snapshot);
  assert.ok(Object.isFrozen(snapshot.entries));
  f.appendSuffix("later-d");
  f.appendSuffix("later-e");
  assert.deepEqual(snapshot.entries, f.history);
  f.backend.pending[0]?.resolve(buildCheckpoint("candidate-1"));
  await f.coordinator.waitForPreparation();
  const result = await f.coordinator.arbitrateHostCompaction();
  assert.equal(result.action, "adopt");
  assert.equal(f.state.proposals[0]?.firstKeptEntryId, "later-d");
  assert.deepEqual(
    f.state.entries.slice(f.history.length).map((entry) => entry.id),
    ["later-d", "later-e"],
  );
  f.coordinator.dispose();
});

for (const change of ["branch", "checkpoint", "scope", "prefix", "generation"] as const) {
  test(`${change} change discards a pending preparation; generation invalidation never touches the old port`, async () => {
    const f = fixture({ controlled: true });
    await f.coordinator.requestPreparation();
    await flush();
    const calls = f.state.calls;
    if (change === "branch") f.state.branchKey = "other-branch";
    if (change === "checkpoint") f.state.latest = { id: "new", version: 2 };
    if (change === "scope")
      f.state.scope = { provider: "fixture", model: "other", accountScope: "other-account" };
    if (change === "prefix") {
      const entry = f.state.entries[0];
      if (entry?.type === "message" && entry.message.role === "user")
        entry.message.content = "edited";
    }
    if (change === "generation") f.state.ownerCurrent = false;
    f.backend.pending[0]?.resolve(buildCheckpoint("candidate-1"));
    await f.coordinator.waitForPreparation();
    assert.equal(f.coordinator.status().state, "discarded-stale");
    assert.equal(f.state.proposals.length, 0);
    assert.equal(f.sink.records.length, 0);
    if (change === "generation") assert.equal(f.state.calls, calls);
    f.coordinator.dispose();
  });
}

test("hard overflow never waits for preparation; custom instructions discard a ready candidate", async () => {
  const empty = fixture();
  assert.deepEqual(await empty.coordinator.arbitrateHostCompaction({ reason: "overflow" }), {
    action: "proceed",
  });
  empty.coordinator.dispose();
  const f = fixture({ controlled: true });
  await f.coordinator.requestPreparation();
  await flush();
  assert.deepEqual(await f.coordinator.arbitrateHostCompaction({ reason: "overflow" }), {
    action: "proceed",
  });
  assert.equal(f.coordinator.status().state, "canceled");
  assert.equal(f.backend.calls[0]?.signal.aborted, true);
  f.backend.pending[0]?.resolve(buildCheckpoint("candidate-1"));
  await f.coordinator.waitForPreparation();
  f.coordinator.dispose();
  const manual = fixture();
  await ready(manual);
  assert.deepEqual(await manual.coordinator.arbitrateManualCompact("focus on failures"), {
    action: "proceed",
  });
  assert.equal(manual.coordinator.status().reason, "manual-instructions");
  manual.coordinator.dispose();
});

for (const phase of ["queued", "preparing", "ready"] as const) {
  test(`disable during ${phase} prevents all late adoption`, async () => {
    const f = fixture({ controlled: phase !== "ready" });
    if (phase === "ready") await ready(f);
    else {
      await f.coordinator.requestPreparation();
      if (phase === "preparing") await flush();
    }
    f.coordinator.setEnabled(false);
    f.backend.pending[0]?.resolve(buildCheckpoint("candidate-1"));
    await f.coordinator.waitForPreparation();
    assert.equal(f.coordinator.status().reason, "disabled");
    assert.deepEqual(await f.coordinator.arbitrateHostCompaction(), { action: "proceed" });
    assert.equal(f.state.proposals.length, 0);
    f.coordinator.dispose();
  });
}

test("deadline aborts; late completion leaves history and persistence untouched", async () => {
  const f = fixture({ controlled: true });
  await f.coordinator.requestPreparation();
  await flush();
  f.clock.advance(100);
  assert.equal(f.coordinator.status().reason, "timeout");
  assert.equal(f.backend.calls[0]?.signal.aborted, true);
  f.backend.pending[0]?.resolve(buildCheckpoint("candidate-1"));
  await f.coordinator.waitForPreparation();
  assert.deepEqual(f.state.entries, f.history);
  assert.equal(f.sink.records.length, 0);
  f.coordinator.dispose();
});

test("retry, backoff and quota cooldown are bounded with no sleeps or new paid work during cooldown", async () => {
  const f = fixture({ controlled: true });
  await f.coordinator.requestPreparation();
  await flush();
  f.backend.pending[0]?.resolve({ ok: false, reason: "429", retryable: true, retryAfterMs: 5 });
  await flush();
  assert.equal(f.backend.calls.length, 1);
  f.clock.advance(9);
  await flush();
  assert.equal(f.backend.calls.length, 1);
  f.clock.advance(1);
  await flush();
  assert.equal(f.backend.calls.length, 2);
  f.backend.pending[1]?.resolve({ ok: false, reason: "529", retryable: true });
  await f.coordinator.waitForPreparation();
  assert.equal(f.coordinator.status().state, "failed");
  assert.equal(f.coordinator.status().attempts, 2);
  await f.coordinator.requestPreparation();
  await f.coordinator.waitForPreparation();
  assert.equal(f.backend.calls.length, 2);
  assert.equal(f.coordinator.status().reason, "quota");
  f.coordinator.dispose();
});

for (const failure of ["oversized", "malformed", "unsupported", "no-legal-cut", "auth"] as const) {
  test(`${failure} fails closed and leaves history intact`, async () => {
    const f = fixture({ settings: failure === "oversized" ? { maxResultBytes: 10 } : {} });
    if (failure === "malformed") f.backend.result = buildCheckpoint("wrong-candidate");
    if (failure === "unsupported")
      f.backend.capabilityVerdict = { supported: false, reason: "unsupported" };
    if (failure === "no-legal-cut")
      f.backend.legalityVerdict = { legal: false, reason: "no-legal-cut" };
    if (failure === "auth") f.backend.result = { ok: false, reason: "auth", retryable: false };
    await f.coordinator.requestPreparation();
    await f.coordinator.waitForPreparation();
    assert.equal(f.coordinator.status().state, "failed");
    assert.equal(f.coordinator.status().reason, failure);
    assert.deepEqual(f.state.entries, f.history);
    assert.equal(f.sink.records.length, 0);
    f.coordinator.dispose();
  });
}

test("participants finish before snapshot selection; appended entries belong exactly once to the prefix", async () => {
  const f = fixture();
  const participant = new FakeParticipant(["participant-entry"]);
  participant.beforeSnapshot = async (context) => {
    participant.calls.push(context);
    f.appendSuffix("participant-entry");
    return { appendedEntryIds: ["participant-entry"] };
  };
  f.coordinator.registerParticipant(participant);
  await ready(f);
  const snapshot = f.backend.calls[0]?.snapshot;
  assert.ok(snapshot);
  assert.equal(snapshot.entries.filter((entry) => entry.id === "participant-entry").length, 1);
  assert.deepEqual(f.snapshots[0]?.participantEntryIds, ["participant-entry"]);
  f.coordinator.dispose();
});

test("records round-trip and bind to a new generation without paid preparation; incompatible records discard", async () => {
  const before = fixture();
  await ready(before);
  const record = before.sink.records[0];
  assert.ok(record);
  assert.deepEqual(
    parseRecord((await persistedCustomEntry(record)).data),
    record,
    "the record survives a real session reopen",
  );
  before.coordinator.dispose();
  const reopened = fixture({ generation: 2 });
  reopened.appendSuffix("new-tail");
  assert.equal(await reopened.coordinator.recover([record]), true);
  assert.equal(reopened.coordinator.status().reason, "recovered");
  assert.equal(reopened.backend.calls.length, 0);
  const adopted = await reopened.coordinator.arbitrateHostCompaction();
  assert.equal(adopted.action, "adopt");
  assert.equal(reopened.state.proposals[0]?.firstKeptEntryId, "new-tail");
  reopened.coordinator.dispose();
  for (const mismatch of ["owner", "scope", "checkpoint", "prefix"] as const) {
    const f = fixture({ generation: 3 });
    const changed = structuredClone(record);
    if (mismatch === "owner") changed.identity.ownerKey = "other-owner";
    if (mismatch === "scope") changed.identity.providerScope.model = "other-model";
    if (mismatch === "checkpoint") f.state.latest = { id: "new-checkpoint", version: 1 };
    if (mismatch === "prefix") f.state.entries.shift();
    assert.equal(await f.coordinator.recover([changed]), false);
    assert.equal(f.coordinator.status().state, "discarded-stale");
    assert.equal(f.backend.calls.length, 0);
    f.coordinator.dispose();
  }
});

test("unrelated participant errors are safely retained for the explicit observer, never retried", async () => {
  const f = fixture();
  const error = new Error("participant failure");
  f.coordinator.registerParticipant({
    id: "throwing",
    beforeSnapshot: () => Promise.reject(error),
  });
  void f.coordinator.requestPreparation();
  await flush();
  assert.equal(f.coordinator.status().state, "failed");
  await assert.rejects(f.coordinator.waitForPreparation(), (cause: unknown) => cause === error);
  assert.equal(f.backend.calls.length, 0);
  f.coordinator.dispose();
});

test("backend flags refuse work before capability or snapshot access", async () => {
  const f = fixture({ settings: { text: false } });
  assert.deepEqual(await f.coordinator.requestPreparation(), {
    accepted: false,
    reason: "unsupported",
  });
  assert.equal(f.state.calls, 0);
  assert.equal(f.backend.calls.length, 0);
  f.coordinator.dispose();
});

test("manual instructions racing an awaited anchor invalidate the automatic draft", async () => {
  const f = fixture();
  await ready(f);
  f.anchorGate.value = deferred<string>();
  const automatic = f.coordinator.arbitrateHostCompaction();
  assert.deepEqual(await f.coordinator.arbitrateManualCompact("new guidance"), {
    action: "proceed",
  });
  f.anchorGate.value.resolve("late");
  assert.deepEqual(await automatic, { action: "proceed" });
  assert.equal(f.state.proposals.length, 0);
  assert.equal(f.coordinator.status().reason, "manual-instructions");
  f.coordinator.dispose();
});

for (const boundary of ["participant", "capability", "persistence"] as const) {
  test(`owner invalidation at the ${boundary} await prevents every later port access`, async () => {
    const f = fixture();
    const gate = deferred<void>();
    if (boundary === "participant")
      f.coordinator.registerParticipant({
        id: "held",
        beforeSnapshot: async () => {
          await gate.promise;
          return { appendedEntryIds: [] };
        },
      });
    if (boundary === "capability")
      f.backend.capability = async () => {
        await gate.promise;
        return { supported: true };
      };
    if (boundary === "persistence") f.persistenceGate.value = gate;
    void f.coordinator.requestPreparation();
    await flush();
    const calls = f.state.calls;
    f.state.ownerCurrent = false;
    f.coordinator.invalidate();
    gate.resolve();
    await f.coordinator.waitForPreparation();
    assert.equal(f.state.calls, calls);
    assert.equal(f.state.proposals.length, 0);
    assert.equal(f.coordinator.status().state, "discarded-stale");
    f.coordinator.dispose();
  });
}

test("a queued stale child is rechecked before capability or quota is spent", async () => {
  const parent = fixture({
    controlled: true,
    ownerKey: "queue-parent",
    settings: { maxConcurrent: 1 },
  });
  const child = fixture({ ownerKey: "queue-child", settings: { maxConcurrent: 1 } });
  await parent.coordinator.requestPreparation();
  await flush();
  await child.coordinator.requestPreparation();
  await flush();
  assert.equal(child.coordinator.status().state, "queued");
  assert.equal(child.backend.calls.length, 0);
  child.state.branchKey = "different-branch";
  parent.backend.pending[0]?.resolve(buildCheckpoint("candidate-1"));
  await Promise.all([
    parent.coordinator.waitForPreparation(),
    child.coordinator.waitForPreparation(),
  ]);
  assert.equal(child.coordinator.status().state, "discarded-stale");
  assert.equal(child.backend.calls.length, 0);
  parent.coordinator.dispose();
  child.coordinator.dispose();
});

test("commit scan must resolve an actual branch entry, not just a claimed ID", async () => {
  const f = fixture();
  const consumer = new FakeConsumer();
  f.coordinator.registerConsumer(consumer);
  await ready(f);
  f.appendSuffix();
  await f.coordinator.arbitrateHostCompaction();
  f.commit();
  f.state.entries.pop();
  f.state.latest = null;
  await f.coordinator.reconcileCommit(true);
  assert.equal(f.coordinator.status().state, "ready");
  assert.equal(consumer.adoptions.length, 0);
  f.coordinator.dispose();
});

test("a failing consumer rethrows without skipping other consumers, undoing history, or redelivering", async () => {
  const f = fixture();
  const error = new Error("first-consumer");
  const consumer = new FakeConsumer();
  let failingCalls = 0;
  f.coordinator.registerConsumer({
    id: "first",
    onAdopted: () => {
      failingCalls++;
      throw error;
    },
  });
  f.coordinator.registerConsumer(consumer);
  await ready(f);
  f.appendSuffix();
  await f.coordinator.arbitrateHostCompaction();
  f.commit();
  await assert.rejects(f.coordinator.reconcileCommit(), (cause: unknown) => cause === error);
  assert.equal(consumer.adoptions.length, 1);
  assert.equal(f.coordinator.status().state, "installed");
  await f.coordinator.reconcileCommit();
  assert.equal(consumer.adoptions.length, 1);
  assert.equal(failingCalls, 1);
  assert.ok(f.state.entries.some((entry) => entry.id === "host-assigned-entry"));
  f.coordinator.dispose();
});

test("consumer await invalidation stops later consumer delivery without touching the port", async () => {
  const f = fixture();
  const gate = deferred<void>();
  const later = new FakeConsumer("later");
  f.coordinator.registerConsumer({ id: "held", onAdopted: () => gate.promise });
  f.coordinator.registerConsumer(later);
  await ready(f);
  f.appendSuffix();
  await f.coordinator.arbitrateHostCompaction();
  f.commit();
  const acknowledged = f.coordinator.reconcileCommit();
  const calls = f.state.calls;
  f.state.ownerCurrent = false;
  gate.resolve();
  await acknowledged;
  assert.equal(f.state.calls, calls);
  assert.equal(later.adoptions.length, 0);
  assert.equal(f.coordinator.status().state, "installed");
  f.coordinator.dispose();
});

test("stale-context errors are contained at prepare, commit and reload boundaries; unrelated errors rethrow", async () => {
  const stale = new Error("stale host");
  const prep = fixture({ staleError: stale });
  prep.coordinator.registerParticipant({
    id: "stale",
    beforeSnapshot: () => Promise.reject(stale),
  });
  void prep.coordinator.requestPreparation();
  await prep.coordinator.waitForPreparation();
  assert.equal(prep.coordinator.status().state, "discarded-stale");
  prep.coordinator.dispose();
  const commit = fixture({ staleError: stale });
  await ready(commit);
  commit.appendSuffix();
  const record = commit.sink.records[0];
  assert.ok(record);
  await commit.coordinator.arbitrateHostCompaction();
  commit.port.findCommittedCandidate = () => {
    throw stale;
  };
  await commit.coordinator.reconcileCommit();
  assert.equal(commit.coordinator.status().state, "discarded-stale");
  commit.coordinator.dispose();
  const reload = fixture({ staleError: stale, generation: 2 });
  reload.port.getBranch = () => {
    throw stale;
  };
  assert.equal(await reload.coordinator.recover([record]), false);
  reload.coordinator.dispose();
});

test("reload after a committed candidate reconstructs installation and delivers a stable adoption ID once", async () => {
  const before = fixture();
  await ready(before);
  before.appendSuffix();
  await before.coordinator.arbitrateHostCompaction();
  before.commit();
  const record = before.sink.records[0];
  assert.ok(record);
  const branch = structuredClone(before.state.entries);
  const committed = before.state.committed;
  const latest = before.state.latest;
  before.coordinator.dispose();
  const after = fixture({ generation: 2 });
  after.state.entries = branch;
  after.state.committed = committed;
  after.state.latest = latest;
  const consumer = new FakeConsumer();
  after.coordinator.registerConsumer(consumer);
  assert.equal(await after.coordinator.recover([record]), true);
  assert.equal(after.coordinator.status().state, "installed");
  assert.equal(after.coordinator.status().committedEntryId, committed?.id);
  assert.equal(after.backend.calls.length, 0);
  assert.equal(after.state.proposals.length, 0);
  assert.equal(consumer.adoptions.length, 1);
  assert.equal(await after.coordinator.recover([record]), true);
  assert.equal(consumer.adoptions.length, 1);
  after.coordinator.dispose();
});

test("unexpected thrown undefined is not mistaken for successful background settlement", async () => {
  const f = fixture();
  f.coordinator.registerParticipant({
    id: "throw-undefined",
    beforeSnapshot: () => Promise.reject(undefined),
  });
  void f.coordinator.requestPreparation();
  await flush();
  let rejected = false;
  try {
    await f.coordinator.waitForPreparation();
  } catch (cause) {
    rejected = true;
    assert.equal(cause, undefined);
  }
  assert.equal(rejected, true);
  assert.equal(f.coordinator.status().state, "failed");
  f.coordinator.dispose();
});

test("synchronous invalidation in a port read stops the next port read", async () => {
  const f = fixture();
  const original = f.port.getBranch;
  f.port.getBranch = () => {
    const entries = original();
    f.state.ownerCurrent = false;
    return entries;
  };
  void f.coordinator.requestPreparation();
  await f.coordinator.waitForPreparation();
  assert.equal(f.state.calls, 1);
  assert.equal(f.coordinator.status().state, "discarded-stale");
  f.coordinator.dispose();
});

test("canonical snapshot fingerprint and additive retained-entry field survive preparation and installation", async () => {
  const f = fixture({ useCanonicalSnapshot: true });
  await ready(f);
  const snapshot = f.backend.calls[0]?.snapshot;
  assert.ok(snapshot);
  const fingerprint = fingerprintEntries(snapshot.entries);
  assert.equal(snapshot.prefixFingerprint, fingerprint);
  assert.equal(readFirstKeptEntryId(snapshot), f.state.entries[snapshot.entries.length]?.id);
  assert.ok(Object.isFrozen(snapshot.fileOps.read));
  assert.throws(() => snapshot.fileOps.read.add("unexpected"), /cannot be mutated/);
  assert.equal(f.sink.records[0]?.identity.prefixFingerprint, fingerprint);
  const result = await f.coordinator.arbitrateHostCompaction();
  assert.equal(result.action, "adopt");
  f.commit();
  await f.coordinator.reconcileCommit();
  assert.equal(f.state.committed?.fingerprint, fingerprint);
  assert.equal(f.coordinator.status().state, "installed");
  f.coordinator.dispose();
});

test("a suffix context edit of covered history is stale, not ordinary valid growth", async () => {
  const f = fixture();
  await ready(f);
  f.state.entries.push({
    type: "context_edit",
    id: "covered-edit",
    parentId: f.state.entries.at(-1)?.id ?? null,
    timestamp: "2026-01-01T00:00:00.000Z",
    targetId: f.history[0]?.id ?? "missing",
    replacement: { content: "edited" },
  });
  assert.deepEqual(await f.coordinator.arbitrateHostCompaction(), { action: "proceed" });
  assert.equal(f.coordinator.status().reason, "stale-prefix");
  assert.equal(f.state.proposals.length, 0);
  f.coordinator.dispose();
});

test("explicit owner invalidation permanently revokes the handle even if an external guard still says current", async () => {
  const f = fixture();
  await ready(f);
  const calls = f.state.calls;
  f.coordinator.invalidate();
  assert.deepEqual(await f.coordinator.requestPreparation(), {
    accepted: false,
    reason: "owner-changed",
  });
  assert.deepEqual(await f.coordinator.arbitrateHostCompaction(), { action: "proceed" });
  assert.equal(await f.coordinator.recover(f.sink.records), false);
  assert.equal(f.state.calls, calls);
  f.coordinator.dispose();
});

test("status separates preparation duration from ready/adoption wait and detaches usage", async () => {
  const f = fixture({ controlled: true });
  await f.coordinator.requestPreparation();
  await flush();
  f.clock.advance(5);
  f.backend.pending[0]?.resolve(buildCheckpoint("candidate-1"));
  await f.coordinator.waitForPreparation();
  f.clock.advance(20);
  assert.equal(f.coordinator.status().durationMs, 25);
  assert.equal(f.coordinator.status().preparationMs, 5);
  assert.equal(f.coordinator.status().queueDelayMs, 0);
  assert.equal(
    f.coordinator.status().estimatedReductionTokens,
    1000 - buildCheckpoint("candidate-1").usage.output,
  );
  const usage = f.coordinator.status().usage;
  assert.ok(usage);
  usage.output = 999;
  assert.equal(f.coordinator.status().usage?.output, buildCheckpoint("candidate-1").usage.output);
  f.appendSuffix();
  await f.coordinator.arbitrateHostCompaction();
  f.commit();
  f.clock.advance(3);
  await f.coordinator.reconcileCommit();
  assert.equal(f.coordinator.status().durationMs, 28);
  assert.equal(f.coordinator.status().preparationMs, 5);
  f.coordinator.dispose();
});

test("a rate-limit retry beyond the deadline aborts instead of overflowing a timer or spending more quota", async () => {
  const f = fixture({ controlled: true });
  await f.coordinator.requestPreparation();
  await flush();
  f.backend.pending[0]?.resolve({
    ok: false,
    reason: "429",
    retryable: true,
    retryAfterMs: 1_000_000_000_000,
  });
  await flush();
  assert.ok([...f.clock.timers.values()].every((timer) => timer.at <= 100));
  f.clock.advance(100);
  await f.coordinator.waitForPreparation();
  assert.equal(f.coordinator.status().reason, "timeout");
  assert.equal(f.backend.calls.length, 1);
  assert.equal(f.clock.timers.size, 0);
  f.coordinator.dispose();
});

test("an owner queued before another owner's rate limit rechecks shared cooldown before spending quota", async () => {
  const clock = new Clock();
  const first = fixture({
    clock,
    controlled: true,
    ownerKey: "cooldown-first",
    settings: { maxConcurrent: 1 },
  });
  const queued = fixture({ clock, ownerKey: "cooldown-queued", settings: { maxConcurrent: 1 } });
  await first.coordinator.requestPreparation();
  await flush();
  await queued.coordinator.requestPreparation();
  await flush();
  assert.equal(queued.coordinator.status().state, "queued");
  first.backend.pending[0]?.resolve({ ok: false, reason: "429", retryable: false });
  await Promise.all([
    first.coordinator.waitForPreparation(),
    queued.coordinator.waitForPreparation(),
  ]);
  assert.equal(queued.coordinator.status().state, "failed");
  assert.equal(queued.coordinator.status().reason, "quota");
  assert.equal(queued.backend.calls.length, 0);
  first.coordinator.dispose();
  queued.coordinator.dispose();
});
