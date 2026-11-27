import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { arch } from "node:os";
import { join, resolve } from "node:path";
import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";
import { unregisterFixture } from "../desktop.ts";
import { buildFixture, fixtureApps, type FixtureBuild } from "../fixture/build.ts";
import { command, socketBusy } from "../preflight.ts";
import {
  CHROMIUM_TITLE,
  ChromiumInstance,
  findChromium,
  PageServer,
  type ChromiumApp,
  type ChromiumLeftover,
} from "./chromium.ts";
import { FixtureSet, frontApp, sweepFixtureProcesses, type FrontApp } from "./fixtures.ts";
import {
  believesActive,
  classifyAnswer,
  countNodes,
  evaluateEffect,
  holderDisturbances,
  renderAfterStateTable,
  renderCellTable,
  renderLatencyTable,
  summarize,
  summarizeAfterState,
  summarizeLooks,
  targetArrival,
  type CellInfo,
  type CellTable,
  type EffectSpec,
  type LookSample,
  type Mode,
  type Rep,
} from "./matrix-score.ts";
import { matrixPage } from "./matrix-page.ts";
import { checkHelper } from "./scenarios.ts";
import { isMainHelper, type TimeWindow } from "./score.ts";
import { RequestLog, Wire, WireError } from "./wire.ts";

/**
 * Delivery matrix: measures, per UI surface and action, what background-only delivery
 * (policy "background", no grant) achieves, judged by what the fixture itself recorded, with a
 * granted foreground reference. No verdicts. Usage:
 *
 *   node packages/choco-pi-computer-use/e2e/safety/matrix.ts --helper-app <dev app>
 *     --helper-socket <dev socket> --out <fresh dir> [--reps 5] [--fg-reps 2] [--looks 20]
 *     [--surfaces a,b] [--cells <substring,...>] [--no-chromium] [--skip-latency] [--settle-ms 800]
 */

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

type SurfaceId = "appkit-main" | "appkit" | "swiftui" | "webkit" | "chromium";
type ActionId =
  | "click_ref"
  | "click_xy"
  | "set_text"
  | "type_text"
  | "key"
  | "chord"
  | "scroll_ref"
  | "scroll_xy"
  | "drag";

interface Surface {
  id: SurfaceId;
  window: (title: string) => boolean;
  web: boolean;
}

const SURFACES: Surface[] = [
  { id: "appkit-main", window: (title) => title === fixtureApps.target.title, web: false },
  { id: "appkit", window: (title) => title === "CU Matrix AppKit", web: false },
  { id: "swiftui", window: (title) => title === "CU Matrix SwiftUI", web: false },
  { id: "webkit", window: (title) => title === "CU Fixture Web", web: true },
  { id: "chromium", window: (title) => title.includes(CHROMIUM_TITLE), web: true },
];

type Finder = (root: JsonObject) => JsonObject | undefined;

interface Cell {
  id: string;
  surface: SurfaceId;
  element: string;
  find: Finder;
  action: ActionId;
  effect: EffectSpec;
  effectText: string;
  prefill: string;
}

function walk(
  node: JsonObject,
  visit: (node: JsonObject, parent: JsonObject | undefined) => boolean,
  parent?: JsonObject,
): JsonObject | undefined {
  if (visit(node, parent)) return node;
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (!isJsonObject(child)) continue;
    const found = walk(child, visit, node);
    if (found) return found;
  }
  return undefined;
}

const labels = (node: JsonObject): string[] =>
  [node.title, node.description, node.value].filter((value): value is string => isString(value));

const byId =
  (identifier: string): Finder =>
  (root) =>
    walk(root, (node) => node.identifier === identifier);

const byRoleLabel =
  (roles: string[], label: string): Finder =>
  (root) =>
    walk(
      root,
      (node) => isString(node.role) && roles.includes(node.role) && labels(node).includes(label),
    );

const byTextChild =
  (label: string): Finder =>
  (root) =>
    walk(root, (node) => {
      if (node.role === "AXStaticText" || node.role === "AXWebArea") return false;
      const children = Array.isArray(node.children) ? node.children : [];
      return children.some(
        (child) =>
          isJsonObject(child) && child.role === "AXStaticText" && labels(child).includes(label),
      );
    }) ?? walk(root, (node) => labels(node).includes(label));

const TEXT_SET = "matrix-set";
const TEXT_TYPE = "abc";
const KEY = "x";
const PREFILL = "hello world";

function textCells(
  surface: SurfaceId,
  element: string,
  find: Finder,
  events: { focus: EffectSpec; value: string; selection: EffectSpec },
): Cell[] {
  const base = { surface, element, find, prefill: "" };
  const id = (action: ActionId): string => surface + "." + element + "." + action;
  return [
    {
      ...base,
      id: id("click_ref"),
      action: "click_ref",
      effect: events.focus,
      effectText: "field focused",
    },
    {
      ...base,
      id: id("set_text"),
      action: "set_text",
      effect: { kind: "value", event: events.value, value: TEXT_SET, duplicates: false },
      effectText: "value " + TEXT_SET,
    },
    {
      ...base,
      id: id("type_text"),
      action: "type_text",
      effect: { kind: "value", event: events.value, value: TEXT_TYPE },
      effectText: "value " + TEXT_TYPE,
    },
    {
      ...base,
      id: id("key"),
      action: "key",
      effect: { kind: "value", event: events.value, value: KEY },
      effectText: "value " + KEY,
    },
    {
      ...base,
      id: id("chord"),
      action: "chord",
      effect: events.selection,
      effectText: "cmd+a selects all of '" + PREFILL + "'",
      prefill: PREFILL,
    },
  ];
}

function pointerCells(
  surface: SurfaceId,
  element: string,
  find: Finder,
  actions: ActionId[],
  effect: EffectSpec,
  effectText: string,
): Cell[] {
  return actions.map((action) => ({
    id: surface + "." + element + "." + action,
    surface,
    element,
    find,
    action,
    effect,
    effectText,
    prefill: "",
  }));
}

