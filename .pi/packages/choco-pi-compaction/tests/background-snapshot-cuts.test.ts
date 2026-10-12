/**
 * Frozen-prefix snapshot legality.
 *
 * Expectations are computed independently of the implementation: tool call/result
 * positions are scanned from the raw branch, and replay is checked by
 * appending a real compaction entry and projecting with the host's own
 * `buildSessionProjection`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

import {
  checkSnapshotLegality,
  findPrefixInvalidation,
  freezeSnapshot,
  isSnapshotRefusal,
  listLegalCuts,
  type FreezeOptions,
  type PrefixSnapshot,
} from "../src/background/snapshot.ts";
import { buildSnapshot } from "./background-fakes.ts";

const OPTIONS: Omit<FreezeOptions, "keepRecentTokens"> = {
  ownerKey: "session-1",
  ownerGeneration: 3,
  providerScope: { provider: "fixture", model: "fixture" },
  capturedAt: 42,
};

function usage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

type Message = SessionMessageEntry["message"];

/** Tree position of the next appended entry. */
interface EntryPosition {
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
}

/** Linear branch builder with deterministic IDs. */
class Branch {
  readonly entries: SessionEntry[] = [];
  private nextId(): EntryPosition {
    return {
      id: `e${this.entries.length}`,
      parentId: this.entries.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:00.000Z",
    };
  }
  message(message: Message): string {
    const entry: SessionEntry = { type: "message", ...this.nextId(), message };
    this.entries.push(entry);
    return entry.id;
  }
  user(text: string): string {
    return this.message({ role: "user", content: text, timestamp: 0 });
  }
  assistant(
    content: AssistantMessage["content"],
    stopReason: AssistantMessage["stopReason"],
  ): string {
    return this.message({
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: "fixture",
      model: "fixture",
      usage: usage(),
      stopReason,
      timestamp: 0,
    });
  }
  text(text: string): string {
    return this.assistant([{ type: "text", text }], "stop");
  }
  calls(ids: readonly string[], thinking?: string): string {
    const content: AssistantMessage["content"] = [];
    if (thinking !== undefined) {
      content.push({ type: "thinking", thinking, thinkingSignature: `sig-${ids.join("-")}` });
    }
    for (const id of ids) {
      content.push({ type: "toolCall", id, name: "read", arguments: { path: `/f/${id}` } });
    }
    return this.assistant(content, "toolUse");
  }
  result(id: string, text: string): string {
    return this.message({
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 0,
    });
  }
  state(): string {
    const entry: SessionEntry = { type: "custom", customType: "state", data: 1, ...this.nextId() };
    this.entries.push(entry);
    return entry.id;
  }
  edit(targetId: string, text: string): string {
    const entry: SessionEntry = {
      type: "context_edit",
      targetId,
      replacement: { content: text },
      ...this.nextId(),
    };
    this.entries.push(entry);
    return entry.id;
  }
  compaction(summary: string, firstKeptEntryId: string, details?: SessionEntry): string {
    const entry: SessionEntry = {
      type: "compaction",
      summary,
      firstKeptEntryId,
      tokensBefore: 0,
      ...this.nextId(),
    };
    if (details?.type === "compaction") entry.details = details.details;
    this.entries.push(entry);
    return entry.id;
  }
}

function freeze(
  entries: readonly SessionEntry[],
  keepRecentTokens: number,
  maxKeepTokens?: number,
): PrefixSnapshot {
  const options: FreezeOptions =
    maxKeepTokens === undefined
      ? { ...OPTIONS, keepRecentTokens }
      : { ...OPTIONS, keepRecentTokens, maxKeepTokens };
  const result = freezeSnapshot(entries, options);
  if (isSnapshotRefusal(result)) {
    assert.fail(`unexpected refusal ${result.reason}/${result.detail}`);
  }
  return result;
}

function toolCallIds(message: AssistantMessage): string[] {
  return message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
}

