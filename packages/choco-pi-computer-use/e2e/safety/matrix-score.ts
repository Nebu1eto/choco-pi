import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";
import { inWindow, type TimeWindow } from "./score.ts";

/**
 * Pure scoring for the delivery matrix (safety/matrix.ts). A cell is a surface x action; each
 * repetition is judged only from what the fixture (or the Chromium page through the harness server)
 * recorded. The helper's answer is a measured column, never the judgement.
 */

export type Scalar = string | number | boolean;

export type EffectSpec =
  | { kind: "count"; event: string; where?: Record<string, Scalar>; duplicates?: boolean }
  | { kind: "value"; event: string; value: string; duplicates?: boolean }
  | { kind: "selectAll"; event: string; where?: Record<string, Scalar> }
  | {
      kind: "moved";
      event: string;
      field: string;
      from: number;
      where?: Record<string, Scalar>;
      baselineEvents?: readonly string[];
    }
  | { kind: "drag"; event: string };

export interface EffectResult {
  effect: boolean;
  count: number;
  duplicate: boolean | null;
}

function matches(row: JsonObject, where: Record<string, Scalar> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function rowsOf(rows: JsonObject[], event: string, window: TimeWindow): JsonObject[] {
  return rows.filter((row) => row.event === event && inWindow(row, window));
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  )
    count += 1;
  return count;
}

function numberField(row: JsonObject, key: string): number | undefined {
  const value = row[key];
  return isNumber(value) ? value : undefined;
}

export function selectsAll(row: JsonObject): boolean {
  const total = numberField(row, "textLength");
  if (total === undefined || total <= 0) return false;
  const location = numberField(row, "location");
  const length = numberField(row, "length");
  if (location !== undefined && length !== undefined) return location === 0 && length === total;
  const start = numberField(row, "start");
  const end = numberField(row, "end");
  return start === 0 && end === total;
}

export function evaluateEffect(
  spec: EffectSpec,
  rows: JsonObject[],
  window: TimeWindow,
): EffectResult {
  const inside = rowsOf(rows, spec.event, window);
  switch (spec.kind) {
    case "count": {
      const hits = inside.filter((row) => matches(row, spec.where));
      return {
        effect: hits.length > 0,
        count: hits.length,
        duplicate: spec.duplicates === false ? null : hits.length > 1,
      };
    }
    case "value": {
      const values = inside.map((row) => (isString(row.value) ? row.value : ""));
      const hits = values.filter((value) => value === spec.value);
      return {
        effect: hits.length > 0,
        count: hits.length,
        duplicate:
          spec.duplicates === false
            ? null
            : values.some((value) => occurrences(value, spec.value) > 1),
      };
    }
    case "selectAll": {
      const hits = inside.filter((row) => matches(row, spec.where) && selectsAll(row));
      return { effect: hits.length > 0, count: hits.length, duplicate: null };
    }
    case "moved": {
      const sources = [spec.event, ...(spec.baselineEvents ?? [])];
      const before = rows.filter(
        (row) =>
          isString(row.event) &&
          sources.includes(row.event) &&
          numberField(row, spec.field) !== undefined &&
          matches(row, spec.where) &&
          isNumber(row.ts) &&
          row.ts < window.from,
      );
      const last =
        before.length > 0 ? numberField(before[before.length - 1], spec.field) : undefined;
      const baseline = last ?? spec.from;
      const hits = inside.filter((row) => {
        const value = numberField(row, spec.field);
        return matches(row, spec.where) && value !== undefined && value !== baseline;
      });
      return { effect: hits.length > 0, count: hits.length, duplicate: null };
    }
    case "drag": {
      const hits = inside.filter((row) => row.startRegion === "A" && row.endRegion === "B");
      return { effect: hits.length > 0, count: hits.length, duplicate: hits.length > 1 };
    }
  }
}

export interface Answer {
  answer: string;
  code: string | null;
  delivery: string | null;
  grounding: string | null;
  effectPossible: boolean | null;
  inputSent: boolean | null;
  evidence: JsonObject | null;
  message: string | null;
}

const EVIDENCE_KEYS = [
  "deliveryUsed",
  "pidPointerAttempted",
  "observableChange",
  "pixelCheck",
  "pixelChange",
  "pixelChangeOutsideTarget",
  "changeOutsideTarget",
  "pixelRegion",
  "frontmostChangedElsewhere",
  "frontmostChangedTo",
  "windowChanged",
  "focusHeld",
  "valueChanged",
  "rootDelta",
];