function webCells(surface: SurfaceId): Cell[] {
  return [
    ...textCells(surface, "input", byRoleLabel(["AXTextField"], "Web Field"), {
      focus: { kind: "count", event: "webFocus", duplicates: false },
      value: "webValue",
      selection: { kind: "selectAll", event: "webSelection" },
    }),
    ...pointerCells(
      surface,
      "button",
      byRoleLabel(["AXButton"], "Web Button"),
      ["click_ref", "click_xy"],
      { kind: "count", event: "webClick", where: { id: "web-button" } },
      "click handler ran",
    ),
    ...pointerCells(
      surface,
      "div",
      byTextChild("Web Div"),
      ["click_ref", "click_xy"],
      { kind: "count", event: "webClick", where: { id: "web-div" } },
      "click handler ran",
    ),
    ...pointerCells(
      surface,
      "scroll",
      byRoleLabel(["AXGroup", "AXScrollArea"], "Web Scroll"),
      ["scroll_ref", "scroll_xy"],
      { kind: "moved", event: "webScroll", field: "top", from: 360, baselineEvents: ["webReset"] },
      "scrollTop changed",
    ),
    ...pointerCells(
      surface,
      "drag",
      byRoleLabel(["AXGroup"], "Web Drag"),
      ["drag"],
      { kind: "drag", event: "webDrag" },
      "drag A to B",
    ),
  ];
}

const CELLS: Cell[] = [
  ...pointerCells(
    "appkit-main",
    "button",
    byId("cu-increment"),
    ["click_ref", "click_xy"],
    { kind: "count", event: "increment" },
    "increment",
  ),
  ...pointerCells(
    "appkit-main",
    "custom",
    byId("cu-custom-view"),
    ["click_ref", "click_xy"],
    { kind: "count", event: "customHit" },
    "customHit",
  ),
  ...textCells("appkit-main", "field", byId("cu-field"), {
    focus: {
      kind: "count",
      event: "responder",
      where: { window: "main", kind: "fieldEditor" },
      duplicates: false,
    },
    value: "fieldValue",
    selection: { kind: "selectAll", event: "editorSelection", where: { window: "main" } },
  }),
  ...pointerCells(
    "appkit",
    "scroll",
    byId("cu-scroll"),
    ["scroll_ref", "scroll_xy"],
    { kind: "moved", event: "scrollPosition", field: "y", from: 500 },
    "clip view moved",
  ),
  ...pointerCells(
    "appkit",
    "drag",
    byId("cu-drag"),
    ["drag"],
    { kind: "drag", event: "dragUp" },
    "drag A to B",
  ),
  ...pointerCells(
    "appkit",
    "popup",
    byId("cu-popup"),
    ["click_ref", "click_xy"],
    { kind: "count", event: "menuOpened" },
    "menu opened",
  ),
  ...pointerCells(
    "appkit",
    "checkbox",
    byId("cu-checkbox"),
    ["click_ref", "click_xy"],
    { kind: "count", event: "checkbox" },
    "state toggled",
  ),
  ...pointerCells(
    "swiftui",
    "button",
    byId("cu-sw-button"),
    ["click_ref", "click_xy"],
    { kind: "count", event: "swiftuiButton" },
    "action ran",
  ),
  ...textCells("swiftui", "field", byId("cu-sw-field"), {
    focus: {
      kind: "count",
      event: "responder",
      where: { window: "swiftui", kind: "fieldEditor" },
      duplicates: false,
    },
    value: "swiftuiText",
    selection: { kind: "selectAll", event: "editorSelection", where: { window: "swiftui" } },
  }),
  ...pointerCells(
    "swiftui",
    "toggle",
    byId("cu-sw-toggle"),
    ["click_ref", "click_xy"],
    { kind: "count", event: "swiftuiToggle" },
    "isOn changed",
  ),
  ...pointerCells(
    "swiftui",
    "tap",
    byId("cu-sw-tap"),
    ["click_ref", "click_xy"],
    { kind: "count", event: "swiftuiTap" },
    "onTapGesture ran",
  ),
  ...webCells("webkit"),
  ...webCells("chromium"),
];

interface Options {
  helperApp: string;
  helperSocket: string;
  out: string;
  reps: number;
  fgReps: number;
  looks: number;
  surfaces: SurfaceId[];
  cells: string[] | null;
  chromium: boolean;
  latency: boolean;
  settleMs: number;
  backgroundDelivery: "standard" | "extended";
  afterCheck: boolean;
}

class ArgumentError extends Error {}

function parse(argv: string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const count = (flag: string, fallback: number, min: number): number => {
    const raw = value(flag);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < min)
      throw new ArgumentError(flag + " must be an integer >= " + String(min));
    return parsed;
  };
  const helperApp = value("--helper-app");
  const helperSocket = value("--helper-socket");
  const out = value("--out");
  if (!helperApp || !helperSocket || !out)
    throw new ArgumentError(
      "usage: matrix.ts --helper-app <app> --helper-socket <socket> --out <dir> [--reps N] [--fg-reps N] [--looks N] [--surfaces ids] [--cells substrings] [--no-chromium] [--skip-latency] [--settle-ms N] [--background-delivery standard|extended] [--after-check]",
    );
  const known = SURFACES.map((surface) => surface.id);
  const surfaceList = value("--surfaces");
  const surfaces: SurfaceId[] = [];
  for (const id of surfaceList
    ? surfaceList
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : known) {
    const found = known.find((candidate) => candidate === id);
    if (!found) throw new ArgumentError("unknown surface " + id + "; known: " + known.join(", "));
    surfaces.push(found);
  }
  const cellList = value("--cells");
  const delivery = value("--background-delivery") ?? "standard";
  if (delivery !== "standard" && delivery !== "extended")
    throw new ArgumentError("--background-delivery must be standard or extended");
  return {
    helperApp: resolve(helperApp),
    helperSocket: resolve(helperSocket),
    out: resolve(out),
    reps: count("--reps", 5, 1),
    fgReps: count("--fg-reps", 2, 0),
    looks: count("--looks", 20, 0),
    surfaces,
    cells: cellList
      ? cellList
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : null,
    chromium: !argv.includes("--no-chromium"),
    latency: !argv.includes("--skip-latency"),
    settleMs: count("--settle-ms", 800, 100),
    backgroundDelivery: delivery,
    afterCheck: argv.includes("--after-check"),
  };
}