/** Independent check: raw positions of each call and its results. */
function expectNoSplitToolGroup(entries: readonly SessionEntry[], cutIndex: number): void {
  const callAt = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") for (const id of toolCallIds(message)) callAt.set(id, index);
    if (message.role === "toolResult") {
      const call = callAt.get(message.toolCallId);
      if (call === undefined) continue;
      assert.equal(
        call <= cutIndex,
        index <= cutIndex,
        `call ${message.toolCallId} at ${call} and its result at ${index} straddle cut ${cutIndex}`,
      );
    }
  }
  const last = entries[cutIndex];
  if (last?.type === "message" && last.message.role === "assistant") {
    assert.notEqual(last.message.stopReason, "toolUse", "prefix ends with an open batch");
  }
}

/** Every call/result of the retained range appears exactly once after replay. */
function assertExactReplay(entries: readonly SessionEntry[], snapshot: PrefixSnapshot): void {
  const leaf = entries.at(-1);
  assert.ok(leaf);
  const checkpoint: SessionEntry = {
    type: "compaction",
    id: "replay-checkpoint",
    parentId: leaf.id,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "SUMMARY",
    firstKeptEntryId: snapshot.firstKeptEntryId,
    tokensBefore: 0,
  };
  const replay = buildSessionProjection([...entries, checkpoint]);
  const original = buildSessionProjection([...entries]);
  const keptIndex = entries.findIndex((entry) => entry.id === snapshot.firstKeptEntryId);
  const keptIds = new Set(entries.slice(keptIndex).map((entry) => entry.id));
  const expected = original.entries
    .filter((entry) => keptIds.has(entry.sourceEntry.id) && entry.sourceEntry.type !== "compaction")
    .flatMap((entry) => entry.messages)
    .filter((message) => message.role !== "system");
  const replayed = replay.messages;
  assert.equal(replayed[0]?.role, "compactionSummary");
  assert.deepEqual(replayed.slice(1), expected, "checkpoint + suffix equals the original suffix");

  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const [position, message] of replayed.entries()) {
    if (message.role === "assistant") {
      for (const id of toolCallIds(message)) calls.set(id, (calls.get(id) ?? 0) + 1);
    } else if (message.role === "toolResult") {
      results.set(message.toolCallId, (results.get(message.toolCallId) ?? 0) + 1);
      assert.ok(
        calls.has(message.toolCallId),
        `result ${message.toolCallId} at ${position} lacks its call`,
      );
    }
  }
  const originalResults = new Map<string, number>();
  for (const message of original.messages) {
    if (message.role === "toolResult") {
      originalResults.set(message.toolCallId, (originalResults.get(message.toolCallId) ?? 0) + 1);
    }
  }
  for (const [id, count] of calls) {
    assert.equal(count, 1, `call ${id} replayed ${count} times`);
    // A batch still running at the leaf legitimately has fewer results; it
    // must have exactly as many after replay as before.
    assert.equal(results.get(id) ?? 0, originalResults.get(id) ?? 0, `call ${id} results`);
    assert.ok((results.get(id) ?? 0) <= 1, `call ${id} has duplicate results`);
  }
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

/** Random transcript: user turns of parallel tool batches, reasoning bundles, state entries. */
function randomBranch(seed: number): Branch {
  const next = lcg(seed);
  const branch = new Branch();
  let call = 0;
  const turns = 2 + (next() % 4);
  for (let turn = 0; turn < turns; turn++) {
    branch.user(`request ${seed}-${turn} ${"u".repeat(next() % 200)}`);
    const batches = next() % 6;
    for (let batch = 0; batch < batches; batch++) {
      const ids = Array.from({ length: 1 + (next() % 3) }, () => `c${seed}-${call++}`);
      branch.calls(ids, next() % 2 === 0 ? `think ${batch}` : undefined);
      if (next() % 4 === 0) branch.state();
      for (const id of ids) branch.result(id, `out ${id} ${"r".repeat(next() % 400)}`);
      if (next() % 5 === 0) branch.text(`note ${batch}`);
    }
    branch.text(`done ${turn} ${"a".repeat(next() % 300)}`);
  }
  return branch;
}

/** Representative random transcript with both split-turn and whole-turn cuts across KEEP_WINDOWS. */
const REPRESENTATIVE_SEED = 4;
const KEEP_WINDOWS = [20, 60, 100, 140, 180, 220, 260];