function reduceEvidence(value: JsonValue | undefined): JsonObject | null {
  if (!isJsonObject(value)) return null;
  const out: JsonObject = {};
  for (const key of EVIDENCE_KEYS) if (value[key] !== undefined) out[key] = value[key];
  return Object.keys(out).length > 0 ? out : null;
}

const flag = (value: JsonValue | undefined): boolean | null =>
  value === true ? true : value === false ? false : null;

export function classifyAnswer(reply: JsonObject | undefined): Answer {
  const empty: Answer = {
    answer: "transport_error",
    code: null,
    delivery: null,
    grounding: null,
    effectPossible: null,
    inputSent: null,
    evidence: null,
    message: null,
  };
  if (!reply) return empty;
  if (reply.ok === true && isJsonObject(reply.result)) {
    const result = reply.result;
    const performed = isJsonObject(result.performed) ? result.performed : {};
    return {
      ...empty,
      answer: isString(result.outcome) ? result.outcome : "ok_without_outcome",
      delivery: isString(performed.delivery) ? performed.delivery : null,
      grounding: isString(performed.grounding) ? performed.grounding : null,
      evidence: reduceEvidence(result.evidence),
    };
  }
  const error = isJsonObject(reply.error) ? reply.error : {};
  const details = isJsonObject(error.details) ? error.details : {};
  const code = isString(error.code) ? error.code : "unknown_error";
  return {
    ...empty,
    answer: "refused:" + code,
    code,
    effectPossible: flag(error.effectPossible ?? details.effectPossible),
    inputSent: flag(error.inputSent ?? details.inputSent),
    evidence: reduceEvidence(error.evidence ?? details.evidence),
    message: isString(error.message) ? error.message.slice(0, 200) : null,
  };
}

export interface Disturbances {
  appInactive: number;
  windowResignKey: number;
  keyDown: number;
  mouseDown: number;
  otherFrontmost: number;
}

export const DISTURBANCE_KEYS: (keyof Disturbances)[] = [
  "appInactive",
  "windowResignKey",
  "keyDown",
  "mouseDown",
  "otherFrontmost",
];

export function holderDisturbances(
  holder: JsonObject[],
  holderPid: number,
  window: TimeWindow,
): Disturbances {
  const count = (event: string): number => rowsOf(holder, event, window).length;
  return {
    appInactive: count("appInactive"),
    windowResignKey: count("windowResignKey"),
    keyDown: count("keyDown"),
    mouseDown: count("mouseDown"),
    otherFrontmost: rowsOf(holder, "frontmost", window).filter((row) => row.frontPid !== holderPid)
      .length,
  };
}

export function disturbed(value: Disturbances): boolean {
  return DISTURBANCE_KEYS.some((key) => value[key] > 0);
}

export interface Arrival {
  mouseDown: number;
  keyDown: number;
  scrollWheel: number;
  targetActivated: number;
}

export function targetArrival(rows: JsonObject[], window: TimeWindow, web: boolean): Arrival {
  const count = (event: string): number => rowsOf(rows, event, window).length;
  return web
    ? {
        mouseDown: count("webMouseDown"),
        keyDown: count("webKeyDown"),
        scrollWheel: count("webWheel"),
        targetActivated: 0,
      }
    : {
        mouseDown: count("targetMouseDown"),
        keyDown: count("targetKeyDown"),
        scrollWheel: count("targetScrollWheel"),
        targetActivated: count("appActive"),
      };
}

export type Mode = "background" | "foreground";

export interface Rep {
  cell: string;
  mode: Mode;
  rep: number;
  skipped: string | null;
  answer: Answer;
  effect: EffectResult;
  holder: Disturbances;
  arrival: Arrival;
  actMs: number | null;
  notes: JsonObject;
}

export interface ModeSummary {
  n: number;
  skipped: number;
  effects: number;
  effectRate: number | null;
  answers: Record<string, number>;
  falseWorked: number;
  refusedWithEffect: number;
  didntWithEffect: number;
  duplicates: number | null;
  disturbances: Disturbances;
  disturbedReps: number;
  arrivedReps: number;
  medianActMs: number | null;
  p95ActMs: number | null;
}

export function percentile(samples: (number | null | undefined)[], p: number): number | null {
  const values = samples.filter((value): value is number => isNumber(value)).sort((a, b) => a - b);
  if (values.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * values.length));
  return values[Math.min(values.length, rank) - 1];
}

