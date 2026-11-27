import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";
import { fixtureApps } from "../fixture/build.ts";
import { command } from "../preflight.ts";
import { frontApp, type FixtureSet, type InstanceSpec } from "./fixtures.ts";
import {
  diagnosticsBlock,
  eventsIn,
  foreignActivation,
  focusState,
  scoreCancel,
  scoreControl,
  scoreJudgement,
  scoreJudgementControl,
  scoreMisdelivery,
  scoreParallel,
  scorePolicyBlocked,
  scorePolicyControl,
  scoreRestore,
  scoreExtendedClick,
  scoreExtendedInterrupted,
  scoreDeepAncestry,
  scoreExtendedKeyUnresolved,
  scoreExtendedMenu,
  scoreExtendedOwnWindowClick,
  scoreStandardControl,
  stringsIn,
  fixtureLayout,
  windowsAt,
  windowsOutside,
  type FixtureWindow,
  type PointRect,
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
  const placed = await fixtureWindows(ctx);
  ctx.notes.layout = {
    primary: placed.primary ?? null,
    windows: placed.windows.map((window) => ({ name: window.name, frame: window.frame })),
  };
  if (placed.defects.length > 0) throw new Blocked("layout: " + placed.defects.join("; "));
  const outside = placed.primary ? windowsOutside(placed.primary, placed.windows) : [];
  if (outside.length > 0)
    throw new Blocked("layout: not on the primary display: " + outside.join(", "));
}