function stripReply(reply: JsonObject): JsonObject {
  const kept: JsonObject = { ok: reply.ok ?? null };
  if (reply.id !== undefined) kept.id = reply.id;
  if (reply.error !== undefined) kept.error = reply.error;
  if (isJsonObject(reply.result)) {
    const result: JsonObject = {};
    for (const key of ["outcome", "performed", "evidence", "destination"])
      if (reply.result[key] !== undefined) result[key] = reply.result[key];
    kept.result = result;
  }
  return kept;
}

class MatrixLog extends RequestLog {
  override answer(row: JsonObject, reply: JsonObject | undefined, error?: string): void {
    super.answer(row, reply && row.cmd === "act" ? stripReply(reply) : reply, error);
  }
}

interface View {
  lookId: string;
  outline: JsonObject;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectOf(value: JsonValue | undefined): Rect | undefined {
  if (!isJsonObject(value)) return undefined;
  const { x, y, w, h } = value;
  return isNumber(x) && isNumber(y) && isNumber(w) && isNumber(h) ? { x, y, w, h } : undefined;
}

function route(node: JsonObject): string {
  const actions = Array.isArray(node.actions) ? node.actions.filter(isString) : [];
  const useful = actions
    .filter((action) => !["AXShowMenu", "AXScrollToVisible", "AXRaise"].includes(action))
    .map((action) => action.replace(/^AX/, ""));
  const role = isString(node.role) ? node.role.replace(/^AX/, "") : "?";
  const flags = [
    node.canSetValue === true ? "settable" : "",
    node.isTextInput === true ? "text" : "",
  ].filter(Boolean);
  return (
    role +
    (useful.length ? " [" + useful.join(",") + "]" : " [no action]") +
    (flags.length ? " " + flags.join(",") : "")
  );
}

interface Target {
  rows: () => Promise<JsonObject[]>;
  pid: number;
  reset: (text: string) => Promise<boolean>;
  fixtureTarget: boolean;
}

interface WindowTarget {
  windowId?: number;
  windowRef?: string;
}

interface Context {
  wire: Wire;
  fixtures: FixtureSet;
  holderPid: number;
  target: Target;
  options: Options;
  windows: Map<SurfaceId, WindowTarget>;
}

function errorCode(reply: JsonObject): string | undefined {
  return isJsonObject(reply.error) && isString(reply.error.code) ? reply.error.code : undefined;
}

async function findWindow(ctx: Context, surface: Surface): Promise<WindowTarget | undefined> {
  const cached = ctx.windows.get(surface.id);
  if (cached) return cached;
  const listed = await ctx.wire.send("listWindows", { pid: ctx.target.pid });
  const windows = Array.isArray(listed.reply.result) ? listed.reply.result : [];
  const window = windows.find(
    (entry) => isJsonObject(entry) && isString(entry.title) && surface.window(entry.title),
  );
  if (!isJsonObject(window)) return undefined;
  const found: WindowTarget = {};
  if (isNumber(window.windowId)) found.windowId = window.windowId;
  if (isString(window.windowRef)) found.windowRef = window.windowRef;
  ctx.windows.set(surface.id, found);
  return found;
}

type Failed = { error: string };

async function lookOnce(ctx: Context, surface: Surface): Promise<{ view: View } | Failed> {
  const window = await findWindow(ctx, surface);
  if (!window) return { error: "window_not_found" };
  const { reply } = await ctx.wire.send("look", {
    ...window,
    includeImage: true,
    readText: "never",
  });
  const result = isJsonObject(reply.result) ? reply.result : undefined;
  if (reply.ok !== true || !result || !isString(result.lookId) || !isJsonObject(result.outline))
    return { error: "look_failed:" + (errorCode(reply) ?? "invalid") };
  return { view: { lookId: result.lookId, outline: result.outline } };
}

async function lookFor(
  ctx: Context,
  surface: Surface,
  find: Finder,
): Promise<{ view: View; node: JsonObject } | Failed> {
  let last = "element_not_found";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const looked = await lookOnce(ctx, surface);
    if ("error" in looked) last = looked.error;
    else {
      const node = find(looked.view.outline);
      if (node && isString(node.ref)) return { view: looked.view, node };
      last = "element_not_found";
    }
    await pause(400);
  }
  return { error: last };
}

function actFields(cell: Cell, node: JsonObject): JsonObject | string {
  const ref = isString(node.ref) ? node.ref : undefined;
  const rect = rectOf(node.rect);
  if (!ref) return "no_ref";
  const center = rect ? { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } : undefined;
  switch (cell.action) {
    case "click_ref":
      return { action: "click", target: { ref }, params: {} };
    case "click_xy":
      return center ? { action: "click", target: center, params: {} } : "no_rect";
    case "set_text":
      return { action: "setText", target: { ref }, params: { text: TEXT_SET } };
    case "type_text":
      return { action: "typeText", target: { ref }, params: { text: TEXT_TYPE } };
    case "key":
      return { action: "keypress", target: { ref }, params: { keys: [KEY] } };
    case "chord":
      return { action: "keypress", target: { ref }, params: { keys: ["cmd", "a"] } };
    case "scroll_ref":
      return { action: "scroll", target: { ref }, params: { scrollX: 0, scrollY: 200 } };
    case "scroll_xy":
      return center
        ? { action: "scroll", target: center, params: { scrollX: 0, scrollY: 200 } }
        : "no_rect";
    case "drag": {
      if (!rect) return "no_rect";
      const y = rect.y + rect.h / 2;
      const from = rect.x + rect.w * 0.15;
      const to = rect.x + rect.w * 0.85;
      const path = [0, 1 / 3, 2 / 3, 1].map((step) => ({ x: from + (to - from) * step, y }));
      return { action: "drag", target: { x: from, y }, params: { path } };
    }
  }
}

async function holderFront(ctx: Context): Promise<boolean> {
  return (await frontApp())?.pid === ctx.holderPid;
}

