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
  parseOwnerWindows,
  parseScreens,
  pointOf,
  rectJson,
  rectOf,
  type Check,
  type Point,
  type Rect,
  type Screen,
} from "./displays-score.ts";
import {
  cursorOf,
  parseCursorReport,
  percentile,
  scorePointer,
  scoreSamples,
  scoreSettled,
  type Acted,
  type CursorStateReport,
} from "./cursors-score.ts";
import { FixtureSet, frontApp, sweepFixtureProcesses, type FrontApp } from "./fixtures.ts";
import { checkHelper } from "./scenarios.ts";
import { isMainHelper } from "./score.ts";
import { RequestLog, Wire, WireError } from "./wire.ts";

type Kind = "click" | "click_ref" | "scroll" | "drag" | "move" | "press_ax" | "scroll_std";
const KINDS: Kind[] = ["click", "click_ref", "scroll", "drag", "move", "press_ax", "scroll_std"];

interface Options {
  helperApp: string;
  helperSocket: string;
  out: string;
  clients: number;
  displays: number[];
  reps: number;
  kinds: Kind[];
  offSpace: boolean;
}

class ArgumentError extends Error {}
class FrontChanged extends Error {}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const MAIN_TITLE = "CU Fixture Target";
const EXTENDED = { policy: "background", backgroundDelivery: "extended" };
const STANDARD = { policy: "background" };
const SLOTS: Point[] = [
  { x: -540, y: -600 },
  { x: 180, y: -600 },
  { x: -540, y: -60 },
  { x: 180, y: -60 },
];
const OBSERVER_SLOT: Point = { x: 850, y: -60 };
const MAIN_OFFSET: Point = { x: 560, y: 657 };
const QUIT_BOUND_MS = 1_000;
const RELEASE_BOUND_MS = 600;

function isKind(value: string): value is Kind {
  return KINDS.some((kind) => kind === value);
}