async function fixtureWindows(
  ctx: ScenarioContext,
): Promise<{ primary?: PointRect; windows: FixtureWindow[]; defects: string[] }> {
  let primary: PointRect | undefined;
  const windows: FixtureWindow[] = [];
  const defects: string[] = [];
  for (const label of ctx.fixtures.instances.keys()) {
    const layout = fixtureLayout(label, await ctx.fixtures.rows(label));
    primary ??= layout.primary;
    windows.push(...layout.windows);
    defects.push(...layout.defects);
  }
  return { primary, windows, defects };
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
  const sentAt = Date.now();
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
  await ctx.fixtures.trigger(".cu-yield-holder", `${ctx.fixtures.pid("other")} other\n`);
  const reply = await pending;
  const answeredAt = Date.now();
  await end(ctx, 500);
  await release(ctx);
  const other = await ctx.fixtures.rows("other");
  const interference = foreignActivation(other, sentAt, answeredAt);
  ctx.notes.activationTriggeredAt = triggeredAt;
  ctx.notes.actSentAt = sentAt;
  ctx.notes.actAnsweredAt = answeredAt;
  ctx.notes.otherActivatedAt = interference.activatedAt ?? null;
  ctx.notes.holderYielded = eventsIn(
    await ctx.fixtures.rows("holder"),
    ["yieldActivation"],
    ctx.window,
  ).length;
  const result = reply && isJsonObject(reply.result) ? reply.result : undefined;
  const error = reply && isJsonObject(reply.error) ? reply.error : undefined;
  const evidence = result?.evidence ?? error?.evidence;
  ctx.notes.frontmostChangedElsewhere = isJsonObject(evidence)
    ? (evidence.frontmostChangedElsewhere ?? null)
    : null;
  return scoreJudgement({
    reply,
    target: await ctx.fixtures.rows("target"),
    window: ctx.window,
    interference,
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

const POLICY_TARGET_BUNDLE_ID = "com.choco-pi.FocusFixture";

async function policyLook(
  ctx: ScenarioContext,
  label: string,
  windowId: number,
  appBlocklist: JsonObject,
): Promise<JsonObject | undefined> {
  try {
    const { reply } = await ctx.wire.send(
      "look",
      { windowId, includeImage: true, readText: "never", appBlocklist },
      { signal: ctx.signal },
    );
    record(ctx, label, "look", reply);
    return reply;
  } catch (error) {
    if (!(error instanceof WireError)) throw error;
    record(ctx, label, "look", undefined);
    ctx.notes[`${label}TransportError`] = error.message;
    return undefined;
  }
}

async function policyWindowId(ctx: ScenarioContext, pid: number): Promise<number> {
  const listed = await ctx.wire.send("listWindows", { pid }, { signal: ctx.signal });
  const windows = Array.isArray(listed.reply.result) ? listed.reply.result : [];
  const window = windows.find((entry) => isJsonObject(entry) && entry.title === TARGET_TITLE);
  if (!isJsonObject(window) || !isNumber(window.windowId))
    throw new Blocked(`window-not-found: ${TARGET_TITLE}`);
  return window.windowId;
}

async function policyBlockedTarget(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, { targets: [{ label: "target", role: "target" }] });
  await claim(ctx);
  const pid = ctx.fixtures.pid("target");
  const view = await look(ctx, pid, TARGET_TITLE, false);
  const ref = refOf(view, byIdentifier("cu-increment"), "Increment");
  const windowId = await policyWindowId(ctx, pid);
  const byBundle = { bundleIds: [POLICY_TARGET_BUNDLE_ID.toUpperCase()], pids: [] };
  const byPid = { bundleIds: [], pids: [pid] };
  begin(ctx);
  const lookByBundle = await policyLook(ctx, "look_by_bundle", windowId, byBundle);
  const lookByPid = await policyLook(ctx, "look_by_pid", windowId, byPid);
  const press = (appBlocklist: JsonObject): JsonObject => ({
    pid,
    lookId: view.lookId,
    policy: "background",
    action: "press",
    target: { ref },
    params: {},
    appBlocklist,
  });
  const actByBundle = await act(ctx, "act_by_bundle", press(byBundle));
  const actByPid = await act(ctx, "act_by_pid", press(byPid));
  await end(ctx, 600);
  await release(ctx);
  return scorePolicyBlocked({
    replies: [
      { label: "look_by_bundle", cmd: "look", reply: lookByBundle },
      { label: "look_by_pid", cmd: "look", reply: lookByPid },
      { label: "act_by_bundle", cmd: "act", reply: actByBundle },
      { label: "act_by_pid", cmd: "act", reply: actByPid },
    ],
    target: await ctx.fixtures.rows("target"),
    window: ctx.window,
  });
}

async function policyControl(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, { targets: [{ label: "target", role: "target" }] });
  await claim(ctx);
  const pid = ctx.fixtures.pid("target");
  const windowId = await policyWindowId(ctx, pid);
  const empty = { bundleIds: [], pids: [] };
  begin(ctx);
  const lookReply = await policyLook(ctx, "look_empty_list", windowId, empty);
  const result = lookReply && isJsonObject(lookReply.result) ? lookReply.result : undefined;
  const lookId = result && isString(result.lookId) ? result.lookId : undefined;
  const node =
    result && isJsonObject(result.outline)
      ? findNode(result.outline, byIdentifier("cu-increment"))
      : undefined;
  let actReply: JsonObject | undefined;
  if (lookId && node && isString(node.ref))
    actReply = await act(ctx, "act_empty_list", {
      pid,
      lookId,
      policy: "background",
      action: "press",
      target: { ref: node.ref },
      params: {},
      appBlocklist: empty,
    });
  await end(ctx, 600);
  await release(ctx);
  return scorePolicyControl({
    look: lookReply,
    act: actReply,
    target: await ctx.fixtures.rows("target"),
    window: ctx.window,
  });
}

async function refOnlyWindow(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, {
    targets: [
      {
        label: "target",
        role: "target",
        env: { CU_FIXTURE_WINDOWS: "2", CU_FIXTURE_KEY_WINDOW: "2" },
      },
    ],
  });
  await claim(ctx);
  const pid = ctx.fixtures.pid("target");
  const listed = await ctx.wire.send("listWindows", { pid }, { signal: ctx.signal });
  const windows = Array.isArray(listed.reply.result) ? listed.reply.result : [];
  const main = windows.find((entry) => isJsonObject(entry) && entry.title === TARGET_TITLE);
  if (!isJsonObject(main) || !isString(main.windowRef))
    throw new Blocked(`window-not-found: ${TARGET_TITLE}`);
  const { reply: looked } = await ctx.wire.send(
    "look",
    { windowRef: main.windowRef, includeImage: false, readText: "never" },
    { signal: ctx.signal },
  );
  const result = isJsonObject(looked.result) ? looked.result : undefined;
  if (looked.ok !== true || !result || !isString(result.lookId) || !isJsonObject(result.outline))
    throw new Blocked(`look: ${errorCode(looked) ?? "invalid reply"}`);
  const window = isJsonObject(result.window) ? result.window : undefined;
  ctx.notes.lookWindowId = window && isNumber(window.windowId) ? window.windowId : null;
  if (window && isNumber(window.windowId) && window.windowId !== 0)
    throw new Blocked(`look-has-window-id: ${window.windowId}`);
  const view: Look = {
    lookId: result.lookId,
    outline: result.outline,
    frame: { x: 0, y: 0, w: 1, h: 1 },
  };
  const ref = refOf(view, byIdentifier("cu-field"), "Field");
  begin(ctx);
  const reply = await act(ctx, "keypress", {
    pid,
    lookId: view.lookId,
    ...GRANT,
    action: "keypress",
    target: { ref },
    params: { keys: ["x"] },
  });
  await end(ctx, 900);
  await release(ctx);
  const holder = await ctx.fixtures.rows("holder");
  const target = await ctx.fixtures.rows("target");
  ctx.notes.targetKeyWindows = eventsIn(target, ["windowKey"], ctx.window).map(
    (row) => `${String(row.window)}@${String(row.ts)}`,
  );
  const { effect, effectObserved } = intendedEffect("keypress", target, ctx.window);
  return scoreMisdelivery({ holder, target, window: ctx.window, reply, effectObserved, effect });
}