export function median(samples: (number | null | undefined)[]): number | null {
  const values = samples.filter((value): value is number => isNumber(value)).sort((a, b) => a - b);
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

export function summarize(reps: Rep[]): ModeSummary {
  const measured = reps.filter((rep) => rep.skipped === null);
  const answers: Record<string, number> = {};
  for (const rep of measured) answers[rep.answer.answer] = (answers[rep.answer.answer] ?? 0) + 1;
  const disturbances: Disturbances = {
    appInactive: 0,
    windowResignKey: 0,
    keyDown: 0,
    mouseDown: 0,
    otherFrontmost: 0,
  };
  for (const rep of measured)
    for (const key of DISTURBANCE_KEYS) disturbances[key] += rep.holder[key];
  const effects = measured.filter((rep) => rep.effect.effect).length;
  const dupApplicable = measured.filter((rep) => rep.effect.duplicate !== null);
  return {
    n: measured.length,
    skipped: reps.length - measured.length,
    effects,
    effectRate: measured.length > 0 ? effects / measured.length : null,
    answers,
    falseWorked: measured.filter((rep) => rep.answer.answer === "worked" && !rep.effect.effect)
      .length,
    refusedWithEffect: measured.filter(
      (rep) => rep.answer.answer.startsWith("refused:") && rep.effect.effect,
    ).length,
    didntWithEffect: measured.filter((rep) => rep.answer.answer === "didnt" && rep.effect.effect)
      .length,
    duplicates:
      dupApplicable.length > 0
        ? dupApplicable.filter((rep) => rep.effect.duplicate === true).length
        : null,
    disturbances,
    disturbedReps: measured.filter((rep) => disturbed(rep.holder)).length,
    arrivedReps: measured.filter(
      (rep) => rep.arrival.mouseDown + rep.arrival.keyDown + rep.arrival.scrollWheel > 0,
    ).length,
    medianActMs: median(measured.map((rep) => rep.actMs)),
    p95ActMs: percentile(
      measured.map((rep) => rep.actMs),
      95,
    ),
  };
}

export interface LookSample {
  surface: string;
  config: string;
  ok: boolean;
  captureMs: number | null;
  describeMs: number | null;
  readTextMs: number | null;
  nodeCount: number | null;
  wallMs: number;
  replyBytes: number;
}

export function countNodes(node: JsonValue | undefined): number {
  if (!isJsonObject(node)) return 0;
  const children = Array.isArray(node.children) ? node.children : [];
  return 1 + children.reduce<number>((sum, child) => sum + countNodes(child), 0);
}

export interface LatencySummary {
  surface: string;
  config: string;
  n: number;
  failures: number;
  stats: Record<string, { median: number | null; p95: number | null }>;
}

const LATENCY_FIELDS = [
  "wallMs",
  "captureMs",
  "describeMs",
  "readTextMs",
  "nodeCount",
  "replyBytes",
] as const;

export function summarizeLooks(samples: LookSample[]): LatencySummary[] {
  const groups = new Map<string, LookSample[]>();
  for (const sample of samples) {
    const key = sample.surface + " " + sample.config;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  return [...groups.values()].map((group) => {
    const ok = group.filter((sample) => sample.ok);
    const stats: LatencySummary["stats"] = {};
    for (const field of LATENCY_FIELDS) {
      const values = ok.map((sample) => sample[field]);
      stats[field] = { median: median(values), p95: percentile(values, 95) };
    }
    return {
      surface: group[0].surface,
      config: group[0].config,
      n: ok.length,
      failures: group.length - ok.length,
      stats,
    };
  });
}

export interface CellInfo {
  id: string;
  surface: string;
  element: string;
  action: string;
  effect: string;
  route: string;
}

export interface CellTable {
  info: CellInfo;
  background: ModeSummary;
  foreground: ModeSummary;
}

const fmtRate = (summary: ModeSummary): string =>
  summary.n === 0
    ? "n/a" + (summary.skipped ? " (" + String(summary.skipped) + " skipped)" : "")
    : String(summary.effects) +
      "/" +
      String(summary.n) +
      (summary.skipped ? " (+" + String(summary.skipped) + " skipped)" : "");

export function fmtAnswers(answers: Record<string, number>): string {
  const entries = Object.entries(answers).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length === 0
    ? "-"
    : entries
        .map(([answer, count]) => answer.replace(/^refused:/, "R:") + " " + String(count))
        .join(", ");
}

export function fmtDisturbances(summary: ModeSummary): string {
  const parts = DISTURBANCE_KEYS.filter((key) => summary.disturbances[key] > 0).map(
    (key) => key + " " + String(summary.disturbances[key]),
  );
  return parts.length === 0 ? "none" : String(summary.disturbedReps) + " reps: " + parts.join(", ");
}

const fmtMs = (value: number | null): string => (value === null ? "-" : String(Math.round(value)));
const fmtDup = (value: number | null): string => (value === null ? "n/o" : String(value));
const cellText = (value: string): string => value.replace(/\|/g, "/");

export function renderCellTable(tables: CellTable[]): string {
  const header = [
    "| cell | route (look) | bg effect | bg answers | false worked | refused w/ effect | didnt w/ effect | bg dup | bg input reached app | bg holder disturbance | bg median act ms | fg effect | fg answers | fg dup | fg holder disturbance | fg median act ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = tables.map(({ info, background: bg, foreground: fg }) =>
    [
      info.id,
      info.route,
      fmtRate(bg),
      fmtAnswers(bg.answers),
      String(bg.falseWorked),
      String(bg.refusedWithEffect),
      String(bg.didntWithEffect),
      fmtDup(bg.duplicates),
      bg.n === 0 ? "-" : String(bg.arrivedReps) + "/" + String(bg.n),
      fmtDisturbances(bg),
      fmtMs(bg.medianActMs),
      fmtRate(fg),
      fmtAnswers(fg.answers),
      fmtDup(fg.duplicates),
      fmtDisturbances(fg),
      fmtMs(fg.medianActMs),
    ]
      .map(cellText)
      .join(" | "),
  );
  return [...header, ...rows.map((row) => "| " + row + " |")].join("\n");
}

export function believesActive(rows: JsonObject[]): boolean {
  const states = rows.filter((row) => row.event === "appActive" || row.event === "appInactive");
  return states.length > 0 && states[states.length - 1]?.event === "appActive";
}

export interface AfterState {
  cell: string;
  measured: number;
  extendedUsed: number;
  extendedOther: Record<string, number>;
  activated: number;
  leftActive: number | null;
}

export function summarizeAfterState(cellIds: string[], reps: Rep[]): AfterState[] {
  return cellIds.map((cell) => {
    const mine = reps.filter(
      (rep) => rep.cell === cell && rep.mode === "background" && !rep.skipped,
    );
    const extendedOther: Record<string, number> = {};
    let extendedUsed = 0;
    let activated = 0;
    let leftActive: number | null = null;
    for (const rep of mine) {
      const status = rep.notes.extendedDelivery;
      if (status === "used") extendedUsed += 1;
      else if (isString(status)) extendedOther[status] = (extendedOther[status] ?? 0) + 1;
      const rows = rep.notes.targetFocusRows;
      if (Array.isArray(rows) && rows.some((row) => isString(row) && row.startsWith("appActive")))
        activated += 1;
      const active = rep.notes.targetBelievesActive;
      if (active === true || active === false) leftActive = (leftActive ?? 0) + (active ? 1 : 0);
    }
    return { cell, measured: mine.length, extendedUsed, extendedOther, activated, leftActive };
  });
}

export function renderAfterStateTable(rows: AfterState[]): string {
  const header = [
    "| cell | measured | extended used | other extended status | target activated during act | target left active |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const body = rows.map((row) =>
    [
      row.cell,
      String(row.measured),
      String(row.extendedUsed),
      fmtAnswers(row.extendedOther),
      row.leftActive === null ? "n/o" : String(row.activated),
      row.leftActive === null ? "n/o" : String(row.leftActive),
    ]
      .map(cellText)
      .join(" | "),
  );
  return [...header, ...body.map((row) => "| " + row + " |")].join("\n");
}

export function renderLatencyTable(summaries: LatencySummary[]): string {
  const pair = (summary: LatencySummary, field: string): string => {
    const stat = summary.stats[field];
    return stat ? fmtMs(stat.median) + " / " + fmtMs(stat.p95) : "-";
  };
  const header = [
    "| surface | look config | n (fail) | wall ms | captureMs | describeMs | readTextMs | nodes | reply bytes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = summaries.map((summary) =>
    [
      summary.surface,
      summary.config,
      String(summary.n) + (summary.failures ? " (" + String(summary.failures) + ")" : ""),
      pair(summary, "wallMs"),
      pair(summary, "captureMs"),
      pair(summary, "describeMs"),
      pair(summary, "readTextMs"),
      pair(summary, "nodeCount"),
      pair(summary, "replyBytes"),
    ].join(" | "),
  );
  return [...header, ...rows.map((row) => "| " + row + " |")].join("\n");
}