async function ensureHolderFront(ctx: Context): Promise<string | null> {
  if (await holderFront(ctx)) return null;
  await ctx.fixtures.trigger(".cu-activate-holder");
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await pause(100);
    if (await holderFront(ctx)) return null;
  }
  if (ctx.target.fixtureTarget) {
    await ctx.fixtures.trigger(".cu-yield-target", String(ctx.holderPid) + " holder\n");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await pause(100);
      if (await holderFront(ctx)) return null;
    }
  }
  const front = await frontApp();
  return "holder_not_front:" + (front?.bundleId ?? "unknown") + ":" + String(front?.pid);
}

async function sendAct(
  ctx: Context,
  fields: JsonObject,
): Promise<{ reply: JsonObject | undefined; ms: number; error?: string }> {
  const started = performance.now();
  try {
    const { reply } = await ctx.wire.send(
      "act",
      { ...ctx.wire.actEnvelope(), ...fields },
      { timeoutMs: 20_000 },
    );
    return { reply, ms: performance.now() - started };
  } catch (error) {
    if (!(error instanceof WireError)) throw error;
    return { reply: undefined, ms: performance.now() - started, error: error.message };
  }
}

async function restoreHolder(ctx: Context, before: JsonObject): Promise<JsonObject> {
  const args: JsonObject = {
    session: { ...ctx.wire.session },
    foregroundGrant: true,
    expectedFrontmostPid: ctx.target.pid,
  };
  for (const key of ["pid", "windowTitle", "windowId", "windowRef"])
    if (before[key] !== undefined) args[key] = before[key];
  const restored = await ctx.wire.send("restoreUserFocus", args).catch(() => undefined);
  const result =
    restored && isJsonObject(restored.reply.result) ? restored.reply.result : undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await holderFront(ctx)) break;
    await pause(100);
  }
  return {
    restoreOk: restored?.reply.ok ?? null,
    restoreReason: result && isString(result.reason) ? result.reason : null,
    holderFrontAfter: await holderFront(ctx),
  };
}

function extendedStatus(reply: JsonObject | undefined): string | undefined {
  const result = reply && isJsonObject(reply.result) ? reply.result : undefined;
  const performed = result && isJsonObject(result.performed) ? result.performed : undefined;
  if (performed && isString(performed.extendedDelivery)) return performed.extendedDelivery;
  const error = reply && isJsonObject(reply.error) ? reply.error : undefined;
  return error && isString(error.extendedDelivery) ? error.extendedDelivery : undefined;
}

async function holderClick(ctx: Context): Promise<JsonObject> {
  const listed = await ctx.wire.send("listWindows", { pid: ctx.holderPid });
  const windows = Array.isArray(listed.reply.result) ? listed.reply.result : [];
  const window = windows.find(
    (entry) => isJsonObject(entry) && entry.title === fixtureApps.holder.title,
  );
  if (!isJsonObject(window)) return { error: "holder_window_not_found" };
  const looked = await ctx.wire.send("look", {
    windowId: window.windowId ?? null,
    includeImage: true,
    readText: "never",
  });
  const result = isJsonObject(looked.reply.result) ? looked.reply.result : undefined;
  if (!result || !isString(result.lookId)) return { error: "holder_look_failed" };
  const image = isJsonObject(result.image) ? result.image : {};
  const width = isNumber(image.width) ? image.width : 200;
  const height = isNumber(image.height) ? image.height : 100;
  const from = Date.now();
  const sent = await sendAct(ctx, {
    pid: ctx.holderPid,
    lookId: result.lookId,
    policy: "foreground",
    foregroundGrant: true,
    action: "click",
    target: { x: Math.round(width * 0.85), y: Math.round(height * 0.85) },
    params: {},
  });
  await pause(500);
  const rows = (await ctx.fixtures.rows("holder")).filter(
    (row) => isNumber(row.ts) && row.ts >= from,
  );
  return {
    ok: sent.reply?.ok ?? null,
    holderMouseDown: rows.filter((row) => row.event === "mouseDown").length,
    holderResignRows: rows.filter(
      (row) => row.event === "appInactive" || row.event === "windowResignKey",
    ).length,
    holderFrontAfter: await holderFront(ctx),
  };
}

async function afterCheck(
  ctx: Context,
  cell: Cell,
  surface: Surface,
  routes: Map<string, string>,
): Promise<JsonObject> {
  await pause(1_000);
  const out: JsonObject = { cell: cell.id };
  if (ctx.target.fixtureTarget)
    out.targetBelievesActiveIdle = believesActive(await ctx.target.rows());
  out.holderFrontIdle = await holderFront(ctx);
  out.holderClick = await holderClick(ctx);
  const rep = await runRep(ctx, cell, surface, "foreground", 0, routes);
  out.targetForeground = JSON.parse(
    JSON.stringify({
      skipped: rep.skipped,
      effect: rep.effect.effect,
      answer: rep.answer.answer,
      holder: rep.holder,
      notes: rep.notes,
    }),
  );
  if (ctx.target.fixtureTarget) {
    await pause(500);
    out.targetBelievesActiveEnd = believesActive(await ctx.target.rows());
  }
  return out;
}

function skippedRep(cell: Cell, mode: Mode, rep: number, reason: string): Rep {
  return {
    cell: cell.id,
    mode,
    rep,
    skipped: reason,
    answer: classifyAnswer(undefined),
    effect: { effect: false, count: 0, duplicate: null },
    holder: { appInactive: 0, windowResignKey: 0, keyDown: 0, mouseDown: 0, otherFrontmost: 0 },
    arrival: { mouseDown: 0, keyDown: 0, scrollWheel: 0, targetActivated: 0 },
    actMs: null,
    notes: {},
  };
}