export const NOISE_DRAG_PATH = [
  { x: 270, y: 100 },
  { x: 40, y: -250 },
] as const;

async function judgementNoiseDrag(ctx: ScenarioContext): Promise<Score> {
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
  const view = await look(ctx, pid, TARGET_TITLE, true);
  const node = findNode(view.outline, byIdentifier("cu-dead-view"));
  const rect = node && frameOf(node.rect);
  if (!rect || !view.imageWidth) throw new Blocked("element-not-found: dead view rect");
  const scale = view.imageWidth / view.frame.w;
  const path = NOISE_DRAG_PATH.map((offset) => ({
    x: rect.x + offset.x * scale,
    y: rect.y + offset.y * scale,
  }));
  ctx.notes.dragPath = path;
  const start = path[0]!;
  begin(ctx);
  const reply = await act(ctx, "drag", {
    pid,
    lookId: view.lookId,
    policy: "background",
    action: "drag",
    target: { x: start.x, y: start.y },
    params: { path },
  });
  await end(ctx, 500);
  await release(ctx);
  const target = await ctx.fixtures.rows("target");
  const result = reply && isJsonObject(reply.result) ? reply.result : undefined;
  const error = reply && isJsonObject(reply.error) ? reply.error : undefined;
  const evidence = result?.evidence ?? error?.evidence;
  ctx.notes.pixelEvidence = isJsonObject(evidence) ? evidence : null;
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

export const CANCEL_MARGIN_MS = 50;
const LONG_TEXT = "abcdefghij".repeat(60);

async function cancelResidual(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, { targets: [{ label: "target", role: "target" }] });
  await claim(ctx);
  const pid = ctx.fixtures.pid("target");
  const view = await look(ctx, pid, TARGET_TITLE, true);
  const ref = refOf(view, byIdentifier("cu-field"), "Field");
  const point = centreOf(view, "cu-field", "Field");
  const focus = await act(ctx, "focus", {
    pid,
    lookId: view.lookId,
    policy: "background",
    action: "typeText",
    target: { ref },
    params: { text: "_" },
  });
  if (focus?.ok !== true)
    throw new Blocked(`focus: ${focus ? (errorCode(focus) ?? "failed") : "no reply"}`);
  await pause(300);
  const envelope = ctx.wire.actEnvelope();
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
        target: point,
        params: { text: LONG_TEXT },
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

const EXTENDED = { policy: "background", backgroundDelivery: "extended" };

async function requireExtended(ctx: ScenarioContext): Promise<void> {
  const { reply } = await ctx.wire.send("diagnostics", {}, { signal: ctx.signal });
  const result = isJsonObject(reply.result) ? reply.result : undefined;
  const capability =
    result && isJsonObject(result.extendedDelivery) ? result.extendedDelivery : undefined;
  ctx.notes.extendedCapability = capability ?? null;
  if (capability?.available !== true)
    throw new Blocked("extended_unavailable: " + String(capability?.reason ?? "not reported"));
}

function centreOf(view: Look, identifier: string, what: string) {
  const node = findNode(view.outline, byIdentifier(identifier));
  const rect = node && frameOf(node.rect);
  if (!rect || !view.imageWidth) throw new Blocked("element-not-found: " + what + " rect");
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

async function extendedCustomClick(
  ctx: ScenarioContext,
  delivery: "extended" | "standard",
): Promise<Score> {
  await launch(ctx, { targets: [{ label: "target", role: "target" }] });
  if (delivery === "extended") await requireExtended(ctx);
  await claim(ctx);
  const pid = ctx.fixtures.pid("target");
  const view = await look(ctx, pid, TARGET_TITLE, true);
  const point = centreOf(view, "cu-custom-view", "custom view");
  begin(ctx);
  const reply = await act(ctx, "click", {
    pid,
    lookId: view.lookId,
    ...(delivery === "extended" ? EXTENDED : { policy: "background" }),
    action: "click",
    target: point,
    params: {},
  });
  await end(ctx, 900);
  await release(ctx);
  const holder = await ctx.fixtures.rows("holder");
  const target = await ctx.fixtures.rows("target");
  if (delivery === "standard")
    return scoreStandardControl({ holder, target, window: ctx.window, reply });
  return scoreExtendedClick({
    holder,
    targets: [{ label: "target", rows: target, reply }],
    window: ctx.window,
  });
}

async function extendedParallel(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, {
    targets: [
      { label: "a", role: "target" },
      { label: "b", role: "target", env: { CU_FIXTURE_OFFSET: "500,0" } },
    ],
  });
  await requireExtended(ctx);
  await claim(ctx);
  const views = await Promise.all(
    ["a", "b"].map(async (label) => {
      const pid = ctx.fixtures.pid(label);
      const view = await look(ctx, pid, TARGET_TITLE, true);
      return { label, pid, view, point: centreOf(view, "cu-custom-view", label + " custom view") };
    }),
  );
  begin(ctx);
  const replies = await Promise.all(
    views.map(({ label, pid, view, point }) =>
      act(ctx, label, {
        pid,
        lookId: view.lookId,
        ...EXTENDED,
        action: "click",
        target: point,
        params: {},
      }),
    ),
  );
  await end(ctx, 900);
  await release(ctx);
  return scoreExtendedClick({
    holder: await ctx.fixtures.rows("holder"),
    targets: await Promise.all(
      views.map(async ({ label }, index) => ({
        label,
        rows: await ctx.fixtures.rows(label),
        reply: replies[index],
      })),
    ),
    window: ctx.window,
  });
}

async function extendedInterrupted(
  ctx: ScenarioContext,
  reason: "cancelled" | "deadline",
): Promise<Score> {
  await launch(ctx, {
    targets: [{ label: "target", role: "target", env: { CU_FIXTURE_WEB: "1" } }],
  });
  if (!(await ctx.fixtures.waitFor("target", (row) => row.event === "webReady", 10_000)))
    throw new Blocked("web-not-ready");
  await requireExtended(ctx);
  await claim(ctx);
  const pid = ctx.fixtures.pid("target");
  const view = await lookWeb(ctx, pid);
  const ref = refOf(view, isWebInput, "web text input");
  const envelope = ctx.wire.actEnvelope(reason === "deadline" ? 1_500 : 60_000);
  begin(ctx);
  const pending = ctx.wire
    .send(
      "act",
      {
        ...envelope,
        pid,
        lookId: view.lookId,
        ...EXTENDED,
        action: "typeText",
        target: { ref },
        params: { text: LONG_TEXT },
      },
      { signal: ctx.signal, timeoutMs: 30_000 },
    )
    .catch(() => undefined);
  let stopAt: number | undefined;
  if (reason === "cancelled") {
    await pause(1_000);
    const cancel = await ctx.wire
      .send(
        "cancel",
        { target: envelope.requestId, session: { ...ctx.wire.session } },
        { signal: ctx.signal },
      )
      .catch(() => undefined);
    record(ctx, "cancel", "cancel", cancel?.reply);
    const ack = cancel && isJsonObject(cancel.reply.result) ? cancel.reply.result : undefined;
    ctx.notes.ack = ack ?? null;
    if (cancel && ack?.acknowledged === true && isNumber(cancel.row.respondedAt))
      stopAt = cancel.row.respondedAt;
  }
  const sent = await pending;
  const reply = sent?.reply;
  record(ctx, "typeText", "act", reply);
  if (reason === "deadline" && sent && isNumber(sent.row.respondedAt))
    stopAt = sent.row.respondedAt;
  await end(ctx, 1_200);
  await release(ctx);
  return scoreExtendedInterrupted({
    holder: await ctx.fixtures.rows("holder"),
    target: await ctx.fixtures.rows("target"),
    window: ctx.window,
    reply,
    reason,
    stopAt,
    marginMs: CANCEL_MARGIN_MS,
  });
}

type PopupCover = "none" | "holder" | "own_window";

const MATRIX_APPKIT_TITLE = "CU Matrix AppKit";

const POPUP_TARGET_ENV = {
  none: { CU_FIXTURE_MATRIX: "1" },
  holder: { CU_FIXTURE_MATRIX: "1" },
  own_window: { CU_FIXTURE_MATRIX: "1", CU_FIXTURE_MATRIX_OVERLAP: "1" },
} satisfies Record<PopupCover, Record<string, string>>;

type ScreenPoint = { x: number; y: number };

function screenPointOf(view: Look, point: { x: number; y: number }): ScreenPoint {
  const scale = view.imageWidth ? view.frame.w / view.imageWidth : 1;
  return { x: view.frame.x + point.x * scale, y: view.frame.y + point.y * scale };
}

async function requireCover(
  ctx: ScenarioContext,
  view: Look,
  point: { x: number; y: number },
  observed: string,
  expected: string[],
): Promise<void> {
  const at = screenPointOf(view, point);
  const placed = await fixtureWindows(ctx);
  const covering = windowsAt(at, placed.windows, observed);
  const wanted = [...expected].sort();
  ctx.notes.cover = { point: at, observed, covering, expected: wanted };
  if (covering.join(",") !== wanted.join(","))
    throw new Blocked(
      `layout: point (${at.x},${at.y}) of ${observed} is under [${covering.join(", ")}], expected [${wanted.join(", ")}]`,
    );
}

async function coverWithHolder(ctx: ScenarioContext, view: Look, identifier: string, what: string) {
  const node = findNode(view.outline, byIdentifier(identifier));
  const rect = node && frameOf(node.rect);
  if (!rect || !view.imageWidth) throw new Blocked("element-not-found: " + what + " rect");
  const scale = view.frame.w / view.imageWidth;
  const screen = [
    view.frame.x + rect.x * scale,
    view.frame.y + rect.y * scale,
    rect.w * scale,
    rect.h * scale,
  ];
  ctx.notes.coveredScreenRect = screen;
  await ctx.fixtures.trigger(".cu-cover-holder", screen.map((value) => value.toFixed(1)).join(","));
  if (!(await ctx.fixtures.waitFor("holder", (row) => row.event === "covered", 3_000)))
    throw new Blocked("holder-did-not-cover");
  await pause(400);
  const front = await frontApp();
  if (front?.pid !== ctx.fixtures.pid("holder"))
    throw new Blocked("holder-not-frontmost after cover");
}

async function extendedPopup(ctx: ScenarioContext, cover: PopupCover): Promise<Score> {
  await launch(ctx, {
    targets: [{ label: "target", role: "target", env: POPUP_TARGET_ENV[cover] }],
    holderEnv: { CU_FIXTURE_OFFSET: "0,-400" },
  });
  await requireExtended(ctx);
  await claim(ctx);
  const pid = ctx.fixtures.pid("target");
  const view = await look(ctx, pid, MATRIX_APPKIT_TITLE, true);
  const point = centreOf(view, "cu-popup", "pop-up button");
  if (cover === "holder") await coverWithHolder(ctx, view, "cu-popup", "pop-up button");
  const expected = { none: [], holder: ["holder:main"], own_window: ["target:swiftui"] }[cover];
  await requireCover(ctx, view, point, "target:appkit", expected);
  begin(ctx);
  const reply = await act(ctx, "click", {
    pid,
    lookId: view.lookId,
    ...EXTENDED,
    action: "click",
    target: point,
    params: {},
  });
  await end(ctx, 900);
  await release(ctx);
  return scoreExtendedMenu({
    holder: await ctx.fixtures.rows("holder"),
    target: await ctx.fixtures.rows("target"),
    window: ctx.window,
    reply,
  });
}

async function extendedCustomClickCovered(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, { targets: [{ label: "target", role: "target" }] });
  await requireExtended(ctx);
  await claim(ctx);
  const pid = ctx.fixtures.pid("target");
  const view = await look(ctx, pid, TARGET_TITLE, true);
  const point = centreOf(view, "cu-custom-view", "custom view");
  await coverWithHolder(ctx, view, "cu-custom-view", "custom view");
  await requireCover(ctx, view, point, "target:main", ["holder:main"]);
  begin(ctx);
  const reply = await act(ctx, "click", {
    pid,
    lookId: view.lookId,
    ...EXTENDED,
    action: "click",
    target: point,
    params: {},
  });
  await end(ctx, 900);
  await release(ctx);
  return scoreExtendedClick({
    holder: await ctx.fixtures.rows("holder"),
    targets: [{ label: "target", rows: await ctx.fixtures.rows("target"), reply }],
    window: ctx.window,
  });
}

