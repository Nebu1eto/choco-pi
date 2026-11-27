import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { arch } from "node:os";
import { join, resolve } from "node:path";
import { isJsonObject, isNumber, isString, type JsonObject } from "../../src/json.ts";
import { unregisterFixture } from "../desktop.ts";
import { buildFixture } from "../fixture/build.ts";
import { socketBusy } from "../preflight.ts";
import {
  centre,
  distance,
  inside,
  parseCursorState,
  parseOwnerWindows,
  parseScreens,
  pointOf,
  rectJson,
  rectOf,
  sameRect,
  scoreCursorState,
  scoreOverlayBounds,
  type Check,
  type CursorState,
  type Point,
  type Rect,
  type Screen,
} from "./displays-score.ts";
import { FixtureSet, frontApp, sweepFixtureProcesses, type FrontApp } from "./fixtures.ts";
import { checkHelper } from "./scenarios.ts";
import { isMainHelper } from "./score.ts";
import { RequestLog, Wire, WireError } from "./wire.ts";

interface Options {
  helperApp: string;
  helperSocket: string;
  out: string;
  displays?: number[];
  minDisplays: number;
  overlayOnly: boolean;
}

class ArgumentError extends Error {}

class FrontChanged extends Error {}

class ListOnly extends Error {}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const MAIN_TITLE = "CU Fixture Target";
const APPKIT_TITLE = "CU Matrix AppKit";
const EXTENDED = { policy: "background", backgroundDelivery: "extended" };
const STANDARD = { policy: "background" };
const TYPED = "display-probe";

