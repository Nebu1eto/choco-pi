/**
 * The pi-schema validators that replaced the TypeBox schemas: openness, finite
 * numbers, round-tripping of records the previous code wrote, the diagnostics
 * the settings loader and lane journal print, and the live-object guards.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isWireBody } from "../src/anthropic/capture.ts";
import {
  isBackgroundCompactionSettings,
  isBackgroundCompactionSidecar,
  isBackgroundUsage,
  isCandidateRecord,
  isCheckpointDetails,
  isJsonRecord,
  isJsonValue,
  isProviderScope,
  isSnapshotIdentity,
} from "../src/background/contract.ts";
import {
  appendLaneRecord,
  isLaneRecord,
  type LaneRecordInput,
} from "../src/background/lane-journal.ts";
import { parseBackgroundSettings } from "../src/background/settings.ts";
import { hasMethods, isOptional, isBoolean, isRecord, readProperty } from "../src/guards.ts";
import { isXaiWireBody } from "../src/xai/capture.ts";

/**
 * Written by the TypeBox-based code at the parent revision (each value was
 * accepted by that revision's validators before it was frozen here).
 */
const OLD_CANDIDATE_RECORD = `{"customType":"choco-compaction-candidate","schemaVersion":1,"candidateId":"c1","backendId":"b","identity":{"cutEntryId":"c","prefixFingerprint":"f","priorCheckpointId":null,"priorCheckpointVersion":null,"ownerKey":"o","ownerGeneration":0,"providerScope":{"provider":"p","model":"m","baseUrl":"u","authMode":"oauth","accountScope":"a"}},"createdAt":5,"customInstructions":"x","admission":{"promptTokens":1,"budget":2,"source":"chars","ratio":0.25,"detail":"d"},"checkpoint":{"candidateId":"c1","backendId":"b","schemaVersion":1,"draft":{"type":"compaction","summary":"s","firstKeptEntryId":"e","details":{"strategy":"openai-responses-compaction-v2","extra":{"a":[1,"x",null,{"b":true}]},"n":3},"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}},"details":{"strategy":"openai-responses-compaction-v2","extra":{"a":[1,"x",null,{"b":true}]},"n":3},"usage":{"input":1,"output":2,"iterations":[{"input":1,"output":1}]},"reasonCodes":["quota","prepared"]}}`;
const OLD_LANE_RECORD = `{"customType":"choco-compaction-lane","schemaVersion":1,"at":1,"sessionId":"s","provider":"anthropic","route":"manual","event":"fallback","from":"anthropic-native","to":"text","reason":"no-legal-cut","detail":"d","candidateId":"c","checkpointEntryId":"e","cooldownUntil":3,"trigger":"idle","noticeAttempted":false}`;
const OLD_SIDECAR = `{"enabled":true,"prepareAt":0.5,"hysteresis":0.2,"maxConcurrent":3}`;

test("records written by the previous code still validate unchanged", () => {
  assert.ok(isCandidateRecord(JSON.parse(OLD_CANDIDATE_RECORD)));
  assert.ok(isLaneRecord(JSON.parse(OLD_LANE_RECORD)));
  assert.ok(isBackgroundCompactionSidecar(JSON.parse(OLD_SIDECAR)));
  const loaded = parseBackgroundSettings(OLD_SIDECAR, "/tmp/old.json");
  assert.equal(loaded.diagnostic, undefined);
  assert.equal(loaded.settings.maxConcurrent, 3);
  assert.equal(loaded.settings.maxQueued, 32, "keys absent from the sidecar keep their defaults");
});

test("candidate records keep their cross-field rules", () => {
  const record = JSON.parse(OLD_CANDIDATE_RECORD);
  assert.ok(isCandidateRecord(record));
  const wrongBackend = structuredClone(record);
  wrongBackend.checkpoint.backendId = "other";
  assert.ok(!isCandidateRecord(wrongBackend));
  const driftedDetails = structuredClone(record);
  driftedDetails.checkpoint.draft.details.n = 4;
  assert.ok(!isCandidateRecord(driftedDetails), "draft and checkpoint details must agree");
  const half = structuredClone(record);
  half.identity.priorCheckpointId = "p";
  assert.ok(!isCandidateRecord(half), "prior id and version are both set or both null");
  const extra = structuredClone(record);
  extra.surprise = 1;
  assert.ok(!isCandidateRecord(extra), "the record is closed");
});

