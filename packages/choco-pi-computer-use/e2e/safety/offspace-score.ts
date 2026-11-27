import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";

export interface DisplaySpaces {
  display: string;
  current: number;
  desktopSpaces: number[];
}

export interface WindowSpaces {
  windowNumber: number;
  spaces: number[];
}

export interface SpacesState {
  windows: WindowSpaces[];
  displays: DisplaySpaces[];
  frontPid?: number;
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: JsonObject;
}

function numbers(value: JsonValue | undefined): number[] {
  return Array.isArray(value) ? value.filter(isNumber) : [];
}

export function parseSpaces(row: JsonObject | undefined): SpacesState | undefined {
  if (!row || !Array.isArray(row.windows) || !Array.isArray(row.displays)) return undefined;
  const windows: WindowSpaces[] = [];
  for (const entry of row.windows) {
    if (isJsonObject(entry) && isNumber(entry.windowNumber))
      windows.push({ windowNumber: entry.windowNumber, spaces: numbers(entry.spaces) });
  }
  const displays: DisplaySpaces[] = [];
  for (const entry of row.displays) {
    if (isJsonObject(entry) && isString(entry.display) && isNumber(entry.current))
      displays.push({
        display: entry.display,
        current: entry.current,
        desktopSpaces: numbers(entry.desktopSpaces),
      });
  }
  const state: SpacesState = { windows, displays };
  if (isNumber(row.frontPid)) state.frontPid = row.frontPid;
  return state;
}

export function currentSpaces(state: SpacesState): string[] {
  return state.displays.map((display) => `${display.display}=${display.current}`);
}

export function offSpaceCheck(name: string, state: SpacesState | undefined): Check {
  if (!state || state.windows.length === 0)
    return { name, ok: false, detail: { reason: "no spaces row" } };
  const current = new Set(state.displays.map((display) => display.current));
  const desktop = new Set(state.displays.flatMap((display) => display.desktopSpaces));
  const bad = state.windows.filter(
    (window) =>
      window.spaces.length === 0 ||
      window.spaces.some((space) => current.has(space) || !desktop.has(space)),
  );
  return {
    name,
    ok: bad.length === 0,
    detail: {
      windows: state.windows.map((window) => ({ ...window })),
      current: [...current],
    },
  };
}

export function spacesUnchangedCheck(
  name: string,
  baseline: SpacesState,
  state: SpacesState | undefined,
): Check {
  const before = currentSpaces(baseline);
  const after = state ? currentSpaces(state) : [];
  const ok = before.length > 0 && before.join(",") === after.join(",");
  return { name, ok, detail: { before, after } };
}

export function frontmostRows(rows: JsonObject[]): JsonObject[] {
  return rows.filter((row) => row.event === "frontmost");
}

export function lastActivation(rows: JsonObject[]): "appActive" | "appInactive" | "none" {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const event = rows[index]?.event;
    if (event === "appActive" || event === "appInactive") return event;
  }
  return "none";
}

export function countEvents(rows: JsonObject[], event: string): number {
  return rows.filter((row) => row.event === event).length;
}

export function lastFieldValue(rows: JsonObject[]): string | undefined {
  const values = rows.filter((row) => row.event === "fieldValue");
  const last = values[values.length - 1];
  return last && isString(last.value) ? last.value : undefined;
}

export function customHitsSince(rows: JsonObject[], from: number): number {
  return rows.filter((row) => row.event === "customHit" && isNumber(row.ts) && row.ts >= from)
    .length;
}

export function typedOnceCheck(name: string, rows: JsonObject[], text: string): Check {
  const value = lastFieldValue(rows);
  const doubled = rows.some(
    (row) => row.event === "fieldValue" && isString(row.value) && row.value.includes(text + text),
  );
  return { name, ok: value === text && !doubled, detail: { value: value ?? null, expected: text } };
}

export function verdictOf(checks: Check[]): "PASS" | "FAIL" {
  return checks.length > 0 && checks.every((check) => check.ok) ? "PASS" : "FAIL";
}
