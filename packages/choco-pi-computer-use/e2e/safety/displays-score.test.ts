import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCursorState,
  parseScreens,
  scoreCursorState,
  scoreOverlayBounds,
  screenContaining,
  type OwnerWindow,
  type Screen,
} from "./displays-score.ts";

const screens: Screen[] = parseScreens([
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
    main: false,
    bounds: { x: -485, y: -1692, width: 3008, height: 1692 },
    topLeftFrame: { x: -485, y: -1692, width: 3008, height: 1692 },
    backingScale: 2,
  },
  {
    id: 4,
    name: "Sidecar",
    primary: false,
    main: true,
    bounds: { x: -1579, y: 620, width: 1579, height: 1088 },
    topLeftFrame: { x: -1579, y: 620, width: 1579, height: 1088 },
    backingScale: 2,
  },
]);
const [builtIn, dell, sidecar] = screens;

test("screenContaining uses half-open bounds, then the outer edge", () => {
  assert.equal(screenContaining({ x: 800, y: 400 }, screens)?.id, 1);
  assert.equal(screenContaining({ x: 100, y: -1000 }, screens)?.id, 3);
  assert.equal(screenContaining({ x: -800, y: 900 }, screens)?.id, 4);
  assert.equal(screenContaining({ x: 0, y: 700 }, screens)?.id, 1);
  assert.equal(screenContaining({ x: 2056, y: 500 }, screens)?.id, 1);
  assert.equal(screenContaining({ x: 5000, y: 5000 }, screens), undefined);
});

const overlay = (bounds: Screen["bounds"], onscreen = true): OwnerWindow => ({
  number: 7,
  bounds,
  layer: 0,
  onscreen,
  alpha: 1,
});

test("overlay bounds pass only on the expected display", () => {
  assert.equal(scoreOverlayBounds([overlay(builtIn.bounds)], builtIn, screens).ok, true);
  const defect = scoreOverlayBounds([overlay(sidecar.bounds)], builtIn, screens);
  assert.equal(defect.ok, false);
  assert.equal(scoreOverlayBounds([], builtIn, screens).ok, false);
  assert.equal(
    scoreOverlayBounds([overlay(builtIn.bounds), overlay(dell.bounds)], builtIn, screens).ok,
    false,
  );
  assert.equal(
    scoreOverlayBounds([overlay(builtIn.bounds), overlay(dell.bounds, false)], builtIn, screens).ok,
    true,
  );
});

test("cursor state checks the display, the local target, and the pointer pixels", () => {
  const acted = { x: 100, y: -1000 };
  const good = parseCursorState({
    overlay: {
      displayId: 3,
      windowNumber: 9,
      windowServerBounds: { x: -485, y: -1692, w: 3008, h: 1692 },
    },
    pointer: { target: acted, local: { x: 585, y: 692 }, animating: false },
    capture: { bounds: { x: 586, y: 693, w: 22, h: 22 }, opaquePixels: 900 },
  });
  const checks = scoreCursorState(good, dell, acted);
  assert.deepEqual(
    checks.map((check) => [check.name, check.ok]),
    [
      ["overlay_display", true],
      ["overlay_self_bounds", true],
      ["drawn_target", true],
      ["drawn_pixels", true],
    ],
  );
  const global = parseCursorState({
    overlay: { displayId: 3, windowServerBounds: { x: -485, y: -1692, w: 3008, h: 1692 } },
    pointer: { target: acted, local: { x: 100, y: -1000 }, animating: false },
    capture: { bounds: null, opaquePixels: 0 },
  });
  const failed = scoreCursorState(global, dell, acted);
  assert.equal(failed.find((check) => check.name === "drawn_target")?.ok, false);
  assert.equal(failed.find((check) => check.name === "drawn_pixels")?.ok, false);
  const wide = parseCursorState({
    overlay: { displayId: 3 },
    pointer: { target: acted, local: { x: 585, y: 692 } },
    capture: { bounds: { x: 0, y: 0, w: 3008, h: 1692 }, opaquePixels: 5_000_000 },
  });
  assert.equal(
    scoreCursorState(wide, dell, acted).find((check) => check.name === "drawn_pixels")?.ok,
    false,
  );
  assert.equal(scoreCursorState(undefined, dell, acted)[0].ok, null);
});

test("per-cursor windows: a small window on the expected display containing the point", () => {
  const acted = { x: 100, y: -1000 };
  const small = (x: number, y: number, onscreen = true): OwnerWindow => ({
    number: 8,
    bounds: { x, y, w: 96, h: 96 },
    layer: 0,
    onscreen,
    alpha: 1,
  });
  assert.equal(scoreOverlayBounds([small(52, -1048)], dell, screens, acted).ok, true);
  assert.equal(
    scoreOverlayBounds([small(52, -1048), small(400, 300)], dell, screens, acted).ok,
    true,
  );
  assert.equal(scoreOverlayBounds([small(400, 300)], dell, screens, acted).ok, false);
  assert.equal(
    scoreOverlayBounds([small(52, -1048), small(1990, -40)], dell, screens, acted).ok,
    false,
  );
  assert.equal(scoreOverlayBounds([small(52, -1048, false)], dell, screens, acted).ok, false);
});

test("drawn_tip compares the hot spot located in pixels with the acted point", () => {
  const acted = { x: 100, y: -1000 };
  const state = (tip: { x: number; y: number }) =>
    parseCursorState({
      overlay: { displayId: 3, windowServerBounds: { x: 52, y: -1048, w: 96, h: 96 } },
      pointer: { target: acted, local: { x: 585, y: 692 }, animating: false },
      capture: { bounds: { x: 585, y: 692, w: 20, h: 20 }, opaquePixels: 900, tip },
    });
  const near = scoreCursorState(state({ x: 100.3, y: -999.8 }), dell, acted);
  assert.equal(near.find((check) => check.name === "overlay_self_bounds")?.ok, true);
  assert.equal(near.find((check) => check.name === "drawn_tip")?.ok, true);
  const short = scoreCursorState(state({ x: 101.95, y: -998.05 }), dell, acted);
  assert.equal(short.find((check) => check.name === "drawn_tip")?.ok, false);
});
