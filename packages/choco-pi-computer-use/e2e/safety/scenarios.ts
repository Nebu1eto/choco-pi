import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";
import { fixtureApps } from "../fixture/build.ts";
import { frontApp, type FixtureSet, type InstanceSpec } from "./fixtures.ts";
import {
  diagnosticsBlock,
  eventsIn,
  focusState,
  scoreCancel,
  scoreControl,
  scoreJudgement,
  scoreJudgementControl,
  scoreMisdelivery,
  scoreParallel,
  scoreRestore,
  stringsIn,
  type Score,
  type TimeWindow,
} from "./score.ts";
import { elementRef, rootRef, stateIdOf, type ToolOutcome, type TsLayer } from "./ts-layer.ts";
import { reduceReply, Wire, WireError, type RequestLog } from "./wire.ts";

export class Blocked extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "Blocked";
    this.reason = reason;
  }
}

export interface ScenarioContext {
  id: string;
  fixtures: FixtureSet;
  wire: Wire;
  signal: AbortSignal;
  ts: () => Promise<TsLayer>;
  answers: JsonObject[];
  notes: JsonObject;
  window: TimeWindow;
  usedTs: boolean;
}

export interface Scenario {
  id: string;
  layer: "wire" | "ts";
  asserts: string;
  timeoutMs: number;
  run: (ctx: ScenarioContext) => Promise<Score>;
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const TARGET_TITLE = fixtureApps.target.title;
const GRANT = { policy: "foreground", foregroundGrant: true };

export async function checkHelper(
  socket: string,
  helperAppReal: string,
  log: RequestLog,
): Promise<{ blocked?: string; diagnostics?: JsonObject }> {
  const wire = new Wire(socket, log);
  let reply: JsonObject | undefined;
  let error: string | undefined;
  try {
    reply = (await wire.send("diagnostics", {}, { timeoutMs: 3_000 })).reply;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const result = reply && isJsonObject(reply.result) ? reply.result : undefined;
  const reported = result && isString(result.executablePath) ? result.executablePath : undefined;
  const executableReal = reported ? await realpath(reported).catch(() => undefined) : undefined;
  const blocked = diagnosticsBlock({ reply, error, executableReal, helperAppReal });
  const diagnostics: JsonObject = {
    protocolVersion: result?.protocolVersion ?? null,
    executablePath: reported ?? null,
    pid: result?.pid ?? null,
    macOS: result?.macOS ?? null,
    accessibility: result?.accessibility ?? null,
    screenRecording: result?.screenRecording ?? null,
  };
  if (blocked) return { blocked, diagnostics };
  const until = Date.now() + 40_000;
  for (;;) {
    const probe = { id: `u0-probe-${randomUUID()}`, generation: 0 };
    const claimed = await wire
      .send("claim", { session: probe }, { timeoutMs: 3_000 })
      .catch(() => undefined);
    if (claimed?.reply.ok === true) {
      await wire.send("release", { session: probe }, { timeoutMs: 3_000 }).catch(() => undefined);
      return { diagnostics };
    }
    if (Date.now() >= until) {
      const code =
        claimed && isJsonObject(claimed.reply.error) ? claimed.reply.error.code : undefined;
      return { blocked: `helper_owned: ${String(code ?? "claim failed")}`, diagnostics };
    }
    await pause(2_000);
  }
}

interface Layout {
  targets: InstanceSpec[];
  holderEnv?: Record<string, string>;
  holderFirst?: boolean;
  front?: string;
  frontKey?: string;
}

async function launch(ctx: ScenarioContext, layout: Layout): Promise<void> {
  const holder: InstanceSpec = { label: "holder", role: "holder", env: layout.holderEnv };
  try {
    if (layout.holderFirst) await ctx.fixtures.launch(holder);
    for (const target of layout.targets) await ctx.fixtures.launch(target);
    if (!layout.holderFirst) await ctx.fixtures.launch(holder);
  } catch (error) {
    throw new Blocked(`fixture: ${error instanceof Error ? error.message : String(error)}`);
  }
  await pause(900);
  const label = layout.front ?? "holder";
  const expected = ctx.fixtures.pid(label);
  const front = await frontApp();
  if (front?.pid !== expected)
    throw new Blocked(
      `${label}-not-frontmost: front is ${front?.bundleId ?? "unknown"} pid ${String(front?.pid)}`,
    );
  const state = focusState(await ctx.fixtures.rows(label));
  if (state.active !== true) throw new Blocked(`${label}-not-frontmost: log does not end active`);
  if (layout.frontKey && state.key !== layout.frontKey)
    throw new Blocked(`${label}-key-window: ${state.key ?? "none"} instead of ${layout.frontKey}`);
  ctx.notes.frontBefore = { label, pid: expected, key: state.key ?? null };
}

function begin(ctx: ScenarioContext): void {
  ctx.window.from = Date.now();
}

async function end(ctx: ScenarioContext, settleMs: number): Promise<void> {
  await pause(settleMs);
  ctx.window.to = Date.now();
}

function errorCode(reply: JsonObject): string | undefined {
  return isJsonObject(reply.error) && isString(reply.error.code) ? reply.error.code : undefined;
}

async function claim(ctx: ScenarioContext): Promise<void> {
  const { reply } = await ctx.wire.send(
    "claim",
    { session: { ...ctx.wire.session } },
    { signal: ctx.signal },
  );
  if (reply.ok !== true) throw new Blocked(`claim: ${errorCode(reply) ?? "refused"}`);
}

async function release(ctx: ScenarioContext): Promise<void> {
  await ctx.wire
    .send("release", { session: { ...ctx.wire.session } }, { timeoutMs: 3_000 })
    .catch(() => undefined);
}

function record(
  ctx: ScenarioContext,
  label: string,
  cmd: string,
  reply: JsonObject | undefined,
): void {
  ctx.answers.push({ label, cmd, reply: reply ? reduceReply(cmd, reply) : null });
}

interface Look {
  lookId: string;
  outline: JsonObject;
  frame: { x: number; y: number; w: number; h: number };
  imageWidth?: number;
}

function frameOf(value: JsonValue | undefined): Look["frame"] | undefined {
  if (!isJsonObject(value)) return undefined;
  const { x, y, w, h } = value;
  return isNumber(x) && isNumber(y) && isNumber(w) && isNumber(h) ? { x, y, w, h } : undefined;
}

async function look(
  ctx: ScenarioContext,
  pid: number,
  title: string,
  includeImage: boolean,
): Promise<Look> {
  const listed = await ctx.wire.send("listWindows", { pid }, { signal: ctx.signal });
  const windows = Array.isArray(listed.reply.result) ? listed.reply.result : [];
  const window = windows.find((entry) => isJsonObject(entry) && entry.title === title);
  if (!isJsonObject(window)) throw new Blocked(`window-not-found: ${title}`);
  const args: JsonObject = { includeImage, readText: "never" };
  if (isNumber(window.windowId)) args.windowId = window.windowId;
  if (isString(window.windowRef)) args.windowRef = window.windowRef;
  const { reply } = await ctx.wire.send("look", args, { signal: ctx.signal });
  const result = isJsonObject(reply.result) ? reply.result : undefined;
  if (reply.ok !== true || !result || !isString(result.lookId) || !isJsonObject(result.outline))
    throw new Blocked(`look: ${errorCode(reply) ?? "invalid reply"}`);
  const frame = frameOf(isJsonObject(result.window) ? result.window.framePoints : undefined);
  if (!frame) throw new Blocked("look: no window frame");
  const image = isJsonObject(result.image) ? result.image : undefined;
  return {
    lookId: result.lookId,
    outline: result.outline,
    frame,
    imageWidth: image && isNumber(image.width) ? image.width : undefined,
  };
}

function findNode(node: JsonObject, match: (node: JsonObject) => boolean): JsonObject | undefined {
  if (match(node)) return node;
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (!isJsonObject(child)) continue;
    const found = findNode(child, match);
    if (found) return found;
  }
  return undefined;
}

function refOf(view: Look, match: (node: JsonObject) => boolean, what: string): string {
  const node = findNode(view.outline, match);
  if (!node || !isString(node.ref)) throw new Blocked(`element-not-found: ${what}`);
  return node.ref;
}

const byIdentifier = (identifier: string) => (node: JsonObject) => node.identifier === identifier;

async function act(
  ctx: ScenarioContext,
  label: string,
  fields: JsonObject,
  timeoutMs = 20_000,
): Promise<JsonObject | undefined> {
  try {
    const { reply } = await ctx.wire.send(
      "act",
      { ...ctx.wire.actEnvelope(), ...fields },
      { signal: ctx.signal, timeoutMs },
    );
    record(ctx, label, "act", reply);
    return reply;
  } catch (error) {
    if (!(error instanceof WireError)) throw error;
    record(ctx, label, "act", undefined);
    ctx.notes[`${label}TransportError`] = error.message;
    return undefined;
  }
}

type MisdeliveryKind = "type_text" | "keypress" | "web_set_text" | "click_covered";

const isWebInput = (node: JsonObject): boolean =>
  node.role === "AXTextField" && node.title === "Web Field";

async function lookWeb(ctx: ScenarioContext, pid: number): Promise<Look> {
  for (let attempt = 0; ; attempt += 1) {
    const view = await look(ctx, pid, "CU Fixture Web", false);
    if (findNode(view.outline, isWebInput) || attempt >= 10) return view;
    await pause(500);
  }
}

async function misdelivery(
  ctx: ScenarioContext,
  kind: MisdeliveryKind,
  sticky: boolean,
): Promise<Score> {
  const web = kind === "web_set_text";
  await launch(ctx, {
    targets: [{ label: "target", role: "target", env: web ? { CU_FIXTURE_WEB: "1" } : {} }],
    holderEnv: sticky ? { CU_FIXTURE_STICKY: "1" } : {},
  });
  if (web && !(await ctx.fixtures.waitFor("target", (row) => row.event === "webReady", 10_000)))
    throw new Blocked("web-not-ready");
  await claim(ctx);
  const pid = ctx.fixtures.pid("target");
  const view = web
    ? await lookWeb(ctx, pid)
    : await look(ctx, pid, TARGET_TITLE, kind === "click_covered");
  let fields: JsonObject;
  if (kind === "click_covered") {
    const node = findNode(view.outline, byIdentifier("cu-custom-view"));
    const rect = node && frameOf(node.rect);
    if (!rect || !view.imageWidth) throw new Blocked("element-not-found: custom view rect");
    const scale = view.frame.w / view.imageWidth;
    const screen = [
      view.frame.x + rect.x * scale,
      view.frame.y + rect.y * scale,
      rect.w * scale,
      rect.h * scale,
    ];
    ctx.notes.coveredScreenRect = screen;
    await ctx.fixtures.trigger(
      ".cu-cover-holder",
      screen.map((value) => value.toFixed(1)).join(","),
    );
    if (!(await ctx.fixtures.waitFor("holder", (row) => row.event === "covered", 3_000)))
      throw new Blocked("holder-did-not-cover");
    await pause(400);
    const front = await frontApp();
    if (front?.pid !== ctx.fixtures.pid("holder"))
      throw new Blocked("holder-not-frontmost after cover");
    fields = {
      action: "click",
      target: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
      params: {},
    };
  } else if (web) {
    const ref = refOf(view, isWebInput, "web text input");
    fields = { action: "setText", target: { ref }, params: { text: "web-probe" } };
  } else {
    const ref = refOf(view, byIdentifier("cu-field"), "Field");
    fields =
      kind === "keypress"
        ? { action: "keypress", target: { ref }, params: { keys: ["x"] } }
        : { action: "typeText", target: { ref }, params: { text: "safety-probe" } };
  }
  begin(ctx);
  const reply = await act(ctx, kind, { pid, lookId: view.lookId, ...GRANT, ...fields });
  await end(ctx, 900);
  await release(ctx);
  const holder = await ctx.fixtures.rows("holder");
  const target = await ctx.fixtures.rows("target");
  ctx.notes.stickyReactivations = eventsIn(holder, ["stickyReactivate"], ctx.window).length;
  ctx.notes.targetActivations = eventsIn(target, ["appActive"], ctx.window).length;
  ctx.notes.holderDeactivations = eventsIn(holder, ["appInactive"], ctx.window).length;
  ctx.notes.targetEffects = eventsIn(
    target,
    ["fieldValue", "customHit", "webValue"],
    ctx.window,
  ).map((row) => `${String(row.event)}@${String(row.ts)}`);
  const { effect, effectObserved } = intendedEffect(kind, target, ctx.window);
  if (sticky)
    return scoreMisdelivery({ holder, target, window: ctx.window, reply, effectObserved, effect });
  return scoreControl({ holder, window: ctx.window, reply, effectObserved, effect });
}

interface IntendedEffect {
  effect: string;
  effectObserved: boolean;
}

function intendedEffect(
  kind: MisdeliveryKind,
  target: JsonObject[],
  window: TimeWindow,
): IntendedEffect {
  const valueIs = (event: string, value: string): boolean =>
    eventsIn(target, [event], window).some((row) => row.value === value);
  if (kind === "click_covered")
    return {
      effect: "one customHit",
      effectObserved: eventsIn(target, ["customHit"], window).length === 1,
    };
  if (kind === "web_set_text")
    return { effect: "webValue web-probe", effectObserved: valueIs("webValue", "web-probe") };
  if (kind === "keypress")
    return { effect: "fieldValue x", effectObserved: valueIs("fieldValue", "x") };
  return {
    effect: "fieldValue safety-probe",
    effectObserved: valueIs("fieldValue", "safety-probe"),
  };
}

interface Prepared {
  stateId: string;
  ref: string;
}

function tsAnswer(ctx: ScenarioContext, label: string, outcome: ToolOutcome): void {
  const reasons = stringsIn(outcome.details).filter((value) =>
    /^(restored|app_restored|app_restored_window_not_restored|target_window_restored|target_window_not_restored|user_switched|focus_not_taken|target_was_frontmost|no_frontmost_evidence|helper_did_not_restore|delivery_may_continue|disabled|aborted|restore_failed.*|frontmost_check_failed.*)$/.test(
      value,
    ),
  );
  const details = isJsonObject(outcome.details) ? outcome.details : undefined;
  const execution = details && isJsonObject(details.execution) ? details.execution : undefined;
  ctx.answers.push({
    label,
    tool: "act_ui",
    error: outcome.error ?? null,
    status: details?.status ?? null,
    outcome: execution?.outcome ?? null,
    focusRestored: execution?.focusRestored ?? null,
    focusRestoreReason: execution?.focusRestoreReason ?? null,
    restoreReasons: reasons,
    execution: execution ?? null,
  });
}

async function tsPrepare(
  ctx: ScenarioContext,
  ts: TsLayer,
  pid: number,
  title: string,
): Promise<Prepared> {
  const found = await ts.find({ pid }, ctx.signal);
  if (found.error) throw new Blocked(`find_roots: ${found.error}`);
  const root = rootRef(found, title);
  if (!root) throw new Blocked(`find_roots: no root titled ${title} for pid ${pid}`);
  const observed = await ts.observe(root, ctx.signal);
  if (observed.error) throw new Blocked(`observe_ui: ${observed.error}`);
  const stateId = stateIdOf(observed);
  const ref = elementRef(observed, "Custom View");
  if (!stateId || !ref) throw new Blocked("observe_ui: no state id or Custom View ref");
  return { stateId, ref };
}

async function tsLayer(ctx: ScenarioContext): Promise<TsLayer> {
  try {
    const ts = await ctx.ts();
    ctx.usedTs = true;
    return ts;
  } catch (error) {
    throw new Blocked(
      `ts_bridge_import: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const SAME_TITLE_HOLDER = {
  CU_FIXTURE_WINDOWS: "2",
  CU_FIXTURE_SAME_TITLE: "1",
  CU_FIXTURE_KEY_WINDOW: "2",
};

async function restoreScore(
  ctx: ScenarioContext,
  user: string,
  expectedWindow: string,
): Promise<Score> {
  const userRows = await ctx.fixtures.rows(user);
  const target = await ctx.fixtures.rows("target");
  return scoreRestore({
    user: userRows,
    expectedWindow,
    window: ctx.window,
    actionEffect: eventsIn(target, ["customHit"], ctx.window).length > 0,
    focusLeft: eventsIn(userRows, ["windowResignKey"], ctx.window).some(
      (row) => row.window === expectedWindow,
    ),
  });
}

async function restoreSameTitleTs(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, {
    targets: [{ label: "target", role: "target" }],
    holderEnv: SAME_TITLE_HOLDER,
    frontKey: "second",
  });
  const ts = await tsLayer(ctx);
  const prepared = await tsPrepare(ctx, ts, ctx.fixtures.pid("target"), TARGET_TITLE);
  begin(ctx);
  tsAnswer(ctx, "click", await ts.act(prepared.stateId, prepared.ref, ctx.signal));
  await end(ctx, 900);
  return restoreScore(ctx, "holder", "second");
}

async function restoreSameTitleWire(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, {
    targets: [{ label: "target", role: "target" }],
    holderEnv: SAME_TITLE_HOLDER,
    frontKey: "second",
  });
  await claim(ctx);
  const front = await ctx.wire.send("getFrontmost", {}, { signal: ctx.signal });
  record(ctx, "frontBefore", "getFrontmost", front.reply);
  const user = isJsonObject(front.reply.result) ? front.reply.result : {};
  const pid = ctx.fixtures.pid("target");
  const view = await look(ctx, pid, TARGET_TITLE, false);
  const ref = refOf(view, byIdentifier("cu-custom-view"), "Custom View");
  begin(ctx);
  await act(ctx, "click", {
    pid,
    lookId: view.lookId,
    ...GRANT,
    action: "click",
    target: { ref },
    params: {},
  });
  const restoreArgs: JsonObject = {
    session: { ...ctx.wire.session },
    foregroundGrant: true,
    expectedFrontmostPid: pid,
  };
  for (const key of ["pid", "windowTitle", "windowId", "windowRef"])
    if (user[key] !== undefined) restoreArgs[key] = user[key];
  const restored = await ctx.wire.send("restoreUserFocus", restoreArgs, { signal: ctx.signal });
  record(ctx, "restore", "restoreUserFocus", restored.reply);
  await end(ctx, 900);
  await release(ctx);
  return restoreScore(ctx, "holder", "second");
}

async function restoreTargetWindow(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, {
    holderFirst: true,
    targets: [
      {
        label: "target",
        role: "target",
        activate: true,
        env: { CU_FIXTURE_WINDOWS: "2", CU_FIXTURE_KEY_WINDOW: "2", CU_FIXTURE_ACTIVATE: "1" },
      },
    ],
    front: "target",
    frontKey: "second",
  });
  const ts = await tsLayer(ctx);
  const prepared = await tsPrepare(ctx, ts, ctx.fixtures.pid("target"), TARGET_TITLE);
  begin(ctx);
  tsAnswer(ctx, "click", await ts.act(prepared.stateId, prepared.ref, ctx.signal));
  await end(ctx, 900);
  return restoreScore(ctx, "target", "second");
}

async function parallelTwoTargets(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, {
    targets: [
      { label: "a", role: "target" },
      { label: "b", role: "target", env: { CU_FIXTURE_OFFSET: "500,0" } },
    ],
    holderEnv: { CU_FIXTURE_WINDOWS: "2", CU_FIXTURE_KEY_WINDOW: "2" },
    frontKey: "second",
  });
  const ts = await tsLayer(ctx);
  const a = await tsPrepare(ctx, ts, ctx.fixtures.pid("a"), TARGET_TITLE);
  const b = await tsPrepare(ctx, ts, ctx.fixtures.pid("b"), TARGET_TITLE);
  begin(ctx);
  const [first, second] = await Promise.all([
    ts.act(a.stateId, a.ref, ctx.signal),
    ts.act(b.stateId, b.ref, ctx.signal),
  ]);
  tsAnswer(ctx, "a", first);
  tsAnswer(ctx, "b", second);
  await end(ctx, 1_200);
  return scoreParallel({
    holder: await ctx.fixtures.rows("holder"),
    expectedWindow: "second",
    targets: [
      { label: "a", rows: await ctx.fixtures.rows("a") },
      { label: "b", rows: await ctx.fixtures.rows("b") },
    ],
    calls: [
      { label: "a", details: first.details, error: first.error },
      { label: "b", details: second.details, error: second.error },
    ],
    window: ctx.window,
  });
}

async function judgementNoise(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, {
    targets: [
      {
        label: "target",
        role: "target",
        env: { CU_FIXTURE_NOISE: "1", CU_FIXTURE_DEAD_VIEW: "1" },
      },
    ],
  });
  await claim(ctx);
  const pid = ctx.fixtures.pid("target");
  const view = await look(ctx, pid, TARGET_TITLE, false);
  const ref = refOf(view, byIdentifier("cu-dead-view"), "Dead View");
  begin(ctx);
  const reply = await act(ctx, "click", {
    pid,
    lookId: view.lookId,
    policy: "background",
    action: "click",
    target: { ref },
    params: {},
  });
  await end(ctx, 500);
  await release(ctx);
  const target = await ctx.fixtures.rows("target");
  return scoreJudgement({
    reply,
    target,
    window: ctx.window,
    interference: {
      observed: target.some((row) => row.event === "noiseStarted"),
      reason: "noise_not_running",
    },
  });
}

async function judgementForeignActivation(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, {
    targets: [
      { label: "target", role: "target", env: { CU_FIXTURE_DEAD_VIEW: "1" } },
      { label: "other", role: "target", env: { CU_FIXTURE_OFFSET: "0,-120" } },
    ],
  });
  await claim(ctx);
  const pid = ctx.fixtures.pid("target");
  const view = await look(ctx, pid, TARGET_TITLE, false);
  const ref = refOf(view, byIdentifier("cu-dead-view"), "Dead View");
  begin(ctx);
  const pending = act(ctx, "click", {
    pid,
    lookId: view.lookId,
    policy: "background",
    action: "click",
    target: { ref },
    params: {},
  });
  await pause(100);
  const triggeredAt = Date.now();
  await ctx.fixtures.trigger(".cu-activate-other");
  const reply = await pending;
  await end(ctx, 500);
  await release(ctx);
  const other = await ctx.fixtures.rows("other");
  const activated = eventsIn(other, ["appActive"], ctx.window);
  const activatedAt = isNumber(activated[0]?.ts) ? activated[0].ts : undefined;
  ctx.notes.activationTriggeredAt = triggeredAt;
  ctx.notes.otherActivatedAt = activatedAt ?? null;
  return scoreJudgement({
    reply,
    target: await ctx.fixtures.rows("target"),
    window: ctx.window,
    interference: { observed: activatedAt !== undefined, reason: "activation_not_observed" },
  });
}

async function judgementControl(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, { targets: [{ label: "target", role: "target" }] });
  await claim(ctx);
  const pid = ctx.fixtures.pid("target");
  const view = await look(ctx, pid, TARGET_TITLE, false);
  const ref = refOf(view, byIdentifier("cu-custom-view"), "Custom View");
  begin(ctx);
  const reply = await act(ctx, "click", {
    pid,
    lookId: view.lookId,
    policy: "background",
    action: "click",
    target: { ref },
    params: {},
  });
  await end(ctx, 500);
  await release(ctx);
  return scoreJudgementControl({
    reply,
    target: await ctx.fixtures.rows("target"),
    window: ctx.window,
  });
}

export const CANCEL_MARGIN_MS = 50;

async function cancelResidual(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, { targets: [{ label: "target", role: "target" }] });
  await claim(ctx);
  const pid = ctx.fixtures.pid("target");
  const view = await look(ctx, pid, TARGET_TITLE, false);
  const ref = refOf(view, byIdentifier("cu-field"), "Field");
  const envelope = ctx.wire.actEnvelope();
  const text = "abcdefghij".repeat(60);
  begin(ctx);
  const pending = ctx.wire
    .send(
      "act",
      {
        ...envelope,
        pid,
        lookId: view.lookId,
        policy: "background",
        action: "typeText",
        target: { ref },
        params: { text },
      },
      { signal: ctx.signal, timeoutMs: 30_000 },
    )
    .catch(() => undefined);
  await pause(1_000);
  const cancel = await ctx.wire
    .send(
      "cancel",
      { target: envelope.requestId, session: { ...ctx.wire.session } },
      { signal: ctx.signal },
    )
    .catch(() => undefined);
  record(ctx, "cancel", "cancel", cancel?.reply);
  const actReply = (await pending)?.reply;
  record(ctx, "typeText", "act", actReply);
  await end(ctx, 1_500);
  await release(ctx);
  const ack = cancel && isJsonObject(cancel.reply.result) ? cancel.reply.result : undefined;
  const ackAt = cancel && isNumber(cancel.row.respondedAt) ? cancel.row.respondedAt : undefined;
  return scoreCancel({
    target: await ctx.fixtures.rows("target"),
    window: ctx.window,
    ack,
    ackAt,
    actReply,
    marginMs: CANCEL_MARGIN_MS,
  });
}

const holderSafe =
  "SAFE = the holder logged no keyDown/mouseDown and the helper refused with effectPossible:false";

export const scenarios: Scenario[] = [
  {
    id: "misdelivery.type_text",
    layer: "wire",
    timeoutMs: 60_000,
    asserts: `granted foreground typeText with a sticky holder; ${holderSafe}`,
    run: (ctx) => misdelivery(ctx, "type_text", true),
  },
  {
    id: "misdelivery.keypress",
    layer: "wire",
    timeoutMs: 60_000,
    asserts: `granted foreground keypress with a sticky holder; ${holderSafe}`,
    run: (ctx) => misdelivery(ctx, "keypress", true),
  },
  {
    id: "misdelivery.web_set_text",
    layer: "wire",
    timeoutMs: 60_000,
    asserts: `granted setText on a WKWebView input (keyboard-event path) with a sticky holder; ${holderSafe}`,
    run: (ctx) => misdelivery(ctx, "web_set_text", true),
  },
  {
    id: "misdelivery.click_covered",
    layer: "wire",
    timeoutMs: 60_000,
    asserts: `granted coordinate click while a sticky holder window covers the point; ${holderSafe}`,
    run: (ctx) => misdelivery(ctx, "click_covered", true),
  },
  {
    id: "misdelivery.control.type_text",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "control: the same granted typeText with a normal holder succeeds, the field gets the text, the holder gets no input",
    run: (ctx) => misdelivery(ctx, "type_text", false),
  },
  {
    id: "misdelivery.control.click_covered",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "control: the same covered coordinate click with a normal holder hits the custom view once, the holder gets no mouseDown",
    run: (ctx) => misdelivery(ctx, "click_covered", false),
  },
  {
    id: "restore.same_title",
    layer: "ts",
    timeoutMs: 90_000,
    asserts:
      "TS act_ui granted click while the holder has two same-titled windows and the second is key; SAFE = holder active with its second window key afterwards",
    run: restoreSameTitleTs,
  },
  {
    id: "restore.same_title.wire",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "raw getFrontmost, granted click, restoreUserFocus with everything getFrontmost reported; SAFE = holder active with its second window key",
    run: restoreSameTitleWire,
  },
  {
    id: "restore.target_window",
    layer: "ts",
    timeoutMs: 90_000,
    asserts:
      "target already frontmost on its second window; TS act_ui granted click in its main window; SAFE = target active with the second window key afterwards",
    run: restoreTargetWindow,
  },
  {
    id: "parallel.two_targets",
    layer: "ts",
    timeoutMs: 120_000,
    asserts:
      "two concurrent TS act_ui granted clicks on two target instances; SAFE = holder frontmost with its original key window, each custom view hit once, no user_switched",
    run: parallelTwoTargets,
  },
  {
    id: "judgement.noise",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "background pid click on a view that ignores clicks while unrelated pixels animate; SAFE = the helper does not answer worked",
    run: judgementNoise,
  },
  {
    id: "judgement.foreign_activation",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "background pid click on a view that ignores clicks while another fixture activates ~100 ms later; SAFE = the helper does not answer worked",
    run: judgementForeignActivation,
  },
  {
    id: "judgement.control",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "control: background pid click on the reactive custom view; the answer must not contradict the fixture (recorded either way)",
    run: judgementControl,
  },
  {
    id: "cancel.residual",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "raw 600-char background typeText cancelled after 1 s; SAFE = no fixture input later than the ack + 50 ms",
    run: cancelResidual,
  },
];