test("representative transcript: every chosen cut is legal, exact on replay, and deterministic", () => {
  const branch = randomBranch(REPRESENTATIVE_SEED);
  const splitTurns = new Set<boolean>();
  for (const keep of KEEP_WINDOWS) {
    const result = freeze(branch.entries, keep);
    splitTurns.add(result.splitTurn);
    const cutIndex = branch.entries.findIndex((entry) => entry.id === result.cutEntryId);
    assert.equal(result.entries.length, cutIndex + 1);
    assert.equal(branch.entries[cutIndex + 1]?.id, result.firstKeptEntryId);
    assert.deepEqual(result.entries, branch.entries.slice(0, cutIndex + 1));
    expectNoSplitToolGroup(branch.entries, cutIndex);
    assertExactReplay(branch.entries, result);
    assert.deepEqual(checkSnapshotLegality(result), { legal: true }, `keep ${keep}`);
    const again = freeze(branch.entries, keep);
    assert.equal(again.cutEntryId, result.cutEntryId);
    assert.equal(again.prefixFingerprint, result.prefixFingerprint);
    assert.equal(findPrefixInvalidation(result, branch.entries), null);
  }
  assert.equal(splitTurns.size, 2, "both split-turn and whole-turn cuts exercised");
});

test("snapshot is detached, deeply frozen, and carries owner scalars", () => {
  const branch = randomBranch(7);
  const snapshot = freeze(branch.entries, 50);
  assert.notEqual(snapshot.entries[0], branch.entries[0]);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.entries));
  const first = snapshot.entries[0];
  assert.ok(first?.type === "message");
  assert.ok(Object.isFrozen(first.message));
  assert.equal(snapshot.ownerKey, "session-1");
  assert.equal(snapshot.ownerGeneration, 3);
  assert.deepEqual(snapshot.providerScope, { provider: "fixture", model: "fixture" });
  assert.equal(snapshot.capturedAt, 42);
  assert.ok(snapshot.tokenEstimate > 0);
  assert.ok(snapshot.prefixFingerprint.startsWith("sha256:"));
  assert.ok(snapshot.fileOps.read.size > 0, "read tool calls are recorded");
  assert.equal(snapshot.priorCheckpointId, null);
  assert.equal(snapshot.priorCheckpointVersion, null);
});

test("parallel batch: a partly answered batch at the leaf is never summarized", () => {
  const branch = new Branch();
  branch.user("first request");
  branch.calls(["first-call"]);
  branch.result("first-call", "x".repeat(800));
  branch.text("first done");
  branch.user("second request");
  const batch = branch.calls(["b1", "b2", "b3"], "reasoning bundle");
  branch.result("b1", "y".repeat(800));
  branch.result("b2", "z".repeat(800));
  const snapshot = freeze(branch.entries, 1);
  const batchIndex = branch.entries.findIndex((entry) => entry.id === batch);
  const cutIndex = branch.entries.findIndex((entry) => entry.id === snapshot.cutEntryId);
  assert.ok(cutIndex < batchIndex, "cut precedes the unresolved batch");
  expectNoSplitToolGroup(branch.entries, cutIndex);
  assertExactReplay(branch.entries, snapshot);
});

test("a turn-start message between a call and its result never opens a cut there", () => {
  for (let keep = 1; keep <= 400; keep += 7) {
    const branch = new Branch();
    branch.user("request");
    branch.text("r".repeat(800));
    branch.user("second");
    branch.calls(["x1", "x2"], "bundle");
    branch.result("x1", "a".repeat(200));
    const steer: SessionEntry = {
      type: "custom_message",
      id: `e${branch.entries.length}`,
      parentId: branch.entries.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:00.000Z",
      customType: "steer",
      content: "interleaved",
      display: false,
    };
    branch.entries.push(steer);
    branch.result("x2", "b".repeat(200));
    branch.text("t".repeat(200));
    const result = freezeSnapshot(branch.entries, { ...OPTIONS, keepRecentTokens: keep });
    if (isSnapshotRefusal(result)) continue;
    const cutIndex = branch.entries.findIndex((entry) => entry.id === result.cutEntryId);
    expectNoSplitToolGroup(branch.entries, cutIndex);
    assertExactReplay(branch.entries, result);
  }
});