async function extendedOwnWindowClick(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, {
    targets: [
      {
        label: "target",
        role: "target",
        env: { CU_FIXTURE_MATRIX: "1", CU_FIXTURE_MATRIX_OVERLAP: "1" },
      },
    ],
    holderEnv: { CU_FIXTURE_OFFSET: "0,-400" },
  });
  await requireExtended(ctx);
  await claim(ctx);
  const pid = ctx.fixtures.pid("target");
  const view = await look(ctx, pid, MATRIX_APPKIT_TITLE, true);
  const point = centreOf(view, "cu-drag", "drag view");
  await requireCover(ctx, view, point, "target:appkit", ["target:swiftui"]);
  begin(ctx);
  const reply = await act(ctx, "click", {
    pid,
    lookId: view.lookId,
    ...EXTENDED,
    action: "click",
    target: point,
    params: {},
  });
  await end(ctx, 900);
  await release(ctx);
  return scoreExtendedOwnWindowClick({
    holder: await ctx.fixtures.rows("holder"),
    target: await ctx.fixtures.rows("target"),
    window: ctx.window,
    reply,
    observedWindow: "appkit",
  });
}

async function extendedKeyWindowUnresolved(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, {
    targets: [{ label: "target", role: "target", env: { CU_FIXTURE_UNPAIRED_WINDOW: "1" } }],
  });
  await requireExtended(ctx);
  await claim(ctx);
  const pid = ctx.fixtures.pid("target");
  const unpairedRow = (await ctx.fixtures.rows("target")).find(
    (row) => row.event === "unpairedWindow",
  );
  const unpairedId =
    unpairedRow && isNumber(unpairedRow.windowNumber) ? unpairedRow.windowNumber : undefined;
  if (unpairedId === undefined) throw new Blocked("unpaired-window-not-logged");
  const listed = await ctx.wire.send("listWindows", { pid }, { signal: ctx.signal });
  const windows = Array.isArray(listed.reply.result)
    ? listed.reply.result.filter(isJsonObject)
    : [];
  ctx.notes.listedWindows = windows.map((entry) => ({
    title: entry.title ?? null,
    windowId: entry.windowId ?? null,
    windowRef: entry.windowRef ?? null,
  }));
  if (windows.some((entry) => entry.windowId === unpairedId && isString(entry.windowRef)))
    throw new Blocked("unpaired-window-paired-by-helper");
  const alias = windows.find((entry) => entry.title === "AX Alias");
  if (!alias || !isString(alias.windowRef) || (alias.windowId ?? null) !== null)
    throw new Blocked("unpaired-window-alias-not-listed");
  const first = await look(ctx, pid, TARGET_TITLE, false);
  const ref = refOf(first, byIdentifier("cu-field"), "Field");
  const unresolved = await ctx.wire.send(
    "look",
    { windowId: unpairedId, windowRef: alias.windowRef, includeImage: false, readText: "never" },
    { signal: ctx.signal },
  );
  record(ctx, "unresolved_look", "look", unresolved.reply);
  const result = isJsonObject(unresolved.reply.result) ? unresolved.reply.result : undefined;
  if (unresolved.reply.ok !== true || !result || !isString(result.lookId))
    throw new Blocked("unresolved-look: " + (errorCode(unresolved.reply) ?? "invalid reply"));
  const lookId = result.lookId;
  begin(ctx);
  const reply = await act(ctx, "keypress", {
    pid,
    lookId,
    ...EXTENDED,
    action: "keypress",
    target: { ref },
    params: { keys: ["x"] },
  });
  await end(ctx, 900);
  await release(ctx);
  return scoreExtendedKeyUnresolved({
    holder: await ctx.fixtures.rows("holder"),
    target: await ctx.fixtures.rows("target"),
    window: ctx.window,
    reply,
  });
}

