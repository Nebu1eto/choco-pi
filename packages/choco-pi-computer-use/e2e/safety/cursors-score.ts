import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";
import {
  distance,
  inside,
  pointOf,
  rectJson,
  rectOf,
  screenContaining,
  type Check,
  type Point,
  type Rect,
  type Screen,
} from "./displays-score.ts";

export const TIP_TOLERANCE = 1.5;
export const FOREIGN_DISTANCE = 3;
export const LEGACY_TIP_OFFSET = 13.24 / Math.SQRT2;

export interface CursorReport {
  session: string | null;
  windowId: number | null;
  windowNumber: number | null;
  displayId: number | null;
  target: Point | undefined;
  points: Point[];
  tip: Point | undefined;
  animating: boolean;
  fading: boolean;
  visible: boolean;
  paletteIndex: number | null;
  windowServerBounds: Rect | undefined;
  windowServerOnscreen: boolean | null;
  windowBelow: number | null;
  issuedAt: number | null;
  drawnAt: number | null;
  arrivedAt: number | null;
  capture?: { tip?: Point; bodyTopLeft?: Point; error?: string };
}

export interface HistoryEvent {
  kind: string;
  reason: string | null;
  session: string;
  windowId: number;
  at: number;
}

export interface CursorStateReport {
  legacy: boolean;
  now: number | null;
  cursors: CursorReport[];
  history: HistoryEvent[];
  dropped: Record<string, number>;
  idleMs: number | null;
  fadeMs: number | null;
  livenessMs: number | null;
}

function flag(value: JsonValue | undefined): boolean | null {
  return value === true ? true : value === false ? false : null;
}

function numberOr(value: JsonValue | undefined): number | null {
  return isNumber(value) ? value : null;
}

function parseCapture(
  value: JsonValue | undefined,
  display: Rect | undefined,
): CursorReport["capture"] {
  if (!isJsonObject(value)) return undefined;
  const bounds = rectOf(value.bounds);
  return {
    tip: pointOf(value.tip),
    bodyTopLeft:
      bounds && display ? { x: bounds.x + display.x, y: bounds.y + display.y } : undefined,
    error: isString(value.error) ? value.error : undefined,
  };
}

export function parseCursorReport(result: JsonValue | undefined): CursorStateReport | undefined {
  if (!isJsonObject(result) || result.supported !== true) return undefined;
  const history: HistoryEvent[] = [];
  for (const row of Array.isArray(result.history) ? result.history : []) {
    if (!isJsonObject(row) || !isString(row.kind) || !isNumber(row.at)) continue;
    history.push({
      kind: row.kind,
      reason: isString(row.reason) ? row.reason : null,
      session: isString(row.session) ? row.session : "",
      windowId: isNumber(row.windowId) ? row.windowId : 0,
      at: row.at,
    });
  }
  const dropped: Record<string, number> = {};
  if (isJsonObject(result.dropped))
    for (const [reason, count] of Object.entries(result.dropped))
      if (isNumber(count)) dropped[reason] = count;
  const base = {
    now: numberOr(result.now),
    history,
    dropped,
    idleMs: numberOr(result.idleMs),
    fadeMs: numberOr(result.fadeMs),
    livenessMs: numberOr(result.livenessMs),
  };
  if (Array.isArray(result.cursors)) {
    const cursors: CursorReport[] = [];
    for (const entry of result.cursors) {
      if (!isJsonObject(entry)) continue;
      const display = rectOf(entry.displayBounds);
      cursors.push({
        session: isString(entry.session) ? entry.session : "",
        windowId: numberOr(entry.windowId),
        windowNumber: numberOr(entry.windowNumber),
        displayId: numberOr(entry.displayId),
        target: pointOf(entry.target),
        points: (Array.isArray(entry.points) ? entry.points : [])
          .map((point) => pointOf(point))
          .filter((point): point is Point => point !== undefined),
        tip: pointOf(entry.tip),
        animating: entry.animating === true,
        fading: entry.fading === true,
        visible: entry.visible === true,
        paletteIndex: numberOr(entry.paletteIndex),
        windowServerBounds: rectOf(entry.windowServerBounds),
        windowServerOnscreen: flag(entry.windowServerOnscreen),
        windowBelow: numberOr(entry.windowBelow),
        issuedAt: numberOr(entry.issuedAt),
        drawnAt: numberOr(entry.drawnAt),
        arrivedAt: numberOr(entry.arrivedAt),
        capture: parseCapture(entry.capture, display),
      });
    }
    return { legacy: false, cursors, ...base };
  }
  const overlay = isJsonObject(result.overlay) ? result.overlay : undefined;
  const pointer = isJsonObject(result.pointer) ? result.pointer : undefined;
  const cursors: CursorReport[] = [];
  const display = overlay ? rectOf(overlay.displayBounds) : undefined;
  if (overlay && display && pointer) {
    const position = pointOf(pointer.position);
    const target = pointOf(pointer.target);
    cursors.push({
      session: null,
      windowId: null,
      windowNumber: numberOr(overlay.windowNumber),
      displayId: numberOr(overlay.displayId),
      target,
      points: target ? [target] : [],
      tip: position
        ? {
            x: display.x + position.x - LEGACY_TIP_OFFSET,
            y: display.y + position.y - LEGACY_TIP_OFFSET,
          }
        : undefined,
      animating: pointer.animating === true,
      fading: false,
      visible: overlay.visible === true,
      paletteIndex: null,
      windowServerBounds: rectOf(overlay.windowServerBounds),
      windowServerOnscreen: flag(overlay.windowServerOnscreen),
      windowBelow: null,
      issuedAt: null,
      drawnAt: null,
      arrivedAt: null,
      capture: parseCapture(result.capture, display),
    });
  }
  return { legacy: true, cursors, ...base };
}

