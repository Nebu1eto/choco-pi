import assert from "node:assert/strict";
import test from "node:test";

import { type CoordinatorApi, isCandidateRecord } from "../src/background/contract.ts";
import {
  deliveredAdoptionsFor,
  getCoordinator,
  getRegistry,
  registerBackendFactory,
  registryAvailability,
  release,
  setCoordinator,
} from "../src/background/registry.ts";
import { buildCandidateRecord, FakeBackend, persistedCustomEntry } from "./background-fakes.ts";

function coordinator(ownerKey: string, ownerGeneration: number): CoordinatorApi {
  return {
    ownerKey,
    ownerGeneration,
    requestPreparation: () => Promise.resolve({ accepted: false, reason: "unsupported" }),
    cancel: () => {},
    status: () => ({ ownerKey, ownerGeneration, state: "idle" }),
    arbitrateHostCompaction: () => Promise.resolve({ action: "proceed" }),
    arbitrateManualCompact: () => Promise.resolve({ action: "proceed" }),
    registerConsumer: () => () => {},
    registerParticipant: () => () => {},
    dispose: () => {},
  };
}

test("candidate validator rejects missing versions, unknown envelope keys, malformed and inconsistent identities", async () => {
  const record = buildCandidateRecord();
  assert.equal(isCandidateRecord(record), true);
  assert.equal(
    isCandidateRecord((await persistedCustomEntry(record)).data),
    true,
    "validator accepts the record read back after session reopen",
  );
  const { schemaVersion: _schemaVersion, ...unversioned } = record;
  const { schemaVersion: _checkpointVersion, ...unversionedCheckpoint } = record.checkpoint;
  const invalid: unknown[] = [
    unversioned,
    { ...record, schemaVersion: 2 },
    { ...record, token: "not-a-credential" },
    { ...record, createdAt: "0" },
    { ...record, checkpoint: unversionedCheckpoint },
    { ...record, backendId: "different" },
    { ...record, identity: { ...record.identity, ownerGeneration: -1 } },
    { ...record, identity: { ...record.identity, priorCheckpointId: "older" } },
    {
      ...record,
      identity: {
        ...record.identity,
        providerScope: { ...record.identity.providerScope, apiKey: "not-a-credential" },
      },
    },
    {
      ...record,
      checkpoint: {
        ...record.checkpoint,
        draft: { ...record.checkpoint.draft, details: { strategy: "unknown" } },
      },
    },
    { ...record, checkpoint: { ...record.checkpoint, usage: { input: -1, output: 0 } } },
    { ...record, checkpoint: { ...record.checkpoint, reasonCodes: ["invented"] } },
    {
      ...record,
      checkpoint: {
        ...record.checkpoint,
        details: { ...record.checkpoint.details, nonJson: () => {} },
      },
    },
  ];
  for (const value of invalid) assert.equal(isCandidateRecord(value), false);
});

test("registry separates factory load order from session attachment and guards late release", () => {
  const registry = getRegistry();
  const ids = ["contract-test-text", "contract-test-native"];
  const owners = ["contract-test-first", "contract-test-second"];
  try {
    const first = coordinator(owners[0] ?? "first", 1);
    setCoordinator(first.ownerKey, first);
    const factory = () => new FakeBackend();
    assert.equal(registerBackendFactory(ids[0] ?? "text", factory), factory);
    assert.equal(
      registerBackendFactory(ids[0] ?? "text", () => new FakeBackend()),
      factory,
    );
    registerBackendFactory(ids[1] ?? "native", factory);
    const second = coordinator(owners[1] ?? "second", 1);
    setCoordinator(second.ownerKey, second);
    assert.equal(getCoordinator(first.ownerKey, 1), first);
    assert.equal(getCoordinator(second.ownerKey, 1), second);
    assert.equal(getCoordinator(first.ownerKey, 2), undefined);
    const replacement = coordinator(first.ownerKey, 2);
    setCoordinator(first.ownerKey, replacement);
    assert.equal(release(first.ownerKey, 1, first), false);
    assert.equal(getCoordinator(first.ownerKey), replacement);
    assert.throws(() => setCoordinator(first.ownerKey, first));
    assert.equal(release(first.ownerKey, 2, first), false);
    assert.equal(release(first.ownerKey, 2, replacement), true);
    assert.equal(getCoordinator(first.ownerKey), undefined);
    assert.equal(registry.backendFactories.get(ids[0] ?? "text"), factory);
    assert.equal(release(second.ownerKey, 1, second), true);
  } finally {
    for (const id of ids) registry.backendFactories.delete(id);
    for (const owner of owners) registry.coordinators.delete(owner);
  }
});

test("registry refuses a corrupt global slot without throwing, reusing or repairing it", () => {
  const symbol = Symbol.for("choco-pi:compaction-coordinator:v2");
  const existing = getRegistry();
  const corrupt = {
    schemaVersion: 2,
    backendFactories: new Map([["bad", 42]]),
    coordinators: new Map(),
    delivered: new Map(),
  };
  try {
    Object.defineProperty(globalThis, symbol, { value: corrupt, configurable: true });
    assert.deepEqual(registryAvailability(), { status: "conflict" });
    const detached = getRegistry();
    assert.notEqual(detached, corrupt);
    const factory = () => new FakeBackend();
    assert.equal(registerBackendFactory("contract-conflict", factory), factory);
    assert.equal(getRegistry().backendFactories.has("contract-conflict"), false);
    const owner = coordinator("contract-conflict-owner", 1);
    assert.equal(setCoordinator(owner.ownerKey, owner), false);
    assert.equal(getCoordinator(owner.ownerKey), undefined);
    assert.equal(release(owner.ownerKey, 1, owner), false);
    const ledger = deliveredAdoptionsFor(owner.ownerKey);
    ledger.set("adoption", new Set(["consumer"]));
    assert.equal(deliveredAdoptionsFor(owner.ownerKey).size, 0, "the ledger is detached");
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, symbol)?.value, corrupt);
    assert.deepEqual([...corrupt.backendFactories], [["bad", 42]]);
    assert.equal(corrupt.coordinators.size, 0);
    assert.equal(corrupt.delivered.size, 0);
  } finally {
    Object.defineProperty(globalThis, symbol, { value: existing, configurable: true });
  }
});
