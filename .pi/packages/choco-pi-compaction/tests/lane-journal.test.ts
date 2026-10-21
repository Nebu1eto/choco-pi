/** Lane journal: strict schema, validated append, reader, transition memo, model invisibility. */
import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import {
  appendLaneRecord,
  LANE_RECORD_TYPE,
  type LaneRecord,
  type LaneRecordInput,
  LaneRecordSchema,
  laneRecordsOf,
  LaneTransitionMemo,
  ownedReasonOf,
  REASONS,
} from "../src/background/lane-journal.ts";

const STALE = new Error("This extension ctx is stale after session replacement or reload.");

function input(overrides: Partial<LaneRecordInput> = {}): LaneRecordInput {
  return {
    at: 1,
    sessionId: "session-1",
    provider: "anthropic",
    route: "replay",
    event: "disable",
    from: "anthropic-native",
    reason: "details-invalid",
    checkpointEntryId: "entry-1",
    noticeAttempted: true,
    ...overrides,
  };
}

function record(overrides: Partial<LaneRecordInput> = {}): LaneRecord {
  return { customType: LANE_RECORD_TYPE, schemaVersion: 1, ...input(overrides) };
}

test("the schema rejects extra keys and a detail over 128 characters", () => {
  assert.equal(Value.Check(LaneRecordSchema, record()), true);
  assert.equal(Value.Check(LaneRecordSchema, { ...record(), message: "provider text" }), false);
  assert.equal(Value.Check(LaneRecordSchema, record({ detail: "x".repeat(128) })), true);
  assert.equal(Value.Check(LaneRecordSchema, record({ detail: "x".repeat(129) })), false);
});

test("a provider-supplied code maps to provider-error; owned codes map to themselves", () => {
  assert.equal(ownedReasonOf("compaction_private-payload"), "provider-error");
  assert.equal(ownedReasonOf("compaction_signature_invalid"), "provider-error");
  assert.equal(ownedReasonOf("Invalid signature in compaction block"), "provider-error");
  assert.equal(ownedReasonOf(""), "provider-error");
  assert.equal(ownedReasonOf("noCapture"), "provider-error", "a key name is not a code");
  for (const code of Object.values(REASONS)) assert.equal(ownedReasonOf(code), code);
});

test("the schema admits exactly the owned reason codes", () => {
  for (const code of Object.values(REASONS)) {
    assert.equal(Value.Check(LaneRecordSchema, record({ reason: code })), true, code);
  }
  const unknown = { ...record(), reason: "compaction_private-payload" };
  assert.equal(Value.Check(LaneRecordSchema, unknown), false);
  assert.equal(Value.Check(LaneRecordSchema, { ...record(), reason: "x".repeat(65) }), false);
  assert.equal(
    laneRecordsOf([{ type: "custom", customType: LANE_RECORD_TYPE, data: unknown }]).length,
    0,
  );
});

test("appendLaneRecord appends a valid record with its envelope and no undefined keys", () => {
  const appended: { type: string; data: LaneRecord }[] = [];
  const reports: string[] = [];
  const ok = appendLaneRecord(
    (type, data) => appended.push({ type, data }),
    input({ to: undefined, detail: undefined }),
    (message) => reports.push(message),
  );
  assert.equal(ok, true);
  assert.deepEqual(reports, []);
  assert.deepEqual(appended, [{ type: LANE_RECORD_TYPE, data: record() }]);
  const data = appended[0]?.data;
  assert.ok(data !== undefined);
  assert.equal(Object.hasOwn(data, "to"), false);
  assert.equal(Object.hasOwn(data, "detail"), false);
});

test("appendLaneRecord drops and reports an invalid record", () => {
  const appended: unknown[] = [];
  const reports: string[] = [];
  const ok = appendLaneRecord(
    (_type, data) => appended.push(data),
    input({ detail: "x".repeat(200) }),
    (message) => reports.push(message),
  );
  assert.equal(ok, false);
  assert.deepEqual(appended, []);
  assert.deepEqual(reports, ["lane journal: dropped invalid record: /detail"]);
});

test("appendLaneRecord contains a stale-context failure and rethrows any other", () => {
  const report = () => assert.fail("no report expected");
  assert.equal(
    appendLaneRecord(
      () => {
        throw STALE;
      },
      input(),
      report,
    ),
    false,
  );
  const other = new Error("disk full");
  assert.throws(
    () =>
      appendLaneRecord(
        () => {
          throw other;
        },
        input(),
        report,
      ),
    (cause) => cause === other,
  );
});

test("laneRecordsOf keeps only valid lane records", () => {
  const entries = [
    { type: "custom", customType: LANE_RECORD_TYPE, data: record() },
    { type: "custom", customType: "choco-compaction-candidate", data: record() },
    { type: "custom", customType: LANE_RECORD_TYPE, data: { ...record(), extra: 1 } },
    { type: "custom_message", customType: LANE_RECORD_TYPE, data: record() },
    { type: "custom", customType: LANE_RECORD_TYPE, data: record({ event: "consent" }) },
  ];
  assert.deepEqual(laneRecordsOf(entries), [record(), record({ event: "consent" })]);
});

test("the transition memo dedupes (route, event, reason, checkpoint) per session", () => {
  const memo = new LaneTransitionMemo();
  const key = { route: "replay", event: "refuse", reason: "details-invalid" } as const;
  assert.equal(memo.seen("s1", { ...key, checkpointEntryId: "A" }), false);
  assert.equal(memo.seen("s1", { ...key, checkpointEntryId: "A" }), true);
  assert.equal(memo.seen("s1", { ...key, checkpointEntryId: "B" }), false, "another checkpoint");
  assert.equal(memo.seen("s1", key), false, "no checkpoint differs from a checkpoint");
  assert.equal(memo.seen("s1", { ...key, event: "fallback", checkpointEntryId: "A" }), false);
  assert.equal(memo.seen("s2", { ...key, checkpointEntryId: "A" }), false, "another session");
  memo.reset("s1");
  assert.equal(memo.seen("s1", { ...key, checkpointEntryId: "A" }), false, "reset forgets");
  assert.equal(memo.seen("s2", { ...key, checkpointEntryId: "A" }), true, "other sessions kept");
});

test("a lane record entry is not model-visible", () => {
  const manager = SessionManager.inMemory("/tmp");
  manager.appendMessage({ role: "user", content: "hello", timestamp: 0 });
  const before = manager.buildSessionContext().messages;
  appendLaneRecord(
    (type, data) => {
      manager.appendCustomEntry(type, data);
    },
    input(),
    () => assert.fail("valid record"),
  );
  assert.deepEqual(laneRecordsOf(manager.getBranch()), [record()]);
  assert.deepEqual(manager.buildSessionContext().messages, before);
});
