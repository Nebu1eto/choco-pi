import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../../src/json.ts";
import {
  allowedRefusals,
  clientText,
  scoreClient,
  type ClientResult,
  type ClientSpec,
  type StepRecord,
} from "./parallel.ts";

function spec(workload: ClientSpec["workload"]): ClientSpec {
  const { text, chars } = clientText(1);
  return { id: "c1", index: 1, pid: 101, window: "main", text, chars, workload, result: "unused" };
}

function step(
  n: number,
  label: StepRecord["label"],
  start: number,
  end: number,
  details: JsonObject,
): StepRecord {
  return {
    n,
    label,
    auto: false,
    start,
    end,
    attempts: 1,
    ownershipRefusals: 0,
    busyRetries: 0,
    details,
  };
}

const worked: JsonObject = { execution: { outcome: "worked" } };
const unknown: JsonObject = { execution: { outcome: "unknown" } };
const ok: JsonObject = {};

function quitting(value: string, increments = 0, customHits = 0): JsonObject {
  return { event: "quitting", ts: 99_000, value, increments, customHits };
}

test("an effect is attributed to exactly one step: the next step's effect is never credited to the previous one", () => {
  const client = spec(["find", "observe", "type", "key"]);
  const typed = client.text;
  const result: ClientResult = {
    id: "c1",
    pid: 101,
    started: 1_000,
    ended: 5_000,
    steps: [
      step(1, "find", 1_000, 1_100, ok),
      step(2, "observe", 1_200, 1_300, ok),
      step(3, "type", 1_400, 1_600, worked),
      step(4, "key", 1_700, 1_900, unknown),
    ],
  };
  const rows: JsonObject[] = [
    { event: "launched", ts: 0 },
    { event: "fieldValue", ts: 1_500, value: typed },
    { event: "fieldValue", ts: 1_750, value: typed.slice(0, -1) },
    quitting(typed.slice(0, -1)),
  ];
  const score = scoreClient(client, result, rows, 0);
  assert.deepEqual(
    score.steps.map((item) => [item.label, item.cls]),
    [
      ["find", "intended"],
      ["observe", "intended"],
      ["type", "intended"],
      ["key", "intended"],
    ],
  );
  assert.equal(score.exact, true);
});

test("a client refused on every acting step is not exact", () => {
  const client = spec(["find", "observe", "press", "type"]);
  const busy: JsonObject = { status: "target_busy" };
  const result: ClientResult = {
    id: "c1",
    pid: 101,
    started: 1_000,
    ended: 5_000,
    steps: [
      step(1, "find", 1_000, 1_100, ok),
      step(2, "observe", 1_200, 1_300, ok),
      step(3, "press", 1_400, 1_600, busy),
      step(4, "type", 1_700, 1_900, busy),
    ],
  };
  const rows: JsonObject[] = [{ event: "launched", ts: 0 }, quitting("")];
  const score = scoreClient(client, result, rows, 0, allowedRefusals("standard"));
  assert.equal(score.totals.honest_refusal, 2);
  assert.equal(score.exact, false, "nothing it was asked to do happened");
  assert.deepEqual(score.notDone, [
    "3:press:honest_refusal:target_busy",
    "4:type:honest_refusal:target_busy",
  ]);
});

test("standard delivery allows only the designed refusal of coordinate clicks on the custom view", () => {
  const client = spec(["find", "observe", "click_custom", "press"]);
  const refused: JsonObject = { status: "foreground_required" };
  const result: ClientResult = {
    id: "c1",
    pid: 101,
    started: 1_000,
    ended: 5_000,
    steps: [
      step(1, "find", 1_000, 1_100, ok),
      step(2, "observe", 1_200, 1_300, ok),
      step(3, "click_custom", 1_400, 1_600, refused),
      step(4, "press", 1_700, 1_900, worked),
    ],
  };
  const rows: JsonObject[] = [
    { event: "launched", ts: 0 },
    { event: "increment", ts: 1_800, count: 1 },
    quitting("", 1, 0),
  ];
  assert.equal(scoreClient(client, result, rows, 0, allowedRefusals("standard")).exact, true);
  assert.equal(
    scoreClient(client, result, rows, 0, allowedRefusals("extended")).exact,
    false,
    "in extended delivery the click is expected to work",
  );
});

test("a client that did not run its whole workload is not exact", () => {
  const client = spec(["find", "observe", "press", "press"]);
  const result: ClientResult = {
    id: "c1",
    pid: 101,
    started: 1_000,
    ended: 5_000,
    steps: [
      step(1, "find", 1_000, 1_100, ok),
      step(2, "observe", 1_200, 1_300, ok),
      step(3, "press", 1_400, 1_600, worked),
    ],
    fatal: undefined,
  };
  const rows: JsonObject[] = [
    { event: "launched", ts: 0 },
    { event: "increment", ts: 1_500 },
    quitting("", 1, 0),
  ];
  assert.equal(scoreClient(client, result, rows, 0).exact, false);
});