export const NOISE_DRAG_TARGET_POINT = { x: 210, y: -250 } as const;
export const QUIET_DRAG_PATH = [
  { x: 30, y: 60 },
  { x: 250, y: 60 },
] as const;

async function judgementNoiseDragTarget(ctx: ScenarioContext): Promise<Score> {
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
  const view = await look(ctx, pid, TARGET_TITLE, true);
  const node = findNode(view.outline, byIdentifier("cu-dead-view"));
  const rect = node && frameOf(node.rect);
  if (!rect || !view.imageWidth) throw new Blocked("element-not-found: dead view rect");
  const scale = view.imageWidth / view.frame.w;
  const at = (offset: { x: number; y: number }) => ({
    x: rect.x + offset.x * scale,
    y: rect.y + offset.y * scale,
  });
  const path = QUIET_DRAG_PATH.map(at);
  const point = at(NOISE_DRAG_TARGET_POINT);
  ctx.notes.dragPath = path;
  ctx.notes.targetPoint = point;
  begin(ctx);
  const reply = await act(ctx, "drag", {
    pid,
    lookId: view.lookId,
    policy: "background",
    action: "drag",
    target: point,
    params: { path },
  });
  await end(ctx, 500);
  await release(ctx);
  const target = await ctx.fixtures.rows("target");
  const result = reply && isJsonObject(reply.result) ? reply.result : undefined;
  const error = reply && isJsonObject(reply.error) ? reply.error : undefined;
  const evidence = result?.evidence ?? error?.evidence;
  ctx.notes.pixelEvidence = isJsonObject(evidence) ? evidence : null;
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

export const ANCESTRY_CHAIN_DEPTH = 80;

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function chainBetween(leaf: number, root: number): Promise<number[]> {
  const table = await command("ps", ["-A", "-o", "pid=,ppid="]);
  const parent = new Map<number, number>();
  for (const line of table.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (
      pid !== undefined &&
      ppid !== undefined &&
      Number.isSafeInteger(pid) &&
      Number.isSafeInteger(ppid)
    )
      parent.set(pid, ppid);
  }
  const chain: number[] = [];
  for (let current = leaf; current > 1 && chain.length < 1_000;) {
    if (current === root) return chain;
    chain.push(current);
    const next = parent.get(current);
    if (next === undefined) return [];
    current = next;
  }
  return [];
}

async function policyDeepAncestry(ctx: ScenarioContext): Promise<Score> {
  await launch(ctx, {
    targets: [
      {
        label: "target",
        role: "target",
        env: { CU_FIXTURE_SPAWN_CHAIN: String(ANCESTRY_CHAIN_DEPTH) },
      },
    ],
  });
  const pid = ctx.fixtures.pid("target");
  const leafFile = join(ctx.fixtures.dir, "chain-leaf.pid");
  let leaf: number | undefined;
  for (let attempt = 0; attempt < 50 && leaf === undefined; attempt += 1) {
    const text = await readFile(leafFile, "utf8").catch(() => "");
    const parsed = Number(text.trim());
    if (text.trim() !== "" && Number.isSafeInteger(parsed) && parsed > 1) leaf = parsed;
    else await pause(100);
  }
  if (leaf === undefined) throw new Blocked("chain-not-spawned");
  const chain = await chainBetween(leaf, pid);
  try {
    ctx.notes.chainLength = chain.length;
    if (chain.length <= 64) throw new Blocked("chain-too-short: " + String(chain.length));
    await claim(ctx);
    const windowId = await policyWindowId(ctx, pid);
    begin(ctx);
    const control = await policyLook(ctx, "look_client_harness", windowId, {
      bundleIds: [],
      pids: [],
      clientPid: process.pid,
    });
    const blocked = await policyLook(ctx, "look_client_deep", windowId, {
      bundleIds: [],
      pids: [],
      clientPid: leaf,
    });
    await end(ctx, 400);
    await release(ctx);
    return scoreDeepAncestry({
      control,
      blocked,
      targetPid: pid,
      depth: chain.length,
      target: await ctx.fixtures.rows("target"),
      window: ctx.window,
    });
  } finally {
    for (const shell of chain) killIfAlive(shell);
  }
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
    id: "misdelivery.ref_only_window",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "target with two windows (the second becomes key on activation), look by AX window ref only (no window id), granted keypress x on the main window's field; SAFE = refused without input, or the field gets x; delivered without that effect (input to the other window) fails",
    run: refOnlyWindow,
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
    id: "judgement.noise_drag",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "background pid coordinate drag across the view that ignores input, diagonally past an animating box that lies inside the drag's bounding box but away from its path; SAFE = the helper does not answer worked",
    run: judgementNoiseDrag,
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
    id: "policy.blocked_target",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "look (image requested) and background AXPress on Increment with the fixture's bundle id, then its pid, in appBlocklist; SAFE = every request refused app_blocked (effectPossible:false, inputSent:false for acts), no observation returned, and the fixture logged no input or activation",
    run: policyBlockedTarget,
  },
  {
    id: "policy.control",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "control: the same look and background press with an empty appBlocklist work, and the fixture records one increment",
    run: policyControl,
  },
  {
    id: "cancel.residual",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "raw 600-char background typeText at the focused field's point (no ref, so one pid key event per character) cancelled after 1 s; SAFE = no fixture input later than the ack + 50 ms",
    run: cancelResidual,
  },
  {
    id: "extended.custom_click",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "background coordinate click on the custom view (no AXPress) with backgroundDelivery extended; SAFE = extended delivery used, exactly one hit, the answer is not a no-effect claim, the holder logs no appInactive/windowResignKey/keyDown/mouseDown, and the target does not believe it is active afterwards",
    run: (ctx) => extendedCustomClick(ctx, "extended"),
  },
  {
    id: "extended.control.standard",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "control: the same coordinate click without backgroundDelivery is refused foreground_required as today, with no hit, no target activation, no extended field, and an undisturbed holder",
    run: (ctx) => extendedCustomClick(ctx, "standard"),
  },
  {
    id: "extended.parallel_two_targets",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "two concurrent extended coordinate clicks on two targets' custom views; SAFE = each hit exactly once, both deactivated afterwards, holder undisturbed",
    run: extendedParallel,
  },
  {
    id: "extended.cancel",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "extended 600-char typeText into the web input (one pid key event per character) cancelled after 1 s; SAFE = cancelled with extendedDelivery used, no fixture input later than the ack + 50 ms, the target was activated and does not believe it is active afterwards, holder undisturbed",
    run: (ctx) => extendedInterrupted(ctx, "cancelled"),
  },
  {
    id: "extended.deadline",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "extended 600-char typeText into the web input with a 1.5 s budget; SAFE = stopped at its deadline with extendedDelivery used, no fixture input later than the reply + 50 ms, the target does not believe it is active afterwards, holder undisturbed",
    run: (ctx) => extendedInterrupted(ctx, "deadline"),
  },
  {
    id: "extended.popup",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "extended coordinate click on a pop-up button; SAFE = extendedDelivery not_applicable (menu_element), the target is never told it is active, holder undisturbed",
    run: (ctx) => extendedPopup(ctx, "none"),
  },
  {
    id: "extended.key_window_unresolved",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "extended keypress on a look whose window the helper cannot resolve (its AX element cannot be paired with its window id; root scoped to the field); SAFE = refused before any key (keyWindowAcquired:false, observedWindowResolved:false), no key reached the target, target deactivated, holder undisturbed",
    run: extendedKeyWindowUnresolved,
  },
  {
    id: "extended.popup_covered",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "extended coordinate click on the pop-up button while the holder's window covers it; SAFE = extendedDelivery not_applicable (menu_element, read from the target's own tree), the target is never told it is active, holder undisturbed",
    run: (ctx) => extendedPopup(ctx, "holder"),
  },
  {
    id: "extended.popup_own_window",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "extended coordinate click on the pop-up button while the target's own SwiftUI window lies on top at the point; SAFE = extendedDelivery not_applicable (menu_element, read from the observed window's tree), the target is never told it is active, holder undisturbed",
    run: (ctx) => extendedPopup(ctx, "own_window"),
  },
  {
    id: "extended.custom_click_covered",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "extended coordinate click on the custom view while the holder's window covers it; SAFE = extended delivery used, exactly one hit, the answer is not a no-effect claim, the holder logs no appInactive/windowResignKey/keyDown/mouseDown, and the target does not believe it is active afterwards",
    run: extendedCustomClickCovered,
  },
  {
    id: "extended.own_window_click",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "extended coordinate click on the AppKit matrix window's drag view while the target's own SwiftUI window lies on top at the point; SAFE = extended delivery used, exactly one drag-view press, no mouse-down in another target window and no SwiftUI control reacting, not a no-effect claim, target deactivated afterwards, holder undisturbed",
    run: extendedOwnWindowClick,
  },
  {
    id: "judgement.noise_drag_target",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "background pid drag along a quiet path inside the view that ignores input, with its separate target point on the animating box; SAFE = the helper does not answer worked (the region is the path only)",
    run: judgementNoiseDragTarget,
  },
  {
    id: "policy.deep_ancestry",
    layer: "wire",
    timeoutMs: 60_000,
    asserts:
      "look with clientPid under a chain of 80 shells below the target (control: clientPid = the harness); SAFE = the control observes and the deep-client look is refused app_blocked (blockMatch pid, the target), no observation, no fixture input",
    run: policyDeepAncestry,
  },
];
