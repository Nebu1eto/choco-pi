import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Screen {
  id: number;
  name: string;
  primary: boolean;
  main: boolean;
  bounds: Rect;
  topLeftFrame: Rect;
  backingScale: number;
}

export interface Check {
  name: string;
  ok: boolean | null;
  detail: JsonObject;
}

export function rectOf(value: JsonValue | undefined): Rect | undefined {
  if (!isJsonObject(value)) return undefined;
  const { x, y } = value;
  const w = value.w ?? value.width;
  const h = value.h ?? value.height;
  return isNumber(x) && isNumber(y) && isNumber(w) && isNumber(h) ? { x, y, w, h } : undefined;
}

export function pointOf(value: JsonValue | undefined): Point | undefined {
  if (!isJsonObject(value)) return undefined;
  const { x, y } = value;
  return isNumber(x) && isNumber(y) ? { x, y } : undefined;
}

export function parseScreens(value: JsonValue | undefined): Screen[] {
  if (!Array.isArray(value)) return [];
  const screens: Screen[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry) || !isNumber(entry.id)) continue;
    const bounds = rectOf(entry.bounds);
    const topLeftFrame = rectOf(entry.topLeftFrame);
    if (!bounds || !topLeftFrame) continue;
    screens.push({
      id: entry.id,
      name: isString(entry.name) ? entry.name : "",
      primary: entry.primary === true,
      main: entry.main === true,
      bounds,
      topLeftFrame,
      backingScale: isNumber(entry.backingScale) ? entry.backingScale : 0,
    });
  }
  return screens;
}

export function rectJson(rect: Rect): JsonObject {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

export function centre(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

export function inside(inner: Rect, outer: Rect, tolerance = 0.5): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.w <= outer.x + outer.w + tolerance &&
    inner.y + inner.h <= outer.y + outer.h + tolerance
  );
}

export function sameRect(a: Rect, b: Rect, tolerance = 1): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.w - b.w) <= tolerance &&
    Math.abs(a.h - b.h) <= tolerance
  );
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function screenContaining(point: Point, screens: Screen[]): Screen | undefined {
  const { x, y } = point;
  const halfOpen = screens.find(
    ({ bounds: b }) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h,
  );
  return (
    halfOpen ??
    screens.find(({ bounds: b }) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)
  );
}

export interface OwnerWindow {
  number: number;
  bounds: Rect;
  layer: number;
  onscreen: boolean;
  alpha: number;
}

export function parseOwnerWindows(value: JsonValue | undefined): OwnerWindow[] {
  if (!Array.isArray(value)) return [];
  const windows: OwnerWindow[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) continue;
    const bounds = rectOf(entry.bounds);
    if (!bounds || !isNumber(entry.number)) continue;
    windows.push({
      number: entry.number,
      bounds,
      layer: isNumber(entry.layer) ? entry.layer : 0,
      onscreen: entry.onscreen === true,
      alpha: isNumber(entry.alpha) ? entry.alpha : 1,
    });
  }
  return windows;
}

export function scoreOverlayBounds(
  windows: OwnerWindow[],
  expected: Screen,
  screens: Screen[],
): Check {
  const onscreen = windows.filter((window) => window.onscreen);
  const onExpected = onscreen.filter((window) => sameRect(window.bounds, expected.bounds));
  const elsewhere = onscreen.filter((window) =>
    screens.some((screen) => screen.id !== expected.id && sameRect(window.bounds, screen.bounds)),
  );
  const displayOf = (window: OwnerWindow): number | null =>
    screens.find((screen) => sameRect(window.bounds, screen.bounds))?.id ?? null;
  return {
    name: "overlay_window_bounds",
    ok: onExpected.length > 0 && elsewhere.length === 0,
    detail: {
      expectedDisplay: expected.id,
      expectedBounds: rectJson(expected.bounds),
      onscreen: onscreen.map((window) => ({
        number: window.number,
        bounds: rectJson(window.bounds),
        display: displayOf(window),
        layer: window.layer,
      })),
    },
  };
}

export interface CursorState {
  displayId?: number;
  windowNumber?: number;
  windowServerBounds?: Rect;
  target?: Point;
  local?: Point;
  animating?: boolean;
  capture?: { bounds?: Rect; opaquePixels: number; error?: string };
}

export function parseCursorState(result: JsonValue | undefined): CursorState | undefined {
  if (!isJsonObject(result)) return undefined;
  const overlay = isJsonObject(result.overlay) ? result.overlay : undefined;
  const pointer = isJsonObject(result.pointer) ? result.pointer : undefined;
  const capture = isJsonObject(result.capture) ? result.capture : undefined;
  return {
    displayId: overlay && isNumber(overlay.displayId) ? overlay.displayId : undefined,
    windowNumber: overlay && isNumber(overlay.windowNumber) ? overlay.windowNumber : undefined,
    windowServerBounds: overlay ? rectOf(overlay.windowServerBounds) : undefined,
    target: pointer ? pointOf(pointer.target) : undefined,
    local: pointer ? pointOf(pointer.local) : undefined,
    animating: pointer?.animating === true,
    capture: capture
      ? {
          bounds: rectOf(capture.bounds),
          opaquePixels: isNumber(capture.opaquePixels) ? capture.opaquePixels : 0,
          error: isString(capture.error) ? capture.error : undefined,
        }
      : undefined,
  };
}

export const POINTER_MAX_EXTENT = 40;
export const POINTER_SLACK = 4;

export function scoreCursorState(
  state: CursorState | undefined,
  expected: Screen,
  acted: Point,
): Check[] {
  if (!state)
    return [
      { name: "overlay_display", ok: null, detail: { reason: "agentCursorState unsupported" } },
    ];
  const local = { x: acted.x - expected.bounds.x, y: acted.y - expected.bounds.y };
  const checks: Check[] = [
    {
      name: "overlay_display",
      ok: state.displayId === expected.id,
      detail: { reported: state.displayId ?? null, expected: expected.id },
    },
    {
      name: "overlay_self_bounds",
      ok: state.windowServerBounds ? sameRect(state.windowServerBounds, expected.bounds) : false,
      detail: {
        reported: state.windowServerBounds ? rectJson(state.windowServerBounds) : null,
        expected: rectJson(expected.bounds),
      },
    },
    {
      name: "drawn_target",
      ok:
        state.target !== undefined &&
        state.local !== undefined &&
        distance(state.target, acted) <= 0.5 &&
        distance(state.local, local) <= 0.5,
      detail: {
        target: state.target ? { ...state.target } : null,
        local: state.local ? { ...state.local } : null,
        expectedLocal: { ...local },
      },
    },
  ];
  const capture = state.capture;
  const bounds = capture?.bounds;
  const pixelsOk =
    bounds !== undefined &&
    bounds.w <= POINTER_MAX_EXTENT &&
    bounds.h <= POINTER_MAX_EXTENT &&
    local.x >= bounds.x - POINTER_SLACK &&
    local.x <= bounds.x + bounds.w + POINTER_SLACK &&
    local.y >= bounds.y - POINTER_SLACK &&
    local.y <= bounds.y + bounds.h + POINTER_SLACK;
  checks.push({
    name: "drawn_pixels",
    ok: capture === undefined ? null : capture.error ? false : pixelsOk,
    detail: {
      pointerBounds: bounds ? rectJson(bounds) : null,
      opaquePixels: capture?.opaquePixels ?? 0,
      expectedLocal: { ...local },
      error: capture?.error ?? (capture === undefined ? "not captured" : null),
    },
  });
  return checks;
}