test("a mid-batch steering message never abandons a still-running batch", () => {
  const branch = new Branch();
  branch.user("request");
  branch.text("r".repeat(2000));
  branch.user("second");
  const batch = branch.calls(["x1", "x2", "x3"], "bundle");
  branch.result("x1", "a".repeat(400));
  branch.entries.push({
    type: "custom_message",
    id: `e${branch.entries.length}`,
    parentId: branch.entries.at(-1)?.id ?? null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "steer",
    content: "interleaved",
    display: false,
  });
  branch.result("x2", "b".repeat(400));
  for (const keep of [1, 50, 150, 300]) {
    const result = freezeSnapshot(branch.entries, { ...OPTIONS, keepRecentTokens: keep });
    if (isSnapshotRefusal(result)) continue;
    const cutIndex = branch.entries.findIndex((entry) => entry.id === result.cutEntryId);
    const batchIndex = branch.entries.findIndex((entry) => entry.id === batch);
    assert.ok(cutIndex < batchIndex, `keep ${keep}: cut ${cutIndex} entered the running batch`);
  }
  const batchIndex = branch.entries.findIndex((entry) => entry.id === batch);
  for (const cut of listLegalCuts([...branch.entries, steeringUser(branch)])) {
    const cutIndex = branch.entries.findIndex((entry) => entry.id === cut.cutEntryId);
    assert.ok(cutIndex < batchIndex, `legal cut ${cut.cutEntryId} entered the running batch`);
  }
});

function steeringUser(branch: Branch): SessionEntry {
  return {
    type: "message",
    id: "steer-user",
    parentId: branch.entries.at(-1)?.id ?? null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "steer while tools run", timestamp: 0 },
  };
}

/** The representative branch with a hidden custom message inserted inside its first tool batch. */
function branchWithInterleavedSteer(): SessionEntry[] {
  const branch = randomBranch(REPRESENTATIVE_SEED);
  const insertAt = branch.entries.findIndex(
    (entry) => entry.type === "message" && entry.message.role === "toolResult",
  );
  const entries: SessionEntry[] = [];
  for (const [index, entry] of branch.entries.entries()) {
    if (index === insertAt) {
      entries.push({
        type: "custom_message",
        id: "interleaved-steer",
        parentId: entries.at(-1)?.id ?? null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "steer",
        content: "interleaved",
        display: false,
      });
    }
    entries.push({ ...entry, parentId: entries.at(-1)?.id ?? null });
  }
  return entries;
}

test("every enumerated legal cut keeps tool groups whole", () => {
  const entries = branchWithInterleavedSteer();
  const cuts = listLegalCuts(entries);
  assert.ok(cuts.length > 20, `only ${cuts.length} cuts enumerated`);
  for (const cut of cuts) {
    const cutIndex = entries.findIndex((entry) => entry.id === cut.cutEntryId);
    assert.equal(entries[cutIndex + 1]?.id, cut.firstKeptEntryId);
    expectNoSplitToolGroup(entries, cutIndex);
  }
});

test("a late result for a summarized call invalidates the snapshot", () => {
  const withCall = new Branch();
  withCall.user("go");
  withCall.calls(["y1"]);
  withCall.result("y1", "r".repeat(2000));
  withCall.user("next");
  withCall.text("t".repeat(400));
  const callSnapshot = freeze(withCall.entries, 50);
  assert.equal(findPrefixInvalidation(callSnapshot, withCall.entries), null);
  const late = [...withCall.entries];
  late.push({
    type: "message",
    id: "late-result",
    parentId: late.at(-1)?.id ?? null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: "y1",
      toolName: "read",
      content: [{ type: "text", text: "dup" }],
      isError: false,
      timestamp: 0,
    },
  });
  assert.equal(findPrefixInvalidation(callSnapshot, late), "stale-prefix");
});

test("split turn in a single-prompt child transcript carries the governing request", () => {
  const branch = new Branch();
  const request = branch.user("CHILD-PROMPT: audit every module");
  for (let index = 0; index < 30; index++) {
    branch.calls([`k${index}a`, `k${index}b`], `plan ${index}`);
    branch.result(`k${index}a`, "a".repeat(400));
    branch.result(`k${index}b`, "b".repeat(400));
  }
  const snapshot = freeze(branch.entries, 600);
  assert.equal(snapshot.splitTurn, true);
  assert.deepEqual(snapshot.governingUserRequest, {
    entryId: request,
    content: "CHILD-PROMPT: audit every module",
  });
  const cutIndex = branch.entries.findIndex((entry) => entry.id === snapshot.cutEntryId);
  const firstKept = branch.entries[cutIndex + 1];
  assert.ok(firstKept?.type === "message" && firstKept.message.role === "assistant");
  expectNoSplitToolGroup(branch.entries, cutIndex);
  assertExactReplay(branch.entries, snapshot);
});