function parse(argv: string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const helperApp = value("--helper-app");
  const helperSocket = value("--helper-socket");
  const out = value("--out");
  const listed = value("--displays");
  if (!helperApp || !helperSocket || !out || !listed)
    throw new ArgumentError(
      "usage: cursors.ts --helper-app <app> --helper-socket <socket> --out <dir> --displays <id,id> [--clients <n>] [--reps <n>] [--kinds <k,k>] [--off-space]",
    );
  const displays = listed.split(",").map((id) => Number(id.trim()));
  if (displays.some((id) => !Number.isSafeInteger(id)))
    throw new ArgumentError("--displays takes comma-separated display ids");
  const clients = Number(value("--clients") ?? "2");
  if (!Number.isSafeInteger(clients) || clients < 1 || clients > SLOTS.length * displays.length)
    throw new ArgumentError("--clients takes 1 to " + SLOTS.length * displays.length + " here");
  const reps = Number(value("--reps") ?? "1");
  if (!Number.isSafeInteger(reps) || reps < 1)
    throw new ArgumentError("--reps takes a positive integer");
  const kindsArg = value("--kinds");
  const kinds: Kind[] = [];
  for (const raw of kindsArg ? kindsArg.split(",") : KINDS) {
    const kind = raw.trim();
    if (!isKind(kind))
      throw new ArgumentError("unknown kind " + kind + " (" + KINDS.join(",") + ")");
    kinds.push(kind);
  }
  return {
    helperApp: resolve(helperApp),
    helperSocket: resolve(helperSocket),
    out: resolve(out),
    clients,
    displays,
    reps,
    kinds,
    offSpace: argv.includes("--off-space"),
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
  windowId: number;
  outline: JsonObject;
  frame: Rect;
  imageWidth: number;
  imageHeight: number;
}

function findNode(node: JsonObject, identifier: string): JsonObject | undefined {
  if (node.identifier === identifier) return node;
  for (const child of Array.isArray(node.children) ? node.children : []) {
    if (!isJsonObject(child)) continue;
    const found = findNode(child, identifier);
    if (found) return found;
  }
  return undefined;
}

function imagePoint(view: Look, point: Point): JsonObject {
  return {
    x: ((point.x - view.frame.x) / view.frame.w) * view.imageWidth,
    y: ((point.y - view.frame.y) / view.frame.h) * view.imageHeight,
  };
}

interface Target {
  label: string;
  screen: Screen;
  wire: Wire;
  pid: number;
  views: Record<string, Rect>;
  window: Rect;
}

interface Sample {
  at: number;
  report: CursorStateReport;
}

class Run {
  readonly probe: Wire;
  readonly fixtures: FixtureSet;
  readonly frontBefore: FrontApp | undefined;
  readonly helperPid: number;
  readonly screens: Screen[];
  readonly actedPoints: Point[] = [];
  private ownerSeq = 0;
  private spacesSeq = 0;
  spacesBaseline: string | undefined;

  constructor(
    probe: Wire,
    fixtures: FixtureSet,
    frontBefore: FrontApp | undefined,
    helperPid: number,
    screens: Screen[],
  ) {
    this.probe = probe;
    this.fixtures = fixtures;
    this.frontBefore = frontBefore;
    this.helperPid = helperPid;
    this.screens = screens;
  }

  async guardFront(when: string): Promise<void> {
    const front = await frontApp();
    if (front?.pid !== this.frontBefore?.pid)
      throw new FrontChanged(
        "frontmost app changed " +
          when +
          ": pid " +
          String(this.frontBefore?.pid) +
          " -> " +
          String(front?.pid) +
          " (" +
          (front?.bundleId ?? "unknown") +
          ")",
      );
    const spaces = await this.spaces();
    if (this.spacesBaseline === undefined) this.spacesBaseline = spaces;
    else if (spaces !== undefined && spaces !== this.spacesBaseline)
      throw new FrontChanged("a display's Spaces changed " + when + ": " + spaces);
  }

  async spaces(): Promise<string | undefined> {
    if (!this.fixtures.instances.has("obs")) return undefined;
    const seq = ++this.spacesSeq;
    await this.fixtures.trigger(".cu-spaces-obs", seq + "\n");
    const row = await this.fixtures.waitFor(
      "obs",
      (entry) => entry.event === "spaces" && entry.seq === seq,
      3_000,
    );
    return row ? JSON.stringify(row.displays ?? null) : undefined;
  }

  async state(capture = false): Promise<CursorStateReport | undefined> {
    const { reply } = await this.probe.send("agentCursorState", capture ? { capture: true } : {}, {
      timeoutMs: 10_000,
    });
    return parseCursorReport(reply.result);
  }

  async look(target: Target): Promise<Look> {
    const listed = await target.wire.send("listWindows", { pid: target.pid });
    const windows = Array.isArray(listed.reply.result) ? listed.reply.result : [];
    const window = windows.find((entry) => isJsonObject(entry) && entry.title === MAIN_TITLE);
    if (!isJsonObject(window) || !isNumber(window.windowId))
      throw new Error("window not found: " + target.label);
    const { reply } = await target.wire.send("look", {
      windowId: window.windowId,
      includeImage: true,
      readText: "never",
    });
    const result = isJsonObject(reply.result) ? reply.result : undefined;
    const win = result && isJsonObject(result.window) ? result.window : undefined;
    const image = result && isJsonObject(result.image) ? result.image : undefined;
    const frame = win ? rectOf(win.framePoints) : undefined;
    if (
      !result ||
      !isString(result.lookId) ||
      !isJsonObject(result.outline) ||
      !frame ||
      !image ||
      !isNumber(image.width) ||
      !isNumber(image.height)
    )
      throw new Error(
        "look " + target.label + ": " + JSON.stringify(reply.error ?? "invalid reply"),
      );
    return {
      lookId: result.lookId,
      windowId: window.windowId,
      outline: result.outline,
      frame,
      imageWidth: image.width,
      imageHeight: image.height,
    };
  }

  async act(target: Target, fields: JsonObject): Promise<JsonObject> {
    try {
      const { reply } = await target.wire.send(
        "act",
        { ...target.wire.actEnvelope(), pid: target.pid, ...fields },
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
    await this.fixtures.trigger(".cu-owner-windows-" + label, this.helperPid + " " + seq + "\n");
    return await this.fixtures.waitFor(
      label,
      (row) => row.event === "ownerWindows" && row.seq === seq,
      3_000,
    );
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
      transportError: reply.transportError ?? null,
    },
  };
}

function jitter(rep: number, index: number): Point {
  return { x: (((rep * 7 + index * 3) % 5) - 2) * 9.3, y: (((rep * 5 + index * 2) % 5) - 2) * 7.1 };
}

interface Planned {
  fields: JsonObject;
  point: Point;
  path?: Point[];
  draws: boolean;
  received: (since: number) => Promise<Point | undefined>;
}

function plan(
  run: Run,
  target: Target,
  view: Look,
  kind: Kind,
  rep: number,
  index: number,
): Planned | undefined {
  const offset = jitter(rep, index);
  const at = (rect: Rect | undefined): Point | undefined => {
    if (!rect) return undefined;
    const middle = centre(rect);
    return { x: middle.x + offset.x, y: middle.y + offset.y };
  };
  const row = (event: string, extra?: (row: JsonObject) => boolean) => async (since: number) =>
    pointOf(
      (
        await run.rowAfter(
          target.label,
          since,
          (entry) => entry.event === event && (extra ? extra(entry) : true),
        )
      )?.at,
    );
  const custom = at(target.views.customView);
  switch (kind) {
    case "click":
      if (!custom) return undefined;
      return {
        fields: {
          lookId: view.lookId,
          ...EXTENDED,
          action: "click",
          target: imagePoint(view, custom),
          params: {},
        },
        point: custom,
        draws: true,
        received: row("customHit"),
      };
    case "click_ref": {
      const node = findNode(view.outline, "cu-custom-view");
      const frame = target.views.customView;
      if (!node || !isString(node.ref) || !frame) return undefined;
      return {
        fields: {
          lookId: view.lookId,
          ...EXTENDED,
          action: "click",
          target: { ref: node.ref },
          params: {},
        },
        point: centre(frame),
        draws: true,
        received: row("customHit"),
      };
    }
    case "scroll":
    case "scroll_std": {
      const point = at(target.views.scrollView);
      if (!point) return undefined;
      return {
        fields: {
          lookId: view.lookId,
          ...(kind === "scroll" ? EXTENDED : STANDARD),
          action: "scroll",
          target: imagePoint(view, point),
          params: { scrollX: 0, scrollY: rep % 2 === 0 ? 120 : -120 },
        },
        point,
        draws: true,
        received: row("targetScrollWheel"),
      };
    }
    case "drag": {
      const drag = target.views.dragView;
      if (!drag) return undefined;
      const y = drag.y + drag.h / 2 + offset.y;
      const from = { x: drag.x + drag.w * 0.15, y };
      const to = { x: drag.x + drag.w * 0.85 + offset.x, y: y + 6.4 };
      const path = [0, 1 / 3, 2 / 3, 1].map((step) => ({
        x: from.x + (to.x - from.x) * step,
        y: from.y + (to.y - from.y) * step,
      }));
      return {
        fields: {
          lookId: view.lookId,
          ...EXTENDED,
          action: "drag",
          target: imagePoint(view, centre(drag)),
          params: { path: path.map((point) => imagePoint(view, point)) },
        },
        point: to,
        path,
        draws: true,
        received: row("dragUp"),
      };
    }
    case "move":
      if (!custom) return undefined;
      return {
        fields: {
          lookId: view.lookId,
          ...EXTENDED,
          action: "moveMouse",
          target: imagePoint(view, custom),
          params: {},
        },
        point: custom,
        draws: true,
        received: row("targetPointer", (entry) => entry.type === "moved"),
      };
    case "press_ax": {
      const node = findNode(view.outline, "cu-increment");
      const frame = target.views.increment;
      if (!node || !isString(node.ref) || !frame) return undefined;
      return {
        fields: {
          lookId: view.lookId,
          ...STANDARD,
          action: "press",
          target: { ref: node.ref },
          params: {},
        },
        point: centre(frame),
        draws: true,
        received: async () => undefined,
      };
    }
  }
}

interface BurstResult {
  checks: Check[];
  latencies: number[];
  queueLatencies: number[];
  clientArrivals: number[];
  detail: JsonObject;
}

async function burst(run: Run, targets: Target[], kind: Kind, rep: number): Promise<BurstResult> {
  const name = kind + "_r" + rep;
  const checks: Check[] = [];
  const looks = await Promise.all(targets.map((target) => run.look(target)));
  const planned = targets.map((target, index) => plan(run, target, looks[index], kind, rep, index));
  const acted: Acted[] = [];
  const since = Date.now();
  const sentAt: number[] = [];
  let running = true;
  const samples: Sample[] = [];
  const sampler = (async () => {
    while (running) {
      const report = await run.state().catch(() => undefined);
      if (report) samples.push({ at: Date.now(), report });
      await pause(20);
    }
  })();
  const replies = await Promise.all(
    targets.map(async (target, index) => {
      const step = planned[index];
      if (!step) return { ok: false, skipped: "not planned" } satisfies JsonObject;
      sentAt[index] = Date.now();
      return await run.act(target, step.fields);
    }),
  );
  running = false;
  await sampler;
  for (const [index, target] of targets.entries()) {
    const step = planned[index];
    checks.push(replyCheck(name + "_" + target.label + "_reply", replies[index]));
    if (!step) continue;
    run.actedPoints.push(step.point, ...(step.path ?? []));
    const received = await step.received(since);
    acted.push({
      session: target.wire.session.id,
      label: target.label,
      windowId: looks[index].windowId,
      point: step.point,
      path: step.path,
      received,
      draws: step.draws,
    });
  }
  const until = Date.now() + 3_000;
  let settled: CursorStateReport | undefined;
  for (;;) {
    const report = await run.state();
    if (report) samples.push({ at: Date.now(), report });
    const done =
      report !== undefined &&
      acted.every((entry) => {
        const cursor = cursorOf(report, entry);
        return !entry.draws || (cursor !== undefined && !cursor.animating);
      });
    if (done || Date.now() >= until) break;
    await pause(40);
  }
  await pause(60);
  settled = await run.state(true);
  checks.push(...scoreSettled(name, acted, settled, run.screens));
  checks.push(
    ...scoreSamples(
      name,
      acted,
      samples.map((sample) => sample.report),
    ),
  );
  const latencies: number[] = [];
  const queueLatencies: number[] = [];
  const clientArrivals: number[] = [];
  for (const [index, entry] of acted.entries()) {
    const cursor = settled ? cursorOf(settled, entry) : undefined;
    if (cursor?.arrivedAt !== null && cursor?.arrivedAt !== undefined && cursor.issuedAt !== null)
      latencies.push((cursor.arrivedAt - cursor.issuedAt) * 1000);
    if (cursor?.drawnAt !== null && cursor?.drawnAt !== undefined && cursor.issuedAt !== null)
      queueLatencies.push((cursor.drawnAt - cursor.issuedAt) * 1000);
    const first = samples.find((sample) => {
      const found = cursorOf(sample.report, entry);
      return (
        sample.at >= (sentAt[index] ?? since) &&
        found !== undefined &&
        !found.animating &&
        found.target !== undefined &&
        distance(found.target, entry.point) <= 0.5
      );
    });
    if (first && sentAt[index] !== undefined) clientArrivals.push(first.at - sentAt[index]);
  }
  await run.guardFront("after " + name);
  return {
    checks,
    latencies,
    queueLatencies,
    clientArrivals,
    detail: {
      kind,
      rep,
      samples: samples.length,
      acted: acted.map((entry) => ({
        label: entry.label,
        session: entry.session,
        windowId: entry.windowId,
        point: { ...entry.point },
        received: entry.received ? { ...entry.received } : null,
      })),
      settledCursors: settled ? settled.cursors.length : null,
      latencyMs: latencies,
      queueLatencyMs: queueLatencies,
      clientArrivalMs: clientArrivals,
    },
  };
}

function verdictOf(checks: Check[]): "PASS" | "FAIL" {
  return checks.some((check) => check.ok === false) ? "FAIL" : "PASS";
}

function stats(values: number[]): JsonObject {
  return {
    count: values.length,
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    max: values.length ? Math.max(...values) : null,
  };
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  ms: number,
  step = 50,
): Promise<number | null> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return Date.now() - start;
    if (Date.now() - start >= ms) return null;
    await pause(step);
  }
}