export interface Acted {
  session: string;
  label: string;
  windowId: number;
  point: Point;
  path?: Point[];
  received?: Point;
  draws: boolean;
}

function pointJson(point: Point | undefined): JsonObject | null {
  return point ? { x: point.x, y: point.y } : null;
}

export function cursorOf(report: CursorStateReport, acted: Acted): CursorReport | undefined {
  if (report.legacy) {
    const only = report.cursors[0];
    return only?.target && distance(only.target, acted.point) <= 0.5 ? only : undefined;
  }
  return report.cursors.find(
    (cursor) => cursor.session === acted.session && cursor.windowId === acted.windowId,
  );
}

export function scoreSettled(
  name: string,
  acted: Acted[],
  report: CursorStateReport | undefined,
  screens: Screen[],
): Check[] {
  if (!report)
    return [
      { name: name + "_state", ok: null, detail: { reason: "agentCursorState unsupported" } },
    ];
  const drawing = acted.filter((entry) => entry.draws);
  const checks: Check[] = [];
  const found = drawing.map((entry) => ({ entry, cursor: cursorOf(report, entry) }));
  checks.push({
    name: name + "_cursors_concurrent",
    ok:
      found.every(({ cursor }) => cursor !== undefined) &&
      (report.legacy ? drawing.length <= 1 : true),
    detail: {
      expected: drawing.length,
      present: found.filter(({ cursor }) => cursor !== undefined).length,
      legacy: report.legacy,
      reported: report.cursors.length,
    },
  });
  for (const { entry, cursor } of found) {
    const reference = entry.received ?? entry.point;
    const screen = screenContaining(entry.point, screens);
    const tipError = cursor?.tip ? distance(cursor.tip, reference) : null;
    const pixelError = cursor?.capture?.tip ? distance(cursor.capture.tip, reference) : null;
    const bodyCornerError = cursor?.capture?.bodyTopLeft
      ? distance(cursor.capture.bodyTopLeft, reference)
      : null;
    const bounds = cursor?.windowServerBounds;
    const prefix = name + "_" + entry.label;
    checks.push({
      name: prefix + "_target",
      ok: cursor?.target !== undefined && distance(cursor.target, entry.point) <= 0.5,
      detail: {
        target: pointJson(cursor?.target),
        point: pointJson(entry.point),
        received: pointJson(entry.received),
      },
    });
    if (entry.path) {
      const path = entry.path;
      checks.push({
        name: prefix + "_drag_path",
        ok:
          cursor !== undefined &&
          (report.legacy ||
            (cursor.points.length === path.length &&
              cursor.points.every((point, index) => distance(point, path[index]) <= 0.5))),
        detail: {
          drawn: (cursor?.points ?? []).map((point) => ({ ...point })),
          path: path.map((point) => ({ ...point })),
        },
      });
    }
    checks.push({
      name: prefix + "_tip",
      ok: tipError !== null && tipError <= TIP_TOLERANCE,
      detail: { tip: pointJson(cursor?.tip), reference: pointJson(reference), error: tipError },
    });
    checks.push({
      name: prefix + "_pixel_tip",
      ok:
        cursor?.capture === undefined
          ? null
          : cursor.capture.error !== undefined
            ? false
            : report.legacy
              ? bodyCornerError !== null && bodyCornerError <= TIP_TOLERANCE
              : pixelError !== null && pixelError <= TIP_TOLERANCE,
      detail: {
        pixelTip: pointJson(cursor?.capture?.tip),
        bodyTopLeft: pointJson(cursor?.capture?.bodyTopLeft),
        reference: pointJson(reference),
        error: pixelError,
        bodyCornerError,
        captureError: cursor?.capture?.error ?? null,
      },
    });
    checks.push({
      name: prefix + "_display",
      ok:
        cursor !== undefined &&
        screen !== undefined &&
        cursor.displayId === screen.id &&
        bounds !== undefined &&
        inside(bounds, screen.bounds) &&
        cursor.windowServerOnscreen === true,
      detail: {
        displayId: cursor?.displayId ?? null,
        expected: screen?.id ?? null,
        windowServerBounds: bounds ? rectJson(bounds) : null,
        onscreen: cursor?.windowServerOnscreen ?? null,
      },
    });
    checks.push({
      name: prefix + "_ordered_above_target",
      ok: report.legacy ? null : cursor !== undefined && cursor.windowBelow === entry.windowId,
      detail: { windowBelow: cursor?.windowBelow ?? null, target: entry.windowId },
    });
  }
  return checks;
}