test("a complete user-turn boundary is preferred when keeping that turn is affordable", () => {
  const branch = new Branch();
  branch.user("old request");
  branch.text("o".repeat(4000));
  const turn = branch.user("current request");
  for (let index = 0; index < 4; index++) {
    branch.calls([`t${index}`]);
    branch.result(`t${index}`, "r".repeat(400));
  }
  const preferred = freeze(branch.entries, 300, 10_000);
  assert.equal(preferred.splitTurn, false);
  assert.equal(preferred.firstKeptEntryId, turn);
  assert.equal(preferred.governingUserRequest, null);

  const split = freeze(branch.entries, 300, 300);
  assert.equal(split.splitTurn, true);
  assert.equal(split.governingUserRequest?.entryId, turn);
});

test("a context edit after the cut never targets a summarized entry", () => {
  const branch = new Branch();
  branch.user("request");
  const target = branch.text("p".repeat(2000));
  branch.user("next");
  branch.text("q".repeat(2000));
  branch.user("later");
  branch.text("s".repeat(400));
  branch.edit(target, "edited");
  const result = freezeSnapshot(branch.entries, { ...OPTIONS, keepRecentTokens: 50 });
  if (!isSnapshotRefusal(result)) {
    const targetIndex = branch.entries.findIndex((entry) => entry.id === target);
    const cutIndex = branch.entries.findIndex((entry) => entry.id === result.cutEntryId);
    assert.ok(cutIndex < targetIndex, "cut keeps the edited target retained");
  }
  const late = new Branch();
  late.user("request");
  late.text("p".repeat(2000));
  late.user("next");
  late.text("q".repeat(2000));
  const snapshot = freeze(late.entries, 50);
  const edited = [...late.entries];
  const leaf = edited.at(-1);
  assert.ok(leaf);
  edited.push({
    type: "context_edit",
    id: "late-edit",
    parentId: leaf.id,
    timestamp: "2026-01-01T00:00:00.000Z",
    targetId: snapshot.cutEntryId,
    replacement: null,
  });
  assert.equal(findPrefixInvalidation(snapshot, edited), "stale-prefix");
});

test("prior checkpoint: identity, version, and summarized range start after it", () => {
  const branch = new Branch();
  branch.user("before");
  branch.text("b".repeat(2000));
  const kept = branch.user("kept request");
  branch.text("k".repeat(400));
  const prior = branch.compaction("PRIOR SUMMARY", kept);
  branch.user("after request");
  branch.text("x".repeat(2000));
  branch.user("latest");
  branch.text("y".repeat(400));
  const snapshot = freeze(branch.entries, 100);
  assert.equal(snapshot.priorCheckpointId, prior);
  assert.equal(snapshot.priorCheckpointVersion, 1);
  const priorIndex = branch.entries.findIndex((entry) => entry.id === prior);
  const cutIndex = branch.entries.findIndex((entry) => entry.id === snapshot.cutEntryId);
  assert.ok(cutIndex >= priorIndex);
  assertExactReplay(branch.entries, snapshot);
  const moved = [...branch.entries];
  const leaf = moved.at(-1);
  assert.ok(leaf);
  moved.push({
    type: "compaction",
    id: "newer",
    parentId: leaf.id,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "newer",
    firstKeptEntryId: leaf.id,
    tokensBefore: 0,
  });
  assert.equal(findPrefixInvalidation(snapshot, moved), "checkpoint-changed");
});