async function runRep(
  ctx: Context,
  cell: Cell,
  surface: Surface,
  mode: Mode,
  rep: number,
  routes: Map<string, string>,
): Promise<Rep> {
  const notFront = await ensureHolderFront(ctx);
  if (notFront) return skippedRep(cell, mode, rep, notFront);
  if (!(await ctx.target.reset(cell.prefill))) return skippedRep(cell, mode, rep, "reset_timeout");
  const found = await lookFor(ctx, surface, cell.find);
  if ("error" in found) return skippedRep(cell, mode, rep, found.error);
  if (!routes.has(cell.id)) routes.set(cell.id, route(found.node));
  const fields = actFields(cell, found.node);
  if (isString(fields)) return skippedRep(cell, mode, rep, fields);
  if (!(await holderFront(ctx))) return skippedRep(cell, mode, rep, "holder_not_front_after_look");
  const policy: JsonObject =
    mode === "foreground"
      ? { policy: "foreground", foregroundGrant: true }
      : ctx.options.backgroundDelivery === "extended"
        ? { policy: "background", backgroundDelivery: "extended" }
        : { policy: "background" };
  let frontBefore: JsonObject = {};
  if (mode === "foreground") {
    const front = await ctx.wire.send("getFrontmost", {}).catch(() => undefined);
    frontBefore = front && isJsonObject(front.reply.result) ? front.reply.result : {};
  }
  const targetRowsBefore = ctx.target.fixtureTarget ? await ctx.target.rows() : [];
  const window: TimeWindow = { from: Date.now(), to: 0 };
  const sent = await sendAct(ctx, {
    pid: ctx.target.pid,
    lookId: found.view.lookId,
    ...policy,
    ...fields,
  });
  await pause(ctx.options.settleMs);
  window.to = Date.now();
  const notes: JsonObject = {};
  notes.window = { from: window.from, to: window.to };
  if (sent.error) notes.transportError = sent.error;
  if (ctx.target.fixtureTarget)
    notes.targetActivatedBefore = targetRowsBefore.some((row) => row.event === "appActive");
  const rows = await ctx.target.rows();
  const extended = extendedStatus(sent.reply);
  if (extended) notes.extendedDelivery = extended;
  if (ctx.target.fixtureTarget) {
    const inside = rows.filter(
      (row) => isNumber(row.ts) && row.ts >= window.from && row.ts <= window.to,
    );
    notes.targetFocusRows = inside
      .filter((row) =>
        ["appActive", "appInactive", "windowKey", "windowResignKey", "frontmost"].includes(
          String(row.event),
        ),
      )
      .map((row) => String(row.event) + ":" + String(row.window ?? row.bundleId ?? ""));
    notes.targetMouseWindows = inside
      .filter((row) => row.event === "targetMouseDown" || row.event === "targetKeyDown")
      .map((row) => String(row.event) + ":" + String(row.window ?? ""));
    notes.targetBelievesActive = believesActive(rows);
  }
  if (surface.web && ctx.target.fixtureTarget) {
    const dom = targetArrival(rows, window, true);
    notes.dom = { mouseDown: dom.mouseDown, keyDown: dom.keyDown, wheel: dom.scrollWheel };
  }
  const holderRows = await ctx.fixtures.rows("holder");
  if (mode === "foreground") Object.assign(notes, await restoreHolder(ctx, frontBefore));
  return {
    cell: cell.id,
    mode,
    rep,
    skipped: null,
    answer: classifyAnswer(sent.reply),
    effect: evaluateEffect(cell.effect, rows, window),
    holder: holderDisturbances(holderRows, ctx.holderPid, window),
    arrival: targetArrival(rows, window, !ctx.target.fixtureTarget),
    actMs: Math.round(sent.ms),
    notes,
  };
}

interface Run {
  options: Options;
  build: FixtureBuild;
  page: string;
  chromium: ChromiumApp | undefined;
  chromiumSkip: string | null;
  defects: string[];
  chromiumStops: {
    pid: number;
    pids: number[];
    crashpad: { pid: number; exitedOnItsOwn: boolean; terminated: boolean }[];
    leftovers: ChromiumLeftover[];
  }[];
  aborted: boolean;
  afterChecks: JsonObject[];
}

let cellSeq = 0;

async function newFixtures(run: Run, dir: string): Promise<FixtureSet> {
  await mkdir(dir, { recursive: true });
  const fixtures = new FixtureSet(join(dir, "fixture"), run.build);
  await fixtures.prepare();
  return fixtures;
}

const HOLDER_ENV = { CU_FIXTURE_OFFSET: "0,-400" };

interface Setup {
  ctx?: Context;
  fixtures: FixtureSet;
  server?: PageServer;
  instance?: ChromiumInstance;
  reason?: string;
}

async function fixtureContext(run: Run, dir: string, wire: Wire): Promise<Setup> {
  const fixtures = await newFixtures(run, dir);
  try {
    await fixtures.launch({
      label: "target",
      role: "target",
      env: { CU_FIXTURE_MATRIX: "1", CU_FIXTURE_WEB: "1", CU_FIXTURE_WEB_PAGE: run.page },
    });
    await fixtures.launch({ label: "holder", role: "holder", env: HOLDER_ENV });
  } catch (error) {
    return {
      fixtures,
      reason: "fixture_launch:" + (error instanceof Error ? error.message : String(error)),
    };
  }
  if (!(await fixtures.waitFor("target", (row) => row.event === "webReady", 10_000)))
    return { fixtures, reason: "web_not_ready" };
  await pause(900);
  const targetPid = fixtures.pid("target");
  const ctx: Context = {
    wire,
    fixtures,
    holderPid: fixtures.pid("holder"),
    options: run.options,
    windows: new Map(),
    target: {
      pid: targetPid,
      fixtureTarget: true,
      rows: () => fixtures.rows("target"),
      reset: async (text) => {
        cellSeq += 1;
        const seq = cellSeq;
        await fixtures.trigger(".cu-reset-target", JSON.stringify({ seq, text }) + "\n");
        return (
          (await fixtures.waitFor(
            "target",
            (row) => row.event === "resetDone" && row.seq === seq,
            5_000,
          )) !== undefined
        );
      },
    },
  };
  return { ctx, fixtures };
}

