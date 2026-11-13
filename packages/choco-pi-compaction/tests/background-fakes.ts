import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CustomEntry,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  Adoption,
  AdoptionConsumer,
  AppendRecord,
  Backend,
  CandidateRecord,
  CapabilityVerdict,
  FrozenSnapshot,
  LegalityVerdict,
  ParticipantContext,
  PreparedCheckpoint,
  PrepareFailure,
  PreparationBudget,
  PreSnapshotParticipant,
  ProviderScope,
} from "../src/background/contract.ts";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
}
export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred not initialized");
  };
  let reject: (reason: Error) => void = () => {
    throw new Error("Deferred not initialized");
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
/** Append through `append` to a real session file, reopen it, and return the entry read back. */
export async function reopenedEntry(
  append: (manager: SessionManager) => string,
): Promise<SessionEntry> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-persist-"));
  try {
    const manager = SessionManager.create(dir, dir);
    // The session file is first written once the branch holds a user or assistant message.
    manager.appendMessage({ role: "user", content: "persist", timestamp: 0 });
    const id = append(manager);
    const file = manager.getSessionFile();
    assert.ok(file, "persistent session file");
    const entry = SessionManager.open(file, dir).getEntry(id);
    assert.ok(entry, "entry survives session reopen");
    return entry;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
/** `data` appended as a custom entry, as read back from the reopened session. */
export async function persistedCustomEntry<T>(data: T): Promise<CustomEntry> {
  const entry = await reopenedEntry((manager) =>
    manager.appendCustomEntry("choco-compaction-candidate", data),
  );
  assert.ok(entry.type === "custom", "custom entry survives reopen");
  return entry;
}
export function buildCheckpoint(
  candidateId = "candidate-1",
  backendId = "fake",
): PreparedCheckpoint<{ strategy: "local-reconciled"; schemaVersion: 1 }> {
  const details = { strategy: "local-reconciled", schemaVersion: 1 } satisfies {
    strategy: "local-reconciled";
    schemaVersion: 1;
  };
  return {
    candidateId,
    backendId,
    schemaVersion: 1,
    draft: {
      type: "compaction",
      summary: "Frozen prefix summary",
      firstKeptEntryId: null,
      details,
    },
    details,
    usage: { input: 100, output: 10 },
    reasonCodes: ["prepared"],
  };
}
/** Deterministic paired tool fixtures, including parallel batches; no clock/random dependency. */
export function seededToolPairs(seed = 1, batches = 4): SessionEntry[] {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const entries: SessionEntry[] = [];
  const add = (message: Extract<SessionEntry, { type: "message" }>["message"]) => {
    const id = `entry-${entries.length}`;
    entries.push({
      type: "message",
      id,
      parentId: entries.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message,
    });
  };
  add({ role: "user", content: `Governing request ${seed}`, timestamp: 0 });
  for (let batch = 0; batch < batches; batch++) {
    const ids = Array.from({ length: 1 + (next() % 3) }, (_, index) => `call-${batch}-${index}`);
    add({
      role: "assistant",
      content: ids.map((id) => ({
        type: "toolCall",
        id,
        name: "fixture",
        arguments: { value: next() },
      })),
      api: "anthropic-messages",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: batch,
    });
    for (const id of ids)
      add({
        role: "toolResult",
        toolCallId: id,
        toolName: "fixture",
        content: [{ type: "text", text: `result-${next()}` }],
        isError: false,
        timestamp: batch,
      });
  }
  return entries;
}
export function buildSnapshot(overrides: Partial<FrozenSnapshot> = {}): FrozenSnapshot {
  const entries = seededToolPairs();
  return {
    cutEntryId: entries.at(-1)?.id ?? "entry-0",
    prefixFingerprint: "fingerprint-1",
    priorCheckpointId: null,
    priorCheckpointVersion: null,
    ownerKey: "session-1",
    ownerGeneration: 1,
    providerScope: { provider: "fixture", model: "fixture" },
    entries,
    splitTurn: true,
    governingUserRequest: { entryId: "entry-0", content: "Governing request 1" },
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    tokenEstimate: 1000,
    capturedAt: 0,
    ...overrides,
  };
}
export function buildCandidateRecord(): CandidateRecord {
  const snapshot = buildSnapshot();
  const checkpoint = buildCheckpoint();
  return {
    customType: "choco-compaction-candidate",
    schemaVersion: 1,
    candidateId: "candidate-1",
    backendId: "fake",
    identity: {
      cutEntryId: snapshot.cutEntryId,
      prefixFingerprint: snapshot.prefixFingerprint,
      priorCheckpointId: null,
      priorCheckpointVersion: null,
      ownerKey: snapshot.ownerKey,
      ownerGeneration: snapshot.ownerGeneration,
      providerScope: snapshot.providerScope,
    },
    createdAt: 0,
    checkpoint: { ...checkpoint, reasonCodes: [...checkpoint.reasonCodes] },
  };
}
export class FakeBackend implements Backend {
  readonly id: string;
  readonly calls: {
    snapshot: FrozenSnapshot;
    signal: AbortSignal;
    budget: PreparationBudget;
    candidateId: string;
  }[] = [];
  readonly pending: Deferred<PreparedCheckpoint | PrepareFailure>[] = [];
  capabilityVerdict: CapabilityVerdict = { supported: true };
  legalityVerdict: LegalityVerdict = { legal: true };
  result: PreparedCheckpoint | PrepareFailure | undefined;
  controlled: boolean;
  constructor(
    options: {
      id?: string;
      result?: PreparedCheckpoint | PrepareFailure;
      controlled?: boolean;
    } = {},
  ) {
    this.id = options.id ?? "fake";
    this.result = options.result;
    this.controlled = options.controlled ?? false;
  }
  capability(_scope: ProviderScope): Promise<CapabilityVerdict> {
    return Promise.resolve(this.capabilityVerdict);
  }
  isLegalCut(_snapshot: FrozenSnapshot): LegalityVerdict {
    return this.legalityVerdict;
  }
  prepare(
    snapshot: FrozenSnapshot,
    options: { signal: AbortSignal; budget: PreparationBudget; candidateId: string },
  ): Promise<PreparedCheckpoint | PrepareFailure> {
    this.calls.push({ snapshot, ...options });
    if (options.signal.aborted)
      return Promise.resolve({ ok: false, reason: "canceled", retryable: false });
    if (!this.controlled)
      return Promise.resolve(this.result ?? buildCheckpoint(options.candidateId, this.id));
    const pending = deferred<PreparedCheckpoint | PrepareFailure>();
    this.pending.push(pending);
    return pending.promise;
  }
}
/** Spy deliberately does not deduplicate: duplicate coordinator notifications stay visible. */
export class FakeConsumer implements AdoptionConsumer {
  readonly id: string;
  readonly adoptions: Adoption[] = [];
  readonly counts = new Map<string, number>();
  constructor(id = "fake-consumer") {
    this.id = id;
  }
  onAdopted(adoption: Adoption): void {
    this.adoptions.push(adoption);
    this.counts.set(adoption.adoptionId, (this.counts.get(adoption.adoptionId) ?? 0) + 1);
  }
}
export class FakeParticipant implements PreSnapshotParticipant {
  readonly id: string;
  readonly calls: ParticipantContext[] = [];
  appendedEntryIds: readonly string[];
  constructor(appendedEntryIds: readonly string[] = [], id = "fake-participant") {
    this.id = id;
    this.appendedEntryIds = appendedEntryIds;
  }
  beforeSnapshot(context: ParticipantContext): Promise<{ appendedEntryIds: readonly string[] }> {
    this.calls.push(context);
    return Promise.resolve({ appendedEntryIds: [...this.appendedEntryIds] });
  }
}
export interface FakeRecordSink {
  records: CandidateRecord[];
  appendRecord: AppendRecord;
}
export function fakeAppendRecordSink(): FakeRecordSink {
  const records: CandidateRecord[] = [];
  return {
    records,
    appendRecord: (record) => {
      records.push(structuredClone(record));
    },
  };
}