async function lifecycle(
  run: Run,
  targets: Target[],
  wires: Wire[],
  idleMs: number,
  fadeMs: number,
): Promise<Check[]> {
  const checks: Check[] = [];
  const ours = (report: CursorStateReport | undefined, session: string): number =>
    report
      ? report.cursors.filter(
          (cursor) => cursor.session === session || (report.legacy && cursor.visible),
        ).length
      : 0;
  await burst(run, targets, "click", 99);
  if (targets.length >= 2) {
    const released = targets[0].wire;
    const start = Date.now();
    await released.send("release", { session: { ...released.session } });
    const gone = await waitUntil(
      async () => ours(await run.state(), released.session.id) === 0,
      RELEASE_BOUND_MS + 1_000,
    );
    const after = await run.state();
    checks.push({
      name: "released_session_cursor_removed",
      ok:
        gone !== null &&
        Date.now() - start <= RELEASE_BOUND_MS + 1_000 &&
        (gone ?? Infinity) <= RELEASE_BOUND_MS,
      detail: { removedAfterMs: gone, boundMs: RELEASE_BOUND_MS },
    });
    checks.push({
      name: "released_session_others_kept",
      ok: targets.slice(1).every((target) => ours(after, target.wire.session.id) >= 1),
      detail: { remaining: after ? after.cursors.length : null },
    });
    await released.send("claim", { session: { ...released.session } });
  }
  if (targets.length >= 2) {
    const quitting = targets[1];
    const before = await run.state();
    const windowId =
      before?.cursors.find((cursor) => cursor.session === quitting.wire.session.id)?.windowId ??
      null;
    const quitAt = Date.now();
    const helperNow = before?.now ?? null;
    process.kill(quitting.pid, "SIGTERM");
    const gone = await waitUntil(
      async () => ours(await run.state(), quitting.wire.session.id) === 0,
      QUIT_BOUND_MS + 2_000,
    );
    const after = await run.state();
    const lateCreates = (after?.history ?? []).filter(
      (event) =>
        event.kind === "created" &&
        windowId !== null &&
        event.windowId === windowId &&
        helperNow !== null &&
        event.at > helperNow,
    );
    checks.push({
      name: "quit_target_cursor_removed",
      ok: gone !== null && gone <= QUIT_BOUND_MS,
      detail: {
        removedAfterMs: gone,
        boundMs: QUIT_BOUND_MS,
        sinceQuitMs: Date.now() - quitAt,
        windowId,
      },
    });
    checks.push({
      name: "no_cursor_created_after_target_gone",
      ok: after?.legacy ? null : lateCreates.length === 0,
      detail: { lateCreates: lateCreates.map((event) => ({ ...event })) },
    });
  }
  const live = targets.filter((target, index) => index !== 1 || targets.length < 2);
  await burst(run, live, "click", 97);
  const idleFrom = Date.now();
  const allGone = await waitUntil(
    async () => {
      const report = await run.state();
      return report !== undefined && report.cursors.length === 0;
    },
    idleMs + fadeMs + 3_000,
    200,
  );
  checks.push({
    name: "idle_cursors_fade_and_go",
    ok: allGone !== null && allGone >= idleMs - 1_000 && allGone <= idleMs + fadeMs + 1_000,
    detail: {
      removedAfterMs: allGone,
      idleMs,
      boundMs: idleMs + fadeMs + 1_000,
      cursors: live.length,
      sinceBurstMs: Date.now() - idleFrom,
    },
  });
  const owner = await run.ownerWindows("obs");
  const onscreen = parseOwnerWindows(owner?.windows).filter((window) => window.onscreen);
  checks.push({
    name: "no_helper_window_on_screen_when_idle",
    ok: owner === undefined ? null : onscreen.length === 0,
    detail: {
      onscreen: onscreen.map((window) => ({
        number: window.number,
        bounds: rectJson(window.bounds),
      })),
    },
  });
  const remaining = live;
  await burst(run, remaining, "click", 98);
  for (const target of remaining) process.kill(target.pid, "SIGTERM");
  const quitAt = Date.now();
  const cleared = await waitUntil(
    async () => {
      const row = await run.ownerWindows("obs");
      return parseOwnerWindows(row?.windows).filter((window) => window.onscreen).length === 0;
    },
    QUIT_BOUND_MS + 2_000,
    100,
  );
  checks.push({
    name: "no_helper_window_after_targets_quit",
    ok: cleared !== null && cleared <= QUIT_BOUND_MS,
    detail: { clearedAfterMs: cleared, boundMs: QUIT_BOUND_MS, sinceQuitMs: Date.now() - quitAt },
  });
  for (const wire of wires)
    await wire
      .send("release", { session: { ...wire.session } }, { timeoutMs: 3_000 })
      .catch(() => undefined);
  return checks;
}