test("closed schemas reject unknown keys; open JSON-rest schemas accept JSON-valued ones only", () => {
  const scope = { provider: "p", model: "m" };
  assert.ok(isProviderScope(scope));
  assert.ok(!isProviderScope({ ...scope, extra: 1 }));
  assert.ok(!isProviderScope({ ...scope, model: "" }));
  assert.ok(!isSnapshotIdentity({ ...scope }));

  const details = {
    strategy: "xai-responses-compaction-v1",
    nested: { list: [1, "a", null, false] },
  };
  assert.ok(isCheckpointDetails(details));
  assert.ok(!isCheckpointDetails({ ...details, strategy: "other" }));
  assert.ok(!isCheckpointDetails({ nested: 1 }), "strategy is required");
  assert.ok(!isCheckpointDetails({ ...details, bad: undefined }), "undefined is not JSON");
  assert.ok(!isCheckpointDetails({ ...details, bad: () => 1 }), "a function is not JSON");
  assert.ok(!isCheckpointDetails({ ...details, bad: Number.NaN }), "NaN is not JSON");
  assert.ok(!isCheckpointDetails({ ...details, nested: { deep: [Number.POSITIVE_INFINITY] } }));
});

test("in-process numbers stay finite and bounded as TypeBox required", () => {
  assert.ok(isBackgroundUsage({ input: 0, output: 1.5 }));
  assert.ok(!isBackgroundUsage({ input: -1, output: 0 }));
  assert.ok(!isBackgroundUsage({ input: Number.NaN, output: 0 }));
  assert.ok(!isBackgroundUsage({ input: 0, output: Number.POSITIVE_INFINITY }));
  assert.ok(!isBackgroundUsage({ input: 0, output: 0, extra: 1 }));
  assert.ok(isBackgroundUsage({ input: 0, output: 0, iterations: [{ input: 1, output: 2 }] }));
  assert.ok(!isBackgroundUsage({ input: 0, output: 0, iterations: [{ input: 1 }] }));
  assert.ok(isJsonValue([1, { a: null }]));
  assert.ok(!isJsonValue(Number.NaN));
  assert.ok(!isJsonValue(undefined));
  assert.ok(!isJsonValue([undefined]));
  assert.ok(isJsonRecord({}) && !isJsonRecord([]) && !isJsonRecord(null));
});

test("settings: integer, exclusive-bound and optional rules are unchanged", () => {
  const full = JSON.parse(
    `{"enabled":true,"text":true,"codexNative":false,"anthropicNative":false,"maxConcurrent":2,"maxQueued":32,"maxAttempts":2,"retryBaseMs":1000,"cooldownMs":60000,"prepareAt":0.7,"hysteresis":0.1,"minReductionTokens":1024,"reserveTokens":8192,"maxInputTokens":1000000,"maxOutputTokens":8192,"maxResultBytes":1048576,"timeoutMs":120000,"countTokens":true}`,
  );
  assert.ok(isBackgroundCompactionSettings(full));
  assert.ok(!isBackgroundCompactionSettings({ ...full, maxQueued: 0 }));
  assert.ok(!isBackgroundCompactionSettings({ ...full, maxQueued: 1.5 }));
  assert.ok(!isBackgroundCompactionSettings({ ...full, prepareAt: 0 }), "exclusive minimum");
  assert.ok(isBackgroundCompactionSettings({ ...full, prepareAt: 1 }));
  assert.ok(!isBackgroundCompactionSettings({ ...full, hysteresis: 1 }), "exclusive maximum");
  assert.ok(!isBackgroundCompactionSettings({ ...full, extra: true }));
  const { enabled: _enabled, ...partial } = full;
  assert.ok(!isBackgroundCompactionSettings(partial), "settings need every key");
  assert.ok(isBackgroundCompactionSidecar(partial), "the sidecar may omit any key");
  assert.ok(isBackgroundCompactionSidecar({}));
  assert.ok(!isBackgroundCompactionSidecar({ turbo: true }));
});

