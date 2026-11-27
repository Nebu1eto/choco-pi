import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../../src/json.ts";
import {
  countEvents,
  customHitsSince,
  frontmostRows,
  lastActivation,
  offSpaceCheck,
  parseSpaces,
  spacesUnchangedCheck,
  typedOnceCheck,
} from "./offspace-score.ts";

const displays = [
  { display: "A", current: 5, desktopSpaces: [5, 6] },
  { display: "B", current: 147, desktopSpaces: [147] },
];

function spacesRow(windowSpaces: number[], current = [5, 147]): JsonObject {
  return {
    event: "spaces",
    windows: [{ window: "main", windowNumber: 42, spaces: windowSpaces }],
    displays: displays.map((display, index) => ({ ...display, current: current[index] ?? -1 })),
    frontPid: 7,
  };
}

test("a window only on a desktop Space no display shows is off-Space", () => {
  assert.equal(offSpaceCheck("x", parseSpaces(spacesRow([6]))).ok, true);
});

test("a window on a shown Space, on no Space, or on an unknown (full-screen) Space is not off-Space", () => {
  assert.equal(offSpaceCheck("x", parseSpaces(spacesRow([5]))).ok, false);
  assert.equal(offSpaceCheck("x", parseSpaces(spacesRow([]))).ok, false);
  assert.equal(offSpaceCheck("x", parseSpaces(spacesRow([6, 147]))).ok, false);
  assert.equal(offSpaceCheck("x", parseSpaces(spacesRow([999]))).ok, false);
  assert.equal(offSpaceCheck("x", undefined).ok, false);
});

test("a display that switched Spaces fails the unchanged check", () => {
  const baseline = parseSpaces(spacesRow([6]))!;
  assert.equal(spacesUnchangedCheck("x", baseline, parseSpaces(spacesRow([6]))).ok, true);
  assert.equal(
    spacesUnchangedCheck("x", baseline, parseSpaces(spacesRow([6], [6, 147]))).ok,
    false,
  );
  assert.equal(spacesUnchangedCheck("x", baseline, undefined).ok, false);
});

test("activation and effect rows are counted from the fixture log", () => {
  const rows: JsonObject[] = [
    { event: "appActive", ts: 1 },
    { event: "appInactive", ts: 2 },
    { event: "customHit", ts: 3, count: 1 },
    { event: "fieldValue", ts: 4, value: "135" },
    { event: "fieldValue", ts: 5, value: "13579" },
  ];
  assert.equal(lastActivation(rows), "appInactive");
  assert.equal(lastActivation([...rows, { event: "appActive", ts: 6 }]), "appActive");
  assert.equal(lastActivation([]), "none");
  assert.equal(countEvents(rows, "appActive"), 1);
  assert.equal(customHitsSince(rows, 3), 1);
  assert.equal(customHitsSince(rows, 4), 0);
  assert.equal(typedOnceCheck("x", rows, "13579").ok, true);
  assert.equal(typedOnceCheck("x", rows, "135").ok, false);
  const doubled = [...rows, { event: "fieldValue", ts: 6, value: "1357913579" }];
  assert.equal(typedOnceCheck("x", doubled, "13579").ok, false);
  assert.equal(frontmostRows([...rows, { event: "frontmost", frontPid: 9 }]).length, 1);
});