export function scoreSamples(name: string, acted: Acted[], samples: CursorStateReport[]): Check[] {
  const drawing = acted.filter((entry) => entry.draws);
  let most = 0;
  const foreign: JsonObject[] = [];
  for (const sample of samples) {
    const ours = sample.cursors.filter((cursor) =>
      sample.legacy ? true : drawing.some((entry) => entry.session === cursor.session),
    );
    most = Math.max(most, ours.filter((cursor) => cursor.visible).length);
    if (sample.legacy) continue;
    for (const cursor of ours) {
      if (cursor.animating) continue;
      for (const other of drawing) {
        if (other.session === cursor.session) continue;
        const atTarget = cursor.target !== undefined && distance(cursor.target, other.point) <= 0.5;
        const atTip =
          cursor.tip !== undefined && distance(cursor.tip, other.point) <= FOREIGN_DISTANCE;
        if (atTarget || atTip)
          foreign.push({
            session: cursor.session,
            at: pointJson(cursor.tip),
            other: other.session,
          });
      }
    }
  }
  return [
    {
      name: name + "_max_simultaneous",
      ok: samples.length === 0 ? null : most >= drawing.length,
      detail: { most, expected: drawing.length, samples: samples.length },
    },
    {
      name: name + "_never_at_other_session",
      ok: samples.length === 0 ? null : foreign.length === 0,
      detail: { violations: foreign.slice(0, 10), count: foreign.length },
    },
  ];
}

export function scorePointer(
  samples: { x: number; y: number; ts: number }[],
  actedPoints: Point[],
  window: { from: number; to: number },
): Check {
  const during = samples.filter((sample) => sample.ts >= window.from && sample.ts <= window.to);
  const atActed = during.filter((sample) =>
    actedPoints.some((point) => distance(sample, point) <= 2),
  );
  return {
    name: "real_pointer_untouched",
    ok: atActed.length === 0,
    detail: {
      changesDuringRun: during.length,
      atActedPoints: atActed.slice(0, 10).map((sample) => ({ ...sample })),
      note: "changes away from acted points are the user's own moves",
    },
  };
}

export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}
