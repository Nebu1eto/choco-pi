import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCursorReport,
  scorePointer,
  scoreSamples,
  scoreSettled,
  type Acted,
} from "./cursors-score.ts";
import type { JsonObject } from "../../src/json.ts";
import { parseScreens, type Point } from "./displays-score.ts";

const json = (point: Point): JsonObject => ({ x: point.x, y: point.y });

const screens = parseScreens([
  {
    id: 1,
    name: "Built-in",
    primary: true,
    main: false,
    bounds: { x: 0, y: 0, width: 2056, height: 1329 },
    topLeftFrame: { x: 0, y: 0, width: 2056, height: 1329 },
    backingScale: 2,
  },
  {
    id: 3,
    name: "DELL",
    primary: false,
    main: true,
    bounds: { x: -485, y: -1692, width: 3008, height: 1692 },
    topLeftFrame: { x: -485, y: -1692, width: 3008, height: 1692 },
    backingScale: 2,
  },
]);

const cursor = (
  session: string,
  windowId: number,
  tip: Point,
  extra: JsonObject = {},
): JsonObject => ({
  session,
  windowId,
  windowNumber: windowId + 1000,
  displayId: tip.y < 0 ? 3 : 1,
  displayBounds:
    tip.y < 0 ? { x: -485, y: -1692, w: 3008, h: 1692 } : { x: 0, y: 0, w: 2056, h: 1329 },
  target: json(tip),
  points: [json(tip)],
  tip: json(tip),
  animating: false,
  visible: true,
  windowServerBounds: { x: Math.floor(tip.x) - 48, y: Math.floor(tip.y) - 48, w: 96, h: 96 },
  windowServerOnscreen: true,
  windowBelow: windowId,
  capture: { tip: { x: tip.x + 0.2, y: tip.y - 0.1 }, bounds: { x: 10, y: 10, w: 20, h: 20 } },
  ...extra,
});

const acted: Acted[] = [
  {
    session: "a",
    label: "t0",
    windowId: 11,
    point: { x: 400.5, y: 300.25 },
    received: { x: 400.5, y: 300.25 },
    draws: true,
  },
  {
    session: "b",
    label: "t1",
    windowId: 12,
    point: { x: 100, y: -1000 },
    received: { x: 100, y: -1000 },
    draws: true,
  },
];

test("settled cursors: one per session, each on its own point and display, above its window", () => {
  const report = parseCursorReport({
    supported: true,
    now: 5,
    cursors: [cursor("a", 11, acted[0].point), cursor("b", 12, acted[1].point)],
    history: [],
  });
  const checks = scoreSettled("click", acted, report, screens);
  assert.deepEqual(
    checks.filter((check) => check.ok !== true).map((check) => check.name),
    [],
  );
});

test("a cursor short of its point, on the wrong display, or missing fails", () => {
  const short = parseCursorReport({
    supported: true,
    cursors: [
      cursor("a", 11, { x: 402.5, y: 302.2 }, { target: json(acted[0].point) }),
      cursor("b", 12, acted[1].point, { displayId: 1 }),
    ],
    history: [],
  });
  const failed = scoreSettled("click", acted, short, screens)
    .filter((check) => check.ok === false)
    .map((check) => check.name);
  assert.ok(failed.includes("click_t0_tip"));
  assert.ok(failed.includes("click_t0_pixel_tip"));
  assert.ok(failed.includes("click_t1_display"));
  const one = parseCursorReport({
    supported: true,
    cursors: [cursor("a", 11, acted[0].point)],
    history: [],
  });
  assert.equal(
    scoreSettled("click", acted, one, screens).find(
      (check) => check.name === "click_cursors_concurrent",
    )?.ok,
    false,
  );
});

test("legacy single overlay: one cursor for every session fails the concurrency check", () => {
  const legacy = parseCursorReport({
    supported: true,
    overlay: {
      windowNumber: 7,
      displayId: 1,
      displayBounds: { x: 0, y: 0, w: 2056, h: 1329 },
      visible: true,
      windowServerOnscreen: true,
    },
    pointer: {
      target: json(acted[0].point),
      position: { x: 400.5 + 11.31, y: 300.25 + 11.31 },
      animating: false,
    },
  });
  assert.equal(legacy?.legacy, true);
  const checks = scoreSettled("click", acted, legacy, screens);
  assert.equal(checks.find((check) => check.name === "click_cursors_concurrent")?.ok, false);
  const tip = checks.find((check) => check.name === "click_t0_tip");
  assert.equal(tip?.ok, false);
});

test("samples: simultaneous count and never at another session's point", () => {
  const both = parseCursorReport({
    supported: true,
    cursors: [cursor("a", 11, acted[0].point), cursor("b", 12, acted[1].point)],
    history: [],
  });
  const swapped = parseCursorReport({
    supported: true,
    cursors: [cursor("a", 11, acted[1].point)],
    history: [],
  });
  if (!both || !swapped) throw new Error("parse");
  const ok = scoreSamples("click", acted, [both]);
  assert.deepEqual(
    ok.map((check) => check.ok),
    [true, true],
  );
  const bad = scoreSamples("click", acted, [swapped]);
  assert.deepEqual(
    bad.map((check) => check.ok),
    [false, false],
  );
});

test("real pointer: a sample at an acted point fails, others are the user's", () => {
  const points = [{ x: 400, y: 300 }];
  assert.equal(scorePointer([{ x: 10, y: 10, ts: 5 }], points, { from: 0, to: 10 }).ok, true);
  assert.equal(scorePointer([{ x: 400.5, y: 300, ts: 5 }], points, { from: 0, to: 10 }).ok, false);
  assert.equal(scorePointer([{ x: 400.5, y: 300, ts: 50 }], points, { from: 0, to: 10 }).ok, true);
});