function parse(argv: string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const helperApp = value("--helper-app");
  const helperSocket = value("--helper-socket");
  const out = value("--out");
  if (!helperApp || !helperSocket || !out)
    throw new ArgumentError(
      "usage: displays.ts --helper-app <app> --helper-socket <socket> --out <dir> [--displays <id,id>] [--min-displays <n>] [--overlay-only]",
    );
  const listed = value("--displays");
  const displays = listed?.split(",").map((id) => Number(id.trim()));
  if (displays?.some((id) => !Number.isSafeInteger(id)))
    throw new ArgumentError("--displays takes comma-separated display ids");
  const minDisplays = Number(value("--min-displays") ?? "2");
  if (!Number.isSafeInteger(minDisplays) || minDisplays < 1)
    throw new ArgumentError("--min-displays takes a positive integer");
  return {
    helperApp: resolve(helperApp),
    helperSocket: resolve(helperSocket),
    out: resolve(out),
    displays,
    minDisplays,
    overlayOnly: argv.includes("--overlay-only"),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface Look {
  lookId: string;
  outline: JsonObject;
  frame: Rect;
  scaleFactor: number;
  imageWidth: number;
  imageHeight: number;
}

function findNode(node: JsonObject, identifier: string): JsonObject | undefined {
  if (node.identifier === identifier) return node;
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (!isJsonObject(child)) continue;
    const found = findNode(child, identifier);
    if (found) return found;
  }
  return undefined;
}

function globalRect(view: Look, rect: Rect): Rect {
  const scale = view.frame.w / view.imageWidth;
  return {
    x: view.frame.x + rect.x * scale,
    y: view.frame.y + rect.y * scale,
    w: rect.w * scale,
    h: rect.h * scale,
  };
}

function pointJson(point: Point): JsonObject {
  return { x: point.x, y: point.y };
}

function imagePoint(view: Look, point: Point): Point {
  return {
    x: ((point.x - view.frame.x) / view.frame.w) * view.imageWidth,
    y: ((point.y - view.frame.y) / view.frame.h) * view.imageHeight,
  };
}

interface Layout {
  windows: { window: string; frame: Rect; onActiveSpace: boolean; screen: number }[];
  views: Record<string, Rect>;
}

function parseLayout(row: JsonObject): Layout {
  const windows: Layout["windows"] = [];
  for (const entry of Array.isArray(row.windows) ? row.windows : []) {
    if (!isJsonObject(entry) || !isString(entry.window)) continue;
    const frame = rectOf(entry.frame);
    if (!frame) continue;
    windows.push({
      window: entry.window,
      frame,
      onActiveSpace: entry.onActiveSpace === true,
      screen: isNumber(entry.screen) ? entry.screen : 0,
    });
  }
  const views: Record<string, Rect> = {};
  if (isJsonObject(row.views))
    for (const [name, value] of Object.entries(row.views)) {
      const rect = rectOf(value);
      if (rect) views[name] = rect;
    }
  return { windows, views };
}

class Run {
  readonly wire: Wire;
  readonly fixtures: FixtureSet;
  readonly frontBefore: FrontApp | undefined;
  readonly helperPid: number;
  readonly screens: Screen[];
  cursorStateSupported: boolean | null = null;
  private ownerSeq = 0;

  constructor(
    wire: Wire,
    fixtures: FixtureSet,
    frontBefore: FrontApp | undefined,
    helperPid: number,
    screens: Screen[],
  ) {
    this.wire = wire;
    this.fixtures = fixtures;
    this.frontBefore = frontBefore;
    this.helperPid = helperPid;
    this.screens = screens;
  }

  async guardFront(when: string): Promise<void> {
    const front = await frontApp();
    if (front?.pid !== this.frontBefore?.pid)
      throw new FrontChanged(
        `frontmost app changed ${when}: pid ${String(this.frontBefore?.pid)} -> ${String(front?.pid)} (${front?.bundleId ?? "unknown"})`,
      );
  }

  async layout(label: string): Promise<Layout | undefined> {
    const rows = await this.fixtures.rows(label);
    const row = rows.filter((entry) => entry.event === "layout").at(-1);
    return row ? parseLayout(row) : undefined;
  }

  async look(pid: number, title: string): Promise<Look> {
    const listed = await this.wire.send("listWindows", { pid });
    const windows = Array.isArray(listed.reply.result) ? listed.reply.result : [];
    const window = windows.find((entry) => isJsonObject(entry) && entry.title === title);
    if (!isJsonObject(window)) throw new Error(`window not found: ${title}`);
    const args: JsonObject = { includeImage: true, readText: "never" };
    if (isNumber(window.windowId)) args.windowId = window.windowId;
    if (isString(window.windowRef)) args.windowRef = window.windowRef;
    const { reply } = await this.wire.send("look", args);
    const result = isJsonObject(reply.result) ? reply.result : undefined;
    const win = result && isJsonObject(result.window) ? result.window : undefined;
    const image = result && isJsonObject(result.image) ? result.image : undefined;
    const frame = win ? rectOf(win.framePoints) : undefined;
    if (
      reply.ok !== true ||
      !result ||
      !isString(result.lookId) ||
      !isJsonObject(result.outline) ||
      !frame ||
      !win ||
      !isNumber(win.scaleFactor) ||
      !image ||
      !isNumber(image.width) ||
      !isNumber(image.height)
    )
      throw new Error(`look ${title}: ${JSON.stringify(reply.error ?? "invalid reply")}`);
    return {
      lookId: result.lookId,
      outline: result.outline,
      frame,
      scaleFactor: win.scaleFactor,
      imageWidth: image.width,
      imageHeight: image.height,
    };
  }

  async act(fields: JsonObject): Promise<JsonObject> {
    try {
      const { reply } = await this.wire.send(
        "act",
        { ...this.wire.actEnvelope(), ...fields },
        { timeoutMs: 20_000 },
      );
      return reply;
    } catch (error) {
      if (error instanceof WireError) return { ok: false, transportError: error.message };
      throw error;
    }
  }

  async ownerWindows(label: string): Promise<JsonObject | undefined> {
    const seq = ++this.ownerSeq;
    await this.fixtures.trigger(`.cu-owner-windows-${label}`, `${this.helperPid} ${seq}\n`);
    return await this.fixtures.waitFor(
      label,
      (row) => row.event === "ownerWindows" && row.seq === seq,
      3_000,
    );
  }

  async cursorChecks(label: string, expected: Screen, acted: Point): Promise<Check[]> {
    let state: CursorState | undefined;
    if (this.cursorStateSupported !== false) {
      const until = Date.now() + 6_000;
      for (;;) {
        const { reply } = await this.wire.send("agentCursorState", {});
        const code = isJsonObject(reply.error) ? reply.error.code : undefined;
        if (code === "unknown_command") {
          this.cursorStateSupported = false;
          break;
        }
        this.cursorStateSupported = true;
        const current = parseCursorState(reply.result);
        const settled =
          current?.animating === false &&
          current.target !== undefined &&
          distance(current.target, acted) <= 0.5;
        if (settled || Date.now() >= until) break;
        await pause(150);
      }
      if (this.cursorStateSupported) {
        await pause(150);
        const { reply } = await this.wire.send("agentCursorState", { capture: true });
        state = parseCursorState(reply.result);
      }
    }
    if (this.cursorStateSupported === false) await pause(2_000);
    const checks = scoreCursorState(state, expected, acted);
    const row = await this.ownerWindows(label);
    checks.unshift(
      row
        ? scoreOverlayBounds(parseOwnerWindows(row.windows), expected, this.screens)
        : { name: "overlay_window_bounds", ok: null, detail: { reason: "fixture did not report" } },
    );
    return checks;
  }

  async rowAfter(
    label: string,
    since: number,
    match: (row: JsonObject) => boolean,
    ms = 3_000,
  ): Promise<JsonObject | undefined> {
    return await this.fixtures.waitFor(
      label,
      (row) => isNumber(row.ts) && row.ts >= since && match(row),
      ms,
    );
  }
}

function replyCheck(name: string, reply: JsonObject): Check {
  const result = isJsonObject(reply.result) ? reply.result : undefined;
  const outcome = result && isString(result.outcome) ? result.outcome : null;
  return {
    name,
    ok: reply.ok === true && outcome !== "didnt",
    detail: {
      ok: reply.ok ?? null,
      outcome,
      error: reply.error ?? null,
      extendedDelivery:
        result && isJsonObject(result.performed)
          ? (result.performed.extendedDelivery ?? null)
          : null,
      transportError: reply.transportError ?? null,
    },
  };
}

function pointCheck(name: string, row: JsonObject | undefined, expected: Point): Check {
  const at = row ? pointOf(row.at) : undefined;
  return {
    name,
    ok: at !== undefined && distance(at, expected) <= 2,
    detail: { at: at ? { ...at } : null, expected: { ...expected }, row: row ?? null },
  };
}

async function checkDisplay(
  run: Run,
  screen: Screen,
  label: string,
  overlayOnly: boolean,
): Promise<Check[]> {
  const checks: Check[] = [];
  const pid = run.fixtures.pid(label);
  const layout = await run.layout(label);
  const views = layout?.views ?? {};
  const fixtureMain = layout?.windows.find((window) => window.window === "main");
  const main = await run.look(pid, MAIN_TITLE);
  checks.push({
    name: "look_frame_on_display",
    ok: inside(main.frame, screen.bounds),
    detail: { frame: rectJson(main.frame), display: rectJson(screen.bounds) },
  });
  checks.push({
    name: "look_frame_matches_fixture",
    ok: fixtureMain !== undefined && sameRect(main.frame, fixtureMain.frame, 2),
    detail: {
      look: rectJson(main.frame),
      fixture: fixtureMain ? rectJson(fixtureMain.frame) : null,
    },
  });
  const expectedWidth = Math.round(main.frame.w * screen.backingScale);
  checks.push({
    name: "screenshot_scale",
    ok:
      Math.abs(main.scaleFactor - screen.backingScale) <= 0.01 &&
      Math.abs(main.imageWidth - expectedWidth) <= 1,
    detail: {
      scaleFactor: main.scaleFactor,
      backingScale: screen.backingScale,
      imageWidth: main.imageWidth,
      imageHeight: main.imageHeight,
      expectedWidth,
    },
  });
  const elementCheck = (name: string, view: Look, identifier: string, fixture?: Rect): Check => {
    const node = findNode(view.outline, identifier);
    const rect = node ? rectOf(node.rect) : undefined;
    const global = rect ? globalRect(view, rect) : undefined;
    return {
      name,
      ok:
        global !== undefined &&
        fixture !== undefined &&
        sameRect(global, fixture, 2) &&
        inside(global, screen.bounds),
      detail: {
        look: global ? rectJson(global) : null,
        fixture: fixture ? rectJson(fixture) : null,
      },
    };
  };
  checks.push(elementCheck("element_frame_custom_view", main, "cu-custom-view", views.customView));
  checks.push(elementCheck("element_frame_field", main, "cu-field", views.field));

  const custom = views.customView;
  if (custom) {
    const acted = centre(custom);
    const since = Date.now();
    const reply = await run.act({
      pid,
      lookId: main.lookId,
      ...EXTENDED,
      action: "click",
      target: pointJson(imagePoint(main, acted)),
      params: {},
    });
    checks.push(replyCheck("click_xy_reply", reply));
    const hit = await run.rowAfter(label, since, (row) => row.event === "customHit");
    checks.push(pointCheck("click_xy_effect", hit, acted));
    await run.guardFront("after click_xy");
    for (const check of await run.cursorChecks(label, screen, acted))
      checks.push({ ...check, name: `click_xy_${check.name}` });
  }
  if (overlayOnly) return checks;

  const increment = findNode(main.outline, "cu-increment");
  if (increment && isString(increment.ref)) {
    const since = Date.now();
    const reply = await run.act({
      pid,
      lookId: main.lookId,
      ...STANDARD,
      action: "press",
      target: { ref: increment.ref },
      params: {},
    });
    checks.push(replyCheck("ax_press_reply", reply));
    const row = await run.rowAfter(label, since, (entry) => entry.event === "increment");
    checks.push({ name: "ax_press_effect", ok: row !== undefined, detail: { row: row ?? null } });
    await run.guardFront("after AX press");
  }
  const field = findNode(main.outline, "cu-field");
  if (field && isString(field.ref)) {
    const since = Date.now();
    const reply = await run.act({
      pid,
      lookId: main.lookId,
      ...STANDARD,
      action: "typeText",
      target: { ref: field.ref },
      params: { text: TYPED },
    });
    checks.push(replyCheck("type_text_reply", reply));
    const row = await run.rowAfter(
      label,
      since,
      (entry) => entry.event === "fieldValue" && entry.length === TYPED.length,
      5_000,
    );
    checks.push({
      name: "type_text_effect",
      ok: row !== undefined,
      detail: { row: row ?? null, valueMatches: row?.value === TYPED },
    });
    await run.guardFront("after typing");
  }

  const since = Date.now();
  await run.fixtures.trigger(`.cu-front-${label}`, "appkit\n");
  await run.rowAfter(label, since, (row) => row.event === "orderedFront");
  await pause(200);
  await run.guardFront("after ordering the AppKit window front");
  const appkit = await run.look(pid, APPKIT_TITLE);
  checks.push(elementCheck("element_frame_scroll_view", appkit, "cu-scroll", views.scrollView));
  checks.push(elementCheck("element_frame_drag_view", appkit, "cu-drag", views.dragView));
  const scroll = views.scrollView;
  if (scroll) {
    const acted = centre(scroll);
    const since = Date.now();
    const reply = await run.act({
      pid,
      lookId: appkit.lookId,
      ...EXTENDED,
      action: "scroll",
      target: pointJson(imagePoint(appkit, acted)),
      params: { scrollX: 0, scrollY: 200 },
    });
    checks.push(replyCheck("scroll_xy_reply", reply));
    const moved = await run.rowAfter(
      label,
      since,
      (row) => row.event === "scrollPosition" && row.y !== 500,
    );
    checks.push({
      name: "scroll_xy_effect",
      ok: moved !== undefined,
      detail: { row: moved ?? null },
    });
    const wheel = await run.rowAfter(label, since, (row) => row.event === "targetScrollWheel", 500);
    checks.push(pointCheck("scroll_xy_location", wheel, acted));
    await run.guardFront("after scroll_xy");
    for (const check of await run.cursorChecks(label, screen, acted))
      checks.push({ ...check, name: `scroll_xy_${check.name}` });
  }
  const drag = views.dragView;
  if (drag) {
    const y = drag.y + drag.h / 2;
    const from = { x: drag.x + drag.w * 0.15, y };
    const to = { x: drag.x + drag.w * 0.85, y };
    const path = [0, 1 / 3, 2 / 3, 1].map((step) =>
      pointJson(imagePoint(appkit, { x: from.x + (to.x - from.x) * step, y })),
    );
    const since = Date.now();
    const reply = await run.act({
      pid,
      lookId: appkit.lookId,
      ...EXTENDED,
      action: "drag",
      target: pointJson(imagePoint(appkit, from)),
      params: { path },
    });
    checks.push(replyCheck("drag_reply", reply));
    const up = await run.rowAfter(label, since, (row) => row.event === "dragUp");
    const down = await run.rowAfter(label, since, (row) => row.event === "dragDown", 500);
    checks.push({
      name: "drag_effect",
      ok: up?.startRegion === "A" && up.endRegion === "B",
      detail: { row: up ?? null },
    });
    checks.push(pointCheck("drag_start_location", down, from));
    checks.push(pointCheck("drag_end_location", up, to));
    await run.guardFront("after drag");
    for (const check of await run.cursorChecks(label, screen, from))
      checks.push({ ...check, name: `drag_${check.name}` });
  }
  return checks;
}

async function checkFollow(
  run: Run,
  displays: { screen: Screen; label: string }[],
): Promise<Check[]> {
  const checks: Check[] = [];
  const order = [...displays, displays[0]];
  for (const [index, { screen, label }] of order.entries()) {
    const pid = run.fixtures.pid(label);
    const layout = await run.layout(label);
    const custom = layout?.views.customView;
    if (!custom) {
      checks.push({ name: `follow_${index}`, ok: null, detail: { reason: "no custom view" } });
      continue;
    }
    const view = await run.look(pid, MAIN_TITLE);
    const acted = centre(custom);
    const reply = await run.act({
      pid,
      lookId: view.lookId,
      ...EXTENDED,
      action: "click",
      target: pointJson(imagePoint(view, acted)),
      params: {},
    });
    checks.push(replyCheck(`follow_${index}_d${screen.id}_reply`, reply));
    await run.guardFront("during the follow check");
    for (const check of await run.cursorChecks(label, screen, acted))
      checks.push({ ...check, name: `follow_${index}_d${screen.id}_${check.name}` });
  }
  return checks;
}

function verdictOf(checks: Check[]): "PASS" | "FAIL" {
  return checks.some((check) => check.ok === false) ? "FAIL" : "PASS";
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    console.error(`ARGUMENT ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (isMainHelper(options.helperApp, options.helperSocket)) {
    console.error("HELPER_IS_MAIN the display check must not use the main helper app or socket");
    return 2;
  }
  if (process.platform !== "darwin" || arch() !== "arm64") {
    console.error(`ARCH_UNSUPPORTED ${process.platform}/${arch()}`);
    return 2;
  }
  const summaryPath = join(options.out, "summary.json");
  if (await exists(summaryPath)) {
    console.error(`OUT_NOT_FRESH ${summaryPath} exists; choose a new --out`);
    return 2;
  }
  if (!(await socketBusy(options.helperSocket))) {
    console.error(`HELPER_SOCKET no daemon listening at ${options.helperSocket}`);
    return 2;
  }
  await mkdir(options.out, { recursive: true });
  const helperAppReal = await realpath(options.helperApp);
  const log = new RequestLog(join(options.out, "requests.jsonl"));
  const wire = new Wire(options.helperSocket, log);
  const frontBefore = await frontApp();
  const build = await buildFixture(join(options.out, "fixture-build"));
  const fixtures = new FixtureSet(join(options.out, "fixture"), build);
  await fixtures.prepare();
  const summary: JsonObject = {
    startedAt: new Date().toISOString(),
    helper: { app: options.helperApp, socket: options.helperSocket },
    fixture: { hash: build.hash, dir: build.dir, logs: fixtures.dir },
    frontBefore: frontBefore
      ? { pid: frontBefore.pid ?? null, bundleId: frontBefore.bundleId ?? null }
      : null,
  };
  let status = "complete";
  let verdict = "FAIL";
  const displayResults: JsonObject[] = [];
  let claimed = false;
  try {
    const checked = await checkHelper(options.helperSocket, helperAppReal, log);
    summary.diagnostics = checked.diagnostics ?? null;
    const helperPid = checked.diagnostics?.pid;
    if (checked.blocked || !isNumber(helperPid))
      throw new Error(`BLOCKED(${checked.blocked ?? "no helper pid"})`);
    await fixtures.launch({
      label: "screens",
      role: "target",
      env: { CU_FIXTURE_SCREENS_ONLY: "1" },
    });
    const screensRow = await fixtures.waitFor("screens", (row) => row.event === "screens", 5_000);
    const screens = parseScreens(screensRow?.screens);
    summary.screens = screens.map((screen) => ({
      ...screen,
      bounds: rectJson(screen.bounds),
      topLeftFrame: rectJson(screen.topLeftFrame),
    }));
    const key = screens.find((screen) => screen.main);
    summary.keyDisplay = key?.id ?? null;
    const conversion: Check = {
      name: "screen_bounds_match_cocoa_frames",
      ok:
        screens.length > 0 &&
        screens.every((screen) => sameRect(screen.bounds, screen.topLeftFrame, 0.5)),
      detail: { screens: screens.length },
    };
    const chosen = options.displays;
    if (!chosen) throw new ListOnly();
    const candidates = screens.filter((screen) => chosen.includes(screen.id));
    const unknown = chosen.filter((id) => !screens.some((screen) => screen.id === id));
    if (unknown.length > 0) throw new Error(`BLOCKED(unknown display ids: ${unknown.join(",")})`);
    const run = new Run(wire, fixtures, frontBefore, helperPid, screens);
    const placed: { screen: Screen; label: string }[] = [];
    for (const screen of candidates) {
      const label = `d${screen.id}`;
      await fixtures.launch({
        label,
        role: "target",
        env: { CU_FIXTURE_MATRIX: "1", CU_FIXTURE_ORIGIN: `${screen.bounds.x},${screen.bounds.y}` },
      });
      placed.push({ screen, label });
    }
    await pause(700);
    await run.guardFront("after launching the fixtures");
    const usable: { screen: Screen; label: string }[] = [];
    for (const { screen, label } of placed) {
      const layout = await fixtures
        .waitFor(label, (row) => row.event === "layout", 5_000)
        .then(() => run.layout(label));
      const windows = layout?.windows ?? [];
      const reasons: string[] = [];
      if (windows.length === 0) reasons.push("no layout reported");
      for (const window of windows) {
        if (!window.onActiveSpace) reasons.push(`${window.window} not on the active Space`);
        if (!inside(window.frame, screen.bounds))
          reasons.push(`${window.window} not inside the display`);
      }
      const entry: JsonObject = {
        id: screen.id,
        name: screen.name,
        label,
        usable: reasons.length === 0,
        reasons,
      };
      displayResults.push(entry);
      if (reasons.length === 0) usable.push({ screen, label });
    }
    if (usable.length < options.minDisplays) {
      status = `SKIP(fewer than ${options.minDisplays} of the chosen displays show a desktop Space: ${usable.length} usable of ${candidates.length})`;
      verdict = "SKIP";
    } else {
      const { reply } = await wire.send("claim", { session: { ...wire.session } });
      if (reply.ok !== true)
        throw new Error(`BLOCKED(claim refused: ${JSON.stringify(reply.error ?? null)})`);
      claimed = true;
      const all: Check[] = [conversion];
      for (const { screen, label } of usable) {
        const checks = await checkDisplay(run, screen, label, options.overlayOnly);
        const entry = displayResults.find((result) => result.id === screen.id);
        if (entry) {
          entry.verdict = verdictOf(checks);
          entry.checks = checks.map((check) => ({ ...check }));
        }
        all.push(...checks);
      }
      const follow =
        usable.length >= 2 && !options.overlayOnly ? await checkFollow(run, usable) : [];
      summary.follow = follow.map((check) => ({ ...check }));
      all.push(...follow);
      summary.agentCursorState = run.cursorStateSupported;
      summary.conversion = { ...conversion };
      verdict = verdictOf(all);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status =
      error instanceof ListOnly
        ? "LIST(pass --displays <id,id> to choose the displays to test)"
        : error instanceof FrontChanged || !message.startsWith("BLOCKED")
          ? `ABORTED(${message})`
          : message;
  } finally {
    if (claimed)
      await wire
        .send("release", { session: { ...wire.session } }, { timeoutMs: 3_000 })
        .catch(() => undefined);
    summary.cleanup = await fixtures.quitAll();
    summary.sweptFixturePids = await sweepFixtureProcesses(build);
    await unregisterFixture(build).catch(() => undefined);
    const frontAfter = await frontApp();
    summary.frontAfter = frontAfter
      ? { pid: frontAfter.pid ?? null, bundleId: frontAfter.bundleId ?? null }
      : null;
    await log.flush();
  }
  summary.status = status;
  const listOnly = status.startsWith("LIST");
  summary.verdict = listOnly
    ? "LIST"
    : status === "complete" || verdict === "SKIP"
      ? verdict
      : "BLOCKED";
  summary.displays = displayResults;
  summary.finishedAt = new Date().toISOString();
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  for (const entry of displayResults)
    console.log(
      `display ${String(entry.id)} ${String(entry.name)}: ${String(entry.verdict ?? (entry.usable ? "not run" : "unusable"))}`,
    );
  console.log(`displays ${String(summary.verdict)} ${status} (${summaryPath})`);
  if (listOnly)
    for (const screen of parseScreens(summary.screens))
      console.log(
        `  display ${screen.id} ${screen.name}: bounds ${screen.bounds.x},${screen.bounds.y} ${screen.bounds.w}x${screen.bounds.h} scale ${screen.backingScale}${screen.primary ? " primary" : ""}`,
      );
  return summary.verdict === "PASS" || summary.verdict === "SKIP" ? 0 : 1;
}

process.exit(await main());