test("split turn after a prior text checkpoint recovers the carried governing request", () => {
  const branch = new Branch();
  branch.calls(["p0"]);
  branch.result("p0", "z".repeat(100));
  const keptId = branch.calls(["p1"]);
  branch.result("p1", "z".repeat(100));
  const prior: SessionEntry = {
    type: "compaction",
    id: "unused",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "s",
    firstKeptEntryId: keptId,
    tokensBefore: 0,
    details: {
      strategy: "local-reconciled",
      schemaVersion: 1,
      readFiles: [],
      modifiedFiles: [],
      passes: 1,
      evidence: { historyEntryIds: null, tailEntryIds: null },
      candidateId: "cand-0",
      fingerprint: "sha256:0",
      background: {
        schemaVersion: 1,
        mode: "frozen-prefix",
        cutEntryId: "e0",
        firstKeptEntryId: keptId,
        splitTurn: true,
        governingRequest: { entryId: "gone", content: "CARRIED REQUEST", truncated: false },
        priorCheckpointId: null,
        priorCheckpointVersion: null,
        evidenceEntryIds: null,
      },
    },
  };
  branch.compaction("PRIOR", keptId, prior);
  for (let index = 2; index < 12; index++) {
    branch.calls([`p${index}`]);
    branch.result(`p${index}`, "w".repeat(600));
  }
  const snapshot = freeze(branch.entries, 300);
  assert.equal(snapshot.splitTurn, true);
  assert.deepEqual(snapshot.governingUserRequest, { entryId: "gone", content: "CARRIED REQUEST" });
});

test("refusals are typed and leave the branch untouched", () => {
  const empty = freezeSnapshot([], { ...OPTIONS, keepRecentTokens: 10 });
  assert.ok(isSnapshotRefusal(empty) && empty.detail === "empty-branch");

  const small = new Branch();
  small.user("hi");
  small.text("hello");
  const tooSmall = freezeSnapshot(small.entries, { ...OPTIONS, keepRecentTokens: 10_000 });
  assert.ok(isSnapshotRefusal(tooSmall));
  assert.equal(tooSmall.reason, "no-legal-cut");

  const open = new Branch();
  open.user("go");
  open.calls(["o1", "o2"]);
  open.result("o1", "partial");
  const kept = freeze(open.entries, 1);
  assert.equal(kept.cutEntryId, "e0", "only the request is summarized; the batch stays whole");
  assert.equal(kept.splitTurn, true);

  const batchOnly = new Branch();
  batchOnly.calls(["o1", "o2"]);
  batchOnly.result("o1", "partial");
  const before = structuredClone(batchOnly.entries);
  const openResult = freezeSnapshot(batchOnly.entries, { ...OPTIONS, keepRecentTokens: 1 });
  assert.ok(isSnapshotRefusal(openResult), "every cut would split the running batch");
  assert.equal(openResult.detail, "no-legal-cut");
  assert.equal(openResult.retryable, true);
  assert.deepEqual(batchOnly.entries, before);

  const orphan = new Branch();
  for (let index = 0; index < 6; index++) {
    orphan.calls([`n${index}`]);
    orphan.result(`n${index}`, "v".repeat(400));
  }
  const noGoverning = freezeSnapshot(orphan.entries, { ...OPTIONS, keepRecentTokens: 100 });
  assert.ok(isSnapshotRefusal(noGoverning));
  assert.equal(noGoverning.detail, "split-turn-without-governing-request");

  const broken = randomBranch(3).entries.map((entry, index) =>
    index === 2 ? { ...entry, parentId: "elsewhere" } : entry,
  );
  const brokenResult = freezeSnapshot(broken, { ...OPTIONS, keepRecentTokens: 10 });
  assert.ok(isSnapshotRefusal(brokenResult) && brokenResult.detail === "broken-chain");
});

test("legality re-check rejects tampered or foreign snapshots", () => {
  const branch = randomBranch(11);
  const snapshot = freeze(branch.entries, 50);
  assert.deepEqual(checkSnapshotLegality({ ...snapshot, prefixFingerprint: "sha256:bad" }), {
    legal: false,
    reason: "malformed",
  });
  assert.deepEqual(checkSnapshotLegality({ ...snapshot, cutEntryId: "missing" }), {
    legal: false,
    reason: "malformed",
  });
  assert.deepEqual(checkSnapshotLegality(buildSnapshot()), {
    legal: false,
    reason: "malformed",
  });
  const { firstKeptEntryId: _dropped, ...withoutFirstKept } = snapshot;
  assert.deepEqual(checkSnapshotLegality(withoutFirstKept), {
    legal: false,
    reason: "incompatible",
  });
});