test("settings diagnostics name the first violation by JSON pointer", () => {
  const unknownKey = parseBackgroundSettings(
    JSON.stringify({ enabled: true, turbo: true }),
    "/s.json",
  );
  assert.equal(
    unknownKey.diagnostic,
    "/s.json failed validation at /turbo: unknown field; background compaction is disabled",
  );
  assert.equal(unknownKey.settings.enabled, false);
  const wrongType = parseBackgroundSettings(JSON.stringify({ enabled: "yes" }), "/s.json");
  assert.match(
    wrongType.diagnostic ?? "",
    /^\/s\.json failed validation at \/enabled: .+; background compaction is disabled$/u,
  );
  const wrongRoot = parseBackgroundSettings("[]", "/s.json");
  assert.match(wrongRoot.diagnostic ?? "", /^\/s\.json failed validation: .+; background/u);
  assert.ok(!(wrongRoot.diagnostic ?? "").includes(" at "), "a root violation names no path");
});

test("a dropped lane record reports the first failing JSON pointer", () => {
  const reports: string[] = [];
  const input: LaneRecordInput = {
    at: 1,
    sessionId: "s",
    provider: "anthropic",
    route: "manual",
    event: "fallback",
    from: "anthropic-native",
    // A code outside the owned vocabulary: assembled so the type accepts it for this test only.
    reason: JSON.parse(`"not-an-owned-code"`),
    noticeAttempted: false,
  };
  assert.equal(
    appendLaneRecord(
      () => assert.fail("an invalid record must not be appended"),
      input,
      (message) => reports.push(message),
    ),
    false,
  );
  assert.deepEqual(reports, ["lane journal: dropped invalid record: /reason"]);
});

test("lane records are closed and bound detail length", () => {
  const record = JSON.parse(OLD_LANE_RECORD);
  assert.ok(!isLaneRecord({ ...record, extra: 1 }));
  assert.ok(isLaneRecord({ ...record, detail: "x".repeat(128) }));
  assert.ok(!isLaneRecord({ ...record, detail: "x".repeat(129) }));
  assert.ok(!isLaneRecord({ ...record, at: Number.NaN }));
  assert.ok(!isLaneRecord({ ...record, at: -1 }));
  const { to: _to, trigger: _trigger, ...minimal } = record;
  assert.ok(isLaneRecord(minimal), "to and trigger are optional");
  assert.ok(isLaneRecord({ ...record, to: undefined }), "an undefined optional key is absent");
});

test("wire bodies keep provider fields as JSON and require the named ones", () => {
  const body = {
    model: "m",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "x" } }] },
    ],
    max_tokens: 5,
    tools: [{ name: "t", input_schema: { type: "object" } }],
  };
  assert.ok(isWireBody(body));
  assert.ok(!isWireBody({ ...body, model: "" }));
  assert.ok(!isWireBody({ ...body, messages: [{ role: "user", content: [{ text: "no type" }] }] }));
  assert.ok(!isWireBody({ ...body, extra: Number.NaN }));
  assert.ok(!isWireBody({ ...body, extra: undefined }));
  assert.ok(isXaiWireBody({ model: "m", input: [{ role: "user", content: "hi" }], store: false }));
  assert.ok(!isXaiWireBody({ model: "m", input: [{ role: "user", content: "hi" }], x: () => 1 }));
  assert.ok(!isXaiWireBody({ model: "m", input: "hi" }));
});

test("live-object guards read inherited members and accessors, which pi-schema cannot see", () => {
  class Manager {
    isChildSessionId(): boolean {
      return false;
    }
    get session() {
      return { sessionId: "s" };
    }
  }
  const manager = new Manager();
  assert.ok(hasMethods(manager, ["isChildSessionId"]));
  assert.ok(!hasMethods(manager, ["isChildSessionId", "missing"]));
  assert.ok(!hasMethods(null, ["x"]) && !hasMethods("str", ["x"]) && !hasMethods([], ["length"]));
  assert.deepEqual(readProperty(manager, "session"), { sessionId: "s" });
  assert.equal(readProperty(Object.create(null), "x"), undefined);
  assert.equal(readProperty(null, "x"), undefined);
  assert.ok(isRecord(manager) && isRecord(Object.create(null)) && isRecord(new Map()));
  assert.ok(!isRecord([]) && !isRecord(null) && !isRecord(() => 1) && !isRecord("s"));
  assert.ok(isOptional(undefined, isBoolean) && isOptional(true, isBoolean));
  assert.ok(!isOptional("true", isBoolean) && !isOptional(null, isBoolean));
});