async function offSpace(run: Run, target: Target): Promise<Check[]> {
  const checks: Check[] = [];
  const view = await run.look(target);
  const point = centre(target.views.customView ?? target.window);
  await run.act(target, {
    lookId: view.lookId,
    ...EXTENDED,
    action: "click",
    target: imagePoint(view, point),
    params: {},
  });
  await pause(500);
  const shown = await run.state();
  const hadCursor = shown?.cursors.some((cursor) => cursor.windowId === view.windowId) ?? false;
  await run.fixtures.trigger(".cu-space-" + target.label, "auto\n");
  const moved = await run.fixtures.waitFor(target.label, (row) => row.event === "spaceMove", 4_000);
  if (!moved || moved.moved !== true || moved.space === -1)
    return [
      {
        name: "off_space",
        ok: null,
        detail: { reason: "no hidden desktop Space to move the fixture to", row: moved ?? null },
      },
    ];
  await pause(400);
  await run.guardFront("after moving a fixture off-Space");
  const gone = await waitUntil(
    async () =>
      !((await run.state())?.cursors.some((cursor) => cursor.windowId === view.windowId) ?? false),
    QUIT_BOUND_MS + 1_000,
  );
  checks.push({
    name: "off_space_old_cursor_removed",
    ok: hadCursor ? gone !== null && gone <= QUIT_BOUND_MS : null,
    detail: { hadCursor, removedAfterMs: gone },
  });
  const before = await run.state();
  const reply = await run.act(target, {
    lookId: view.lookId,
    ...EXTENDED,
    action: "click",
    target: imagePoint(view, point),
    params: {},
  });
  await pause(600);
  const after = await run.state();
  const result = isJsonObject(reply.result) ? reply.result : undefined;
  const performed = result && isJsonObject(result.performed) ? result.performed : undefined;
  const created = (after?.history ?? []).filter(
    (event) =>
      event.kind === "created" &&
      event.windowId === view.windowId &&
      before?.now !== null &&
      before?.now !== undefined &&
      event.at > before.now,
  );
  checks.push({
    name: "off_space_act_draws_no_cursor",
    ok: after?.legacy
      ? !(after.cursors[0]?.visible ?? false)
      : created.length === 0 &&
        !(after?.cursors.some((cursor) => cursor.windowId === view.windowId) ?? false),
    detail: {
      reply: {
        ok: reply.ok ?? null,
        offSpace: performed?.offSpace ?? null,
        error: reply.error ?? null,
      },
      created: created.length,
    },
  });
  await run.guardFront("after the off-Space act");
  return checks;
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
    console.error("HELPER_IS_MAIN the cursor check must not use the main helper app or socket");
    return 2;
  }
  if (process.platform !== "darwin" || arch() !== "arm64") {
    console.error("ARCH_UNSUPPORTED " + process.platform + "/" + arch());
    return 2;
  }
  const summaryPath = join(options.out, "summary.json");
  if (await exists(summaryPath)) {
    console.error("OUT_NOT_FRESH " + summaryPath + " exists; choose a new --out");
    return 2;
  }
  if (!(await socketBusy(options.helperSocket))) {
    console.error("HELPER_SOCKET no daemon listening at " + options.helperSocket);
    return 2;
  }
  await mkdir(options.out, { recursive: true });
  const helperAppReal = await realpath(options.helperApp);
  const log = new RequestLog(join(options.out, "requests.jsonl"));
  const probe = new Wire(options.helperSocket, log);
  const frontBefore = await frontApp();
  const build = await buildFixture(join(options.out, "fixture-build"));
  const fixtures = new FixtureSet(join(options.out, "fixture"), build);
  await fixtures.prepare();
  const summary: JsonObject = {
    startedAt: new Date().toISOString(),
    helper: { app: options.helperApp, socket: options.helperSocket },
    options: {
      clients: options.clients,
      displays: options.displays,
      reps: options.reps,
      kinds: options.kinds,
      offSpace: options.offSpace,
    },
    frontBefore: frontBefore
      ? { pid: frontBefore.pid ?? null, bundleId: frontBefore.bundleId ?? null }
      : null,
  };
  let status = "complete";
  let verdict = "FAIL";
  const all: Check[] = [];
  const wires: Wire[] = [];
  try {
    const checked = await checkHelper(options.helperSocket, helperAppReal, log);
    summary.diagnostics = checked.diagnostics ?? null;
    const helperPid = checked.diagnostics?.pid;
    if (checked.blocked || !isNumber(helperPid))
      throw new Error("BLOCKED(" + (checked.blocked ?? "no helper pid") + ")");
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
    const unknown = options.displays.filter((id) => !screens.some((screen) => screen.id === id));
    if (unknown.length > 0)
      throw new Error("BLOCKED(unknown display ids: " + unknown.join(",") + ")");
    const chosen = options.displays
      .map((id) => screens.find((screen) => screen.id === id))
      .filter((screen): screen is Screen => screen !== undefined);
    const run = new Run(probe, fixtures, frontBefore, helperPid, screens);
    const first = chosen[0];
    await fixtures.launch({
      label: "obs",
      role: "target",
      env: {
        CU_FIXTURE_POINTER_SAMPLER: "1",
        CU_FIXTURE_ORIGIN:
          String(first.bounds.x + OBSERVER_SLOT.x) + "," + String(first.bounds.y + OBSERVER_SLOT.y),
      },
    });
    const placed: { label: string; screen: Screen; wanted: Point }[] = [];
    for (let index = 0; index < options.clients; index++) {
      const screen = chosen[index % chosen.length];
      const slot = SLOTS[Math.floor(index / chosen.length)];
      const label = "t" + index;
      await fixtures.launch({
        label,
        role: "target",
        env: {
          CU_FIXTURE_PARALLEL: "1",
          CU_FIXTURE_INPUT_LOG: "1",
          CU_FIXTURE_ORIGIN:
            String(screen.bounds.x + slot.x) + "," + String(screen.bounds.y + slot.y),
        },
      });
      placed.push({
        label,
        screen,
        wanted: {
          x: screen.bounds.x + slot.x + MAIN_OFFSET.x,
          y: screen.bounds.y + slot.y + MAIN_OFFSET.y,
        },
      });
    }
    let offTarget: Target | undefined;
    if (options.offSpace) {
      const slot = SLOTS[SLOTS.length - 1];
      await fixtures.launch({
        label: "off",
        role: "target",
        env: {
          CU_FIXTURE_PARALLEL: "1",
          CU_FIXTURE_ORIGIN:
            String(first.bounds.x + slot.x + 300) + "," + String(first.bounds.y + slot.y),
        },
      });
    }
    await pause(700);
    await run.guardFront("after launching the fixtures");
    const targets: Target[] = [];
    const placement: JsonObject[] = [];
    for (const { label, screen, wanted } of [
      ...placed,
      ...(options.offSpace ? [{ label: "off", screen: first, wanted: undefined }] : []),
    ]) {
      await fixtures.waitFor(label, (row) => row.event === "layout", 5_000);
      const readLayout = async (): Promise<JsonObject | undefined> => {
        let layout: JsonObject | undefined;
        for (let attempt = 0; attempt < 4; attempt++) {
          const before = (await fixtures.rows(label)).filter(
            (row) => row.event === "layout",
          ).length;
          await fixtures.trigger(".cu-layout-" + label);
          const until = Date.now() + 2_000;
          let rows = await fixtures.rows(label);
          while (
            rows.filter((row) => row.event === "layout").length <= before &&
            Date.now() < until
          ) {
            await pause(40);
            rows = await fixtures.rows(label);
          }
          layout = rows.filter((row) => row.event === "layout").at(-1);
          const windows = Array.isArray(layout?.windows) ? layout.windows : [];
          if (windows.every((row) => isJsonObject(row) && row.onActiveSpace === true)) break;
          await pause(300);
        }
        return layout;
      };
      const mainOf = (value: JsonObject | undefined): JsonObject | undefined =>
        (Array.isArray(value?.windows) ? value.windows : []).find(
          (row): row is JsonObject => isJsonObject(row) && row.window === "main",
        );
      let layout = await readLayout();
      let main = mainOf(layout);
      let frame = main ? rectOf(main.frame) : undefined;
      let replaced = false;
      if (wanted && frame && main && isNumber(main.windowNumber) && !inside(frame, screen.bounds)) {
        const fixer = new Wire(options.helperSocket, log);
        await fixer.send("claim", { session: { ...fixer.session } });
        await fixer.send("setWindowFrame", {
          session: { ...fixer.session },
          pid: fixtures.pid(label),
          windowId: main.windowNumber,
          x: wanted.x,
          y: wanted.y,
          width: frame.w,
          height: frame.h,
        });
        await fixer.send("release", { session: { ...fixer.session } });
        await pause(300);
        replaced = true;
        layout = await readLayout();
        main = mainOf(layout);
        frame = main ? rectOf(main.frame) : undefined;
      }
      const views: Record<string, Rect> = {};
      if (layout && isJsonObject(layout.views))
        for (const [key, value] of Object.entries(layout.views)) {
          const rect = rectOf(value);
          if (rect) views[key] = rect;
        }
      const usable =
        frame !== undefined && main?.onActiveSpace === true && inside(frame, screen.bounds);
      placement.push({
        label,
        display: screen.id,
        frame: frame ? rectJson(frame) : null,
        usable,
        replaced,
      });
      if (!usable || !frame) continue;
      const wire = new Wire(options.helperSocket, log);
      const target: Target = {
        label,
        screen,
        wire,
        pid: fixtures.pid(label),
        views,
        window: frame,
      };
      if (label === "off") offTarget = target;
      else {
        targets.push(target);
        wires.push(wire);
      }
    }
    summary.placement = placement;
    if (targets.length < options.clients) {
      status =
        "SKIP(only " +
        targets.length +
        " of " +
        options.clients +
        " fixture windows are on a showing Space inside their display)";
      verdict = "SKIP";
    } else {
      for (const wire of wires) {
        const { reply } = await wire.send("claim", { session: { ...wire.session } });
        if (reply.ok !== true)
          throw new Error("BLOCKED(claim refused: " + JSON.stringify(reply.error ?? null) + ")");
      }
      if (offTarget) {
        await offTarget.wire.send("claim", { session: { ...offTarget.wire.session } });
        wires.push(offTarget.wire);
      }
      const runFrom = Date.now();
      const bursts: JsonObject[] = [];
      const latencies: number[] = [];
      const queue: number[] = [];
      const client: number[] = [];
      for (let rep = 0; rep < options.reps; rep++)
        for (const kind of options.kinds) {
          const result = await burst(run, targets, kind, rep);
          all.push(...result.checks);
          latencies.push(...result.latencies);
          queue.push(...result.queueLatencies);
          client.push(...result.clientArrivals);
          bursts.push({
            ...result.detail,
            verdict: verdictOf(result.checks),
            failed: result.checks
              .filter((check) => check.ok === false)
              .map((check) => ({ ...check })),
          });
        }
      summary.bursts = bursts;
      summary.latency = {
        eventToArrivalMs: stats(latencies),
        eventToDrawnMs: stats(queue),
        clientSendToRestMs: stats(client),
      };
      if (offTarget) all.push(...(await offSpace(run, offTarget)));
      const settings = await run.state();
      all.push(
        ...(await lifecycle(
          run,
          targets,
          wires,
          settings?.idleMs ?? 8_000,
          settings?.fadeMs ?? 250,
        )),
      );
      const pointerRows = (await fixtures.rows("obs")).filter((row) => row.event === "pointer");
      const pointerSamples = pointerRows.flatMap((row) =>
        isNumber(row.x) && isNumber(row.y) && isNumber(row.ts)
          ? [{ x: row.x, y: row.y, ts: row.ts }]
          : [],
      );
      all.push(scorePointer(pointerSamples, run.actedPoints, { from: runFrom, to: Date.now() }));
      const final = await run.state();
      summary.final = final
        ? {
            cursors: final.cursors.length,
            dropped: final.dropped,
            history: final.history.slice(-40).map((event) => ({ ...event })),
          }
        : null;
      await run.guardFront("at the end");
      verdict = verdictOf(all);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status =
      error instanceof FrontChanged || !message.startsWith("BLOCKED")
        ? "ABORTED(" + message + ")"
        : message;
  } finally {
    for (const wire of wires)
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
  summary.verdict = status === "complete" || verdict === "SKIP" ? verdict : "BLOCKED";
  summary.checks = all.map((check) => ({ ...check }));
  summary.failed = all.filter((check) => check.ok === false).map((check) => check.name);
  summary.finishedAt = new Date().toISOString();
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  const latency = isJsonObject(summary.latency) ? summary.latency : undefined;
  console.log("cursors " + String(summary.verdict) + " " + status + " (" + summaryPath + ")");
  console.log(
    "  checks " +
      all.length +
      ", failed " +
      all.filter((check) => check.ok === false).length +
      (all.some((check) => check.ok === false)
        ? ": " +
          all
            .filter((check) => check.ok === false)
            .slice(0, 12)
            .map((check) => check.name)
            .join(", ")
        : ""),
  );
  if (latency) console.log("  latency " + JSON.stringify(latency));
  return summary.verdict === "PASS" || summary.verdict === "SKIP" ? 0 : 1;
}

process.exit(await main());