async function chromiumContext(run: Run, dir: string, wire: Wire): Promise<Setup> {
  const fixtures = await newFixtures(run, dir);
  if (!run.chromium) return { fixtures, reason: run.chromiumSkip ?? "no_chromium" };
  const server = new PageServer(join(dir, "chromium.jsonl"));
  const url = await server.start();
  const userDataDir = join(dir, "chromium-profile-" + String(Date.now()));
  await mkdir(userDataDir);
  const instance = await ChromiumInstance.launch(
    run.chromium,
    userDataDir,
    url,
    join(dir, "chromium.stderr"),
  );
  const setup: Setup = { fixtures, server, instance };
  const ready = await server.waitFor((row) => row.event === "webReady", 30_000);
  if (!ready || !instance.running())
    return { ...setup, reason: ready ? "chromium_exited" : "chromium_page_not_ready" };
  try {
    await fixtures.launch({ label: "holder", role: "holder", env: HOLDER_ENV });
  } catch (error) {
    return {
      ...setup,
      reason: "fixture_launch:" + (error instanceof Error ? error.message : String(error)),
    };
  }
  await pause(1_200);
  setup.ctx = {
    wire,
    fixtures,
    holderPid: fixtures.pid("holder"),
    options: run.options,
    windows: new Map(),
    target: {
      pid: instance.pid,
      fixtureTarget: false,
      rows: async () => [...server.rows],
      reset: async (text) => {
        const seq = server.requestReset(text);
        return (
          (await server.waitFor((row) => row.event === "resetDone" && row.seq === seq, 5_000)) !==
          undefined
        );
      },
    },
  };
  return setup;
}

async function claim(wire: Wire): Promise<string | null> {
  const claimed = await wire.send("claim", { session: { ...wire.session } }).catch(() => undefined);
  return claimed?.reply.ok === true
    ? null
    : "claim_failed:" + (claimed ? (errorCode(claimed.reply) ?? "refused") : "transport");
}

async function release(wire: Wire): Promise<void> {
  await wire
    .send("release", { session: { ...wire.session } }, { timeoutMs: 3_000 })
    .catch(() => undefined);
}

async function runCells(
  run: Run,
  ctx: Context,
  cells: Cell[],
  mode: Mode,
  reps: number,
  routes: Map<string, string>,
  all: Rep[],
  onRep: () => Promise<void>,
): Promise<void> {
  const surface = SURFACES.find((candidate) => candidate.id === cells[0]?.surface);
  if (!surface) return;
  for (const cell of cells) {
    for (let rep = 1; rep <= reps; rep += 1) {
      if (run.aborted) return;
      const result = await runRep(ctx, cell, surface, mode, rep, routes);
      all.push(result);
      console.log(
        "matrix " +
          mode +
          " " +
          cell.id +
          " #" +
          String(rep) +
          " " +
          (result.skipped
            ? "SKIPPED(" + result.skipped + ")"
            : result.answer.answer +
              " effect=" +
              String(result.effect.effect) +
              " act=" +
              String(result.actMs) +
              "ms"),
      );
      await onRep();
    }
    if (run.options.afterCheck && mode === "background" && !run.aborted)
      run.afterChecks.push(await afterCheck(ctx, cell, surface, routes));
  }
}

async function measureLooks(
  ctx: Context,
  surface: Surface,
  count: number,
  samples: LookSample[],
): Promise<void> {
  const window = await findWindow(ctx, surface);
  if (!window) return;
  const configs = [
    { config: "image, readText never", includeImage: true, readText: "never" },
    { config: "image, readText always", includeImage: true, readText: "always" },
    { config: "no image", includeImage: false, readText: "never" },
  ];
  for (const config of configs) {
    for (let index = 0; index < count; index += 1) {
      const started = performance.now();
      const sent = await ctx.wire
        .send("look", { ...window, includeImage: config.includeImage, readText: config.readText })
        .catch(() => undefined);
      const wallMs = performance.now() - started;
      const reply = sent?.reply;
      const result = reply && isJsonObject(reply.result) ? reply.result : undefined;
      const timings = result && isJsonObject(result.timings) ? result.timings : {};
      const num = (value: JsonValue | undefined): number | null => (isNumber(value) ? value : null);
      samples.push({
        surface: surface.id,
        config: config.config,
        ok: reply?.ok === true,
        captureMs: num(timings.captureMs),
        describeMs: num(timings.describeMs),
        readTextMs: num(timings.readTextMs),
        nodeCount: result ? countNodes(result.outline) : null,
        wallMs: Math.round(wallMs),
        replyBytes: reply ? Buffer.byteLength(JSON.stringify(reply)) : 0,
      });
    }
  }
}

function tables(cells: Cell[], reps: Rep[], routes: Map<string, string>): CellTable[] {
  return cells.map((cell) => {
    const info: CellInfo = {
      id: cell.id,
      surface: cell.surface,
      element: cell.element,
      action: cell.action,
      effect: cell.effectText,
      route: routes.get(cell.id) ?? "-",
    };
    const mine = reps.filter((rep) => rep.cell === cell.id);
    return {
      info,
      background: summarize(mine.filter((rep) => rep.mode === "background")),
      foreground: summarize(mine.filter((rep) => rep.mode === "foreground")),
    };
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function reactivate(front: FrontApp | undefined): Promise<string> {
  const bundleId = front?.bundleId;
  if (!bundleId) return "skipped: no recorded frontmost app";
  if (bundleId === fixtureApps.target.bundleId || bundleId === fixtureApps.holder.bundleId)
    return "skipped: frontmost before the run was a fixture";
  const found = await command("lsappinfo", ["find", "bundleid=" + bundleId]);
  if (!found.stdout.trim()) return "skipped: " + bundleId + " no longer running";
  const opened = await command("open", ["-b", bundleId]);
  return opened.code === 0
    ? "reactivated " + bundleId
    : "open -b " + bundleId + " failed: " + opened.stderr.trim();
}

function markdown(
  meta: JsonObject,
  cellTables: CellTable[],
  latency: string,
  options: Options,
  afterState: string,
): string {
  const cellsSection = cellTables
    .map((table) => "- " + table.info.id + ": effect = " + table.info.effect)
    .join("\n");
  return [
    "# Computer-use delivery matrix",
    "",
    "Measured " +
      String(meta.startedAt) +
      " on " +
      String(meta.macOS) +
      ", revision " +
      String(meta.revision) +
      ", helper protocol " +
      String(meta.protocolVersion) +
      ".",
    "Background: N = " +
      String(options.reps) +
      " per cell (policy background, no grant). Foreground reference: N = " +
      String(options.fgReps) +
      " per cell (policy foreground with grant, HID delivery). Settle after each act: " +
      String(options.settleMs) +
      " ms." +
      (options.backgroundDelivery === "extended"
        ? ' Background delivery: extended (every background act carries backgroundDelivery: "extended").'
        : ""),
    "Effects are what the fixture (or the Chromium page through the harness server) recorded; answers are the helper's reply. No cell has a verdict.",
    "",
    "Columns: bg effect = repetitions with the intended effect / measured repetitions; answers: R:<code> = refused with that code; false worked = answered worked without the effect; refused w/ effect and didnt w/ effect = answered no-effect although the effect was recorded; dup = repetitions where the effect happened more than once (n/o = not observable for this effect); bg input reached app = repetitions in which the target process (Chromium: the page DOM) saw any mouse/key/scroll event; holder disturbance = repetitions with any holder appInactive, windowResignKey, keyDown, mouseDown, or another app becoming frontmost, with totals. Route = element role and accessibility actions from the look.",
    "",
    renderCellTable(cellTables),
    "",
    ...(afterState ? [afterState, ""] : []),
    "## Observation latency (look), median / p95",
    "",
    "Wall ms is the harness round trip (one socket connection per request, like the wire layer); the other columns are the helper's own timings. Nodes = outline node count; reply bytes = JSON reply size.",
    "",
    latency,
    "",
    "## Effects per cell",
    "",
    cellsSection,
    "",
  ].join("\n");
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    console.error("ARGUMENT " + (error instanceof Error ? error.message : String(error)));
    return 2;
  }
  if (isMainHelper(options.helperApp, options.helperSocket)) {
    console.error("HELPER_IS_MAIN the matrix must not use the main helper app or socket");
    return 2;
  }
  if (process.platform !== "darwin" || arch() !== "arm64") {
    console.error("ARCH_UNSUPPORTED " + process.platform + "/" + arch());
    return 2;
  }
  const jsonPath = join(options.out, "matrix.json");
  if (await exists(jsonPath)) {
    console.error("OUT_NOT_FRESH " + jsonPath + " exists; choose a new --out");
    return 2;
  }
  if (!(await socketBusy(options.helperSocket))) {
    console.error("HELPER_SOCKET no daemon listening at " + options.helperSocket);
    return 2;
  }
  await mkdir(options.out, { recursive: true });
  const startedAt = new Date().toISOString();
  const frontBefore = await frontApp();
  const build = await buildFixture(join(options.out, "fixture-build"));
  const page = join(options.out, "matrix-page.html");
  await writeFile(page, matrixPage("CU Matrix Web"));
  const chromium =
    options.chromium && options.surfaces.includes("chromium") ? await findChromium() : undefined;
  const run: Run = {
    options,
    build,
    page,
    chromium,
    chromiumSkip: !options.surfaces.includes("chromium")
      ? "not selected"
      : !options.chromium
        ? "--no-chromium"
        : chromium
          ? null
          : "no Chromium-based browser in /Applications",
    defects: [],
    chromiumStops: [],
    aborted: false,
    afterChecks: [],
  };
  process.once("SIGINT", () => {
    run.aborted = true;
  });
  const helperLog = new MatrixLog(join(options.out, "helper-check.jsonl"));
  const checked = await checkHelper(
    options.helperSocket,
    await realpath(options.helperApp),
    helperLog,
  );
  if (checked.blocked) {
    console.error("BLOCKED " + checked.blocked);
    await writeFile(
      jsonPath,
      JSON.stringify(
        { status: "BLOCKED(" + checked.blocked + ")", diagnostics: checked.diagnostics ?? null },
        null,
        2,
      ) + "\n",
    );
    return 1;
  }
  const revision = (await command("git", ["rev-parse", "--short=8", "HEAD"])).stdout.trim();
  const diagnostics = checked.diagnostics ?? {};
  const meta: JsonObject = {
    startedAt,
    revision,
    macOS: diagnostics.macOS ?? null,
    protocolVersion: diagnostics.protocolVersion ?? null,
  };
  const selected = CELLS.filter(
    (cell) =>
      options.surfaces.includes(cell.surface) &&
      (!options.cells || options.cells.some((part) => cell.id.includes(part))),
  );
  const reps: Rep[] = [];
  const looks: LookSample[] = [];
  const routes = new Map<string, string>();
  const setups: JsonObject[] = [];
  let status = "complete";
  const write = async (final: boolean): Promise<void> => {
    const afterStateSection = (): string => {
      if (options.backgroundDelivery !== "extended" && !options.afterCheck) return "";
      const lines = [
        "## Target after-state (background repetitions)",
        "",
        "Extended used = repetitions whose reply said performed.extendedDelivery used; activated = the target logged appActive during the act window; left active = the target's last appActive/appInactive row was appActive when the repetition was scored (n/o: no fixture log, Chromium).",
        "",
        renderAfterStateTable(
          summarizeAfterState(
            selected.map((cell) => cell.id),
            reps,
          ),
        ),
      ];
      if (run.afterChecks.length > 0) {
        const flag = (value: JsonValue | undefined): string =>
          value === true ? "yes" : value === false ? "no" : "-";
        lines.push(
          "",
          "After-check per cell (1 s after the last background repetition): idle target active, holder frontmost, a granted click on the holder (holder mouseDown rows), one granted act on the target (effect), target active at the end.",
          "",
          "| cell | idle target active | holder front | holder click mouseDown | granted act effect | target active at end |",
          "| --- | --- | --- | --- | --- | --- |",
          ...run.afterChecks.map((check) => {
            const click = isJsonObject(check.holderClick) ? check.holderClick : {};
            const act = isJsonObject(check.targetForeground) ? check.targetForeground : {};
            return (
              "| " +
              [
                String(check.cell),
                flag(check.targetBelievesActiveIdle),
                flag(check.holderFrontIdle),
                String(click.holderMouseDown ?? click.error ?? "-"),
                act.skipped ? "skipped" : flag(act.effect),
                flag(check.targetBelievesActiveEnd),
              ].join(" | ") +
              " |"
            );
          }),
        );
      }
      return lines.join("\n");
    };
    const cellTables = tables(selected, reps, routes);
    const latency = summarizeLooks(looks);
    const document: JsonObject = JSON.parse(
      JSON.stringify({
        status: final ? status : "running",
        ...meta,
        finishedAt: final ? new Date().toISOString() : null,
        helper: { app: options.helperApp, socket: options.helperSocket, diagnostics },
        fixture: { hash: build.hash, dir: build.dir },
        chromium: chromium
          ? { ...chromium, skipped: run.chromiumSkip }
          : { skipped: run.chromiumSkip },
        options,
        frontBefore: frontBefore ?? null,
        setups,
        cells: cellTables,
        latency,
        reps,
        looks,
        defects: run.defects,
        chromiumStops: run.chromiumStops,
        afterChecks: run.afterChecks,
      }),
    );
    await writeFile(jsonPath, JSON.stringify(document, null, 2) + "\n");
    await writeFile(
      join(options.out, "matrix.md"),
      markdown(meta, cellTables, renderLatencyTable(latency), options, afterStateSection()),
    );
  };
  const open: Setup[] = [];
  try {
    const phases: { mode: Mode; reps: number }[] = [{ mode: "background", reps: options.reps }];
    if (options.fgReps > 0) phases.push({ mode: "foreground", reps: options.fgReps });
    if (options.latency && options.looks > 0) {
      for (const surface of SURFACES.filter((candidate) =>
        options.surfaces.includes(candidate.id),
      )) {
        if (run.aborted) break;
        const dir = join(options.out, "latency", surface.id);
        const wire = new Wire(options.helperSocket, new MatrixLog(join(dir, "requests.jsonl")));
        await mkdir(dir, { recursive: true });
        const setup =
          surface.id === "chromium"
            ? await chromiumContext(run, dir, wire)
            : await fixtureContext(run, dir, wire);
        open.push(setup);
        setups.push({ phase: "latency", surface: surface.id, reason: setup.reason ?? null });
        if (setup.ctx && !setup.reason) {
          const blocked = await claim(wire);
          if (!blocked) await measureLooks(setup.ctx, surface, options.looks, looks);
          else setups.push({ phase: "latency", surface: surface.id, reason: blocked });
          await release(wire);
        }
        await closeSetup(run, setup);
        console.log("matrix latency " + surface.id + " " + (setup.reason ?? "measured"));
        await write(false);
      }
    }
    for (const phase of phases) {
      for (const surface of SURFACES.filter((candidate) =>
        options.surfaces.includes(candidate.id),
      )) {
        const cells = selected.filter((cell) => cell.surface === surface.id);
        if (cells.length === 0 || run.aborted) continue;
        if (surface.id === "chromium") {
          const dir = join(options.out, phase.mode, "chromium");
          const wire = new Wire(options.helperSocket, new MatrixLog(join(dir, "requests.jsonl")));
          await mkdir(dir, { recursive: true });
          const setup = await chromiumContext(run, dir, wire);
          open.push(setup);
          setups.push({
            phase: phase.mode,
            surface: surface.id,
            reason: setup.reason ?? null,
            pid: setup.instance?.pid ?? null,
            userDataDir: setup.instance?.userDataDir ?? null,
          });
          if (setup.ctx && !setup.reason) {
            const blocked = await claim(wire);
            if (blocked) setups.push({ phase: phase.mode, surface: surface.id, reason: blocked });
            else
              await runCells(run, setup.ctx, cells, phase.mode, phase.reps, routes, reps, () =>
                write(false),
              );
            await release(wire);
          } else
            for (const cell of cells)
              for (let rep = 1; rep <= phase.reps; rep += 1)
                reps.push(
                  skippedRep(cell, phase.mode, rep, "setup:" + (setup.reason ?? "unknown")),
                );
          await closeSetup(run, setup);
          continue;
        }
        for (const cell of cells) {
          if (run.aborted) break;
          const dir = join(options.out, phase.mode, cell.id);
          const wire = new Wire(options.helperSocket, new MatrixLog(join(dir, "requests.jsonl")));
          await mkdir(dir, { recursive: true });
          const setup = await fixtureContext(run, dir, wire);
          open.push(setup);
          if (setup.reason) setups.push({ phase: phase.mode, cell: cell.id, reason: setup.reason });
          if (setup.ctx && !setup.reason) {
            const blocked = await claim(wire);
            if (blocked) setups.push({ phase: phase.mode, cell: cell.id, reason: blocked });
            else
              await runCells(run, setup.ctx, [cell], phase.mode, phase.reps, routes, reps, () =>
                write(false),
              );
            await release(wire);
          } else
            for (let rep = 1; rep <= phase.reps; rep += 1)
              reps.push(skippedRep(cell, phase.mode, rep, "setup:" + (setup.reason ?? "unknown")));
          await closeSetup(run, setup);
        }
      }
    }
    if (run.aborted) status = "ABORTED(SIGINT)";
  } catch (error) {
    status = "ABORTED(" + (error instanceof Error ? error.message : String(error)) + ")";
  } finally {
    for (const setup of open) await closeSetup(run, setup);
    const swept = await sweepFixtureProcesses(build);
    if (swept.length > 0) run.defects.push("swept fixture pids " + swept.join(","));
    await unregisterFixture(build).catch(() => undefined);
    meta.frontRestore = await reactivate(frontBefore).catch(
      (error: Error) => "failed: " + error.message,
    );
    await write(true);
  }
  console.log("matrix " + status + " " + jsonPath);
  return status === "complete" ? 0 : 1;
}

const closed = new WeakSet<object>();

async function closeSetup(run: Run, setup: Setup): Promise<void> {
  if (closed.has(setup)) return;
  closed.add(setup);
  run.defects.push(...(await setup.fixtures.quitAll()));
  if (setup.instance) {
    const stopped = await setup.instance.stop();
    run.defects.push(...stopped.defects);
    run.chromiumStops.push({
      pid: setup.instance.pid,
      pids: stopped.pids,
      crashpad: stopped.crashpad,
      leftovers: stopped.leftovers,
    });
    for (const left of stopped.leftovers)
      console.log(
        "chromium leftover (not signalled): pid " +
          String(left.pid) +
          " " +
          left.executable +
          " (" +
          left.reason +
          ")",
      );
  }
  await setup.server?.stop();
}

process.exit(await main());
