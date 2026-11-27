import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { arch } from "node:os";
import { join, resolve } from "node:path";
import {
  createExtensionRuntime,
  type AgentToolResult,
  type ExtensionContext,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { UiAction } from "../../src/contract.ts";
import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";
import { unregisterFixture } from "../desktop.ts";
import { buildFixture, fixtureApps } from "../fixture/build.ts";
import { socketBusy } from "../preflight.ts";
import { parseScreens, type Screen } from "./displays-score.ts";
import { FixtureSet, frontApp, sweepFixtureProcesses, type FrontApp } from "./fixtures.ts";
import { GuardProxy } from "./guard-proxy.ts";
import {
  countEvents,
  customHitsSince,
  frontmostRows,
  lastActivation,
  offSpaceCheck,
  parseSpaces,
  spacesUnchangedCheck,
  typedOnceCheck,
  verdictOf,
  type Check,
  type SpacesState,
} from "./offspace-score.ts";
import { checkHelper } from "./scenarios.ts";
import { isMainHelper } from "./score.ts";
import { sanitize } from "./ts-layer.ts";
import { RequestLog, Wire } from "./wire.ts";

interface Options {
  helperApp: string;
  helperSocket: string;
  out: string;
  display?: number;
}

class ArgumentError extends Error {}
class Abort extends Error {
  partial?: { id: string; checks: Check[]; notes: JsonObject };
}
class StepFailed extends Error {}
class Skip extends Error {}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const MAIN_TITLE = fixtureApps.target.title;
const TARGET_BUNDLE = fixtureApps.target.bundleId;
const SET_TEXT = "24680";
const TYPED = "13579";

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
      "usage: offspace.ts --helper-app <app> --helper-socket <socket> --out <dir> [--display <id>]",
    );
  const display = value("--display");
  if (display !== undefined && !Number.isSafeInteger(Number(display)))
    throw new ArgumentError("--display takes a display id");
  return {
    helperApp: resolve(helperApp),
    helperSocket: resolve(helperSocket),
    out: resolve(out),
    display: display === undefined ? undefined : Number(display),
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

async function createContext(cwd: string): Promise<ExtensionContext> {
  const runtime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => undefined,
      delete: async () => undefined,
    },
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(
    [],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(runtime),
  );
  return runner.createContext();
}

interface Outcome {
  text: string;
  details?: JsonObject;
  error?: string;
}

interface TsLayer {
  find(pid: number): Promise<Outcome>;
  observe(root: string): Promise<Outcome>;
  act(stateId: string, actions: UiAction[]): Promise<Outcome>;
  configure(values: JsonObject): Promise<void>;
  reset(): Promise<void>;
}

async function loadTs(
  socket: string,
  helperApp: string,
  agentDir: string,
  cwd: string,
): Promise<TsLayer> {
  process.env.PI_CU_SOCKET_PATH = socket;
  process.env.PI_COMPUTER_USE_HELPER_APP_PATH = helperApp;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_COMPUTER_USE_HEADLESS = "0";
  process.env.PI_COMPUTER_USE_BROWSER_USE = "0";
  process.env.PI_COMPUTER_USE_RESTORE_FOCUS = "1";
  for (const name of [
    "PI_COMPUTER_USE_FOREGROUND_GRANT",
    "PI_COMPUTER_USE_FOREGROUND_PROMPT",
    "PI_COMPUTER_USE_DELIVERY_POLICY",
    "PI_COMPUTER_USE_EVENT_DELIVERY",
    "PI_COMPUTER_USE_BACKGROUND_DELIVERY",
    "PI_COMPUTER_USE_BLOCKED_APPS",
    "PI_COMPUTER_USE_UNBLOCKED_APPS",
  ])
    delete process.env[name];
  const configDir = join(agentDir, "extensions");
  await mkdir(configDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const helper = await import("../../src/platform/macos/helper.ts");
  if (helper.HELPER_SOCKET_PATH !== socket)
    throw new Error("TS helper socket is " + helper.HELPER_SOCKET_PATH + ", expected " + socket);
  const bridge = await import("../../src/bridge.ts");
  const permissions = await import("../../src/platform/macos/permissions.ts");
  let ctx: ExtensionContext | undefined;
  const context = async (): Promise<ExtensionContext> => {
    ctx ??= await createContext(cwd);
    return ctx;
  };
  const run = async <T>(call: () => Promise<AgentToolResult<T>>): Promise<Outcome> => {
    try {
      const result = await call();
      const parsed: JsonValue = JSON.parse(JSON.stringify(result.details ?? null));
      const text = result.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      return isJsonObject(parsed) ? { text, details: parsed } : { text };
    } catch (error) {
      return { text: "", error: error instanceof Error ? error.message : String(error) };
    }
  };
  const signal = (): AbortSignal => AbortSignal.timeout(30_000);
  return {
    find: async (pid) =>
      run(async () =>
        bridge.executeFind("offspace-find", { pid }, signal(), undefined, await context()),
      ),
    observe: async (root) =>
      run(async () =>
        bridge.executeObserve("offspace-observe", { root }, signal(), undefined, await context()),
      ),
    act: async (stateId, actions) =>
      run(async () =>
        bridge.executeAct(
          "offspace-act",
          { stateId, actions },
          signal(),
          undefined,
          await context(),
        ),
      ),
    configure: async (values) => {
      await writeFile(join(configDir, "pi-computer-use.json"), JSON.stringify(values));
    },
    reset: async () => {
      await bridge.shutdownComputerUseSession().catch(() => undefined);
      await permissions.releaseMacosOwnership(AbortSignal.timeout(1_000)).catch(() => false);
      ctx = undefined;
    },
  };
}

function rootOf(outcome: Outcome, pid: number): JsonObject | undefined {
  const windows = outcome.details?.windows;
  if (!Array.isArray(windows)) return undefined;
  return windows.find(
    (window): window is JsonObject =>
      isJsonObject(window) && window.pid === pid && window.windowTitle === MAIN_TITLE,
  );
}

function stateIdOf(outcome: Outcome): string | undefined {
  return /\bstate(?:_id)? ([0-9a-f-]{36})\b/i.exec(outcome.text)?.[1];
}

function nodeOf(outcome: Outcome, identifier: string): JsonObject | undefined {
  const outline = outcome.details?.outline;
  const root = isJsonObject(outline) ? outline.root : undefined;
  const queue: JsonValue[] = root === undefined ? [] : [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!isJsonObject(node)) continue;
    if (node.identifier === identifier) return node;
    if (Array.isArray(node.children)) queue.push(...node.children);
  }
  return undefined;
}

function centreOf(node: JsonObject | undefined): { x: number; y: number } | undefined {
  const rect = node?.rect;
  if (
    !isJsonObject(rect) ||
    !isNumber(rect.x) ||
    !isNumber(rect.y) ||
    !isNumber(rect.w) ||
    !isNumber(rect.h)
  )
    return undefined;
  return { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) };
}

function reduce(outcome: Outcome): JsonObject {
  const reduced: JsonObject = { text: outcome.text.split("\n").slice(0, 3).join("\n") };
  if (outcome.error) reduced.error = outcome.error;
  const details = outcome.details;
  if (details) {
    const kept: JsonObject = {};
    for (const key of ["off_space", "status", "execution", "windows"]) {
      if (details[key] !== undefined) kept[key] = sanitize(details[key]) ?? null;
    }
    reduced.details = kept;
  }
  return reduced;
}

interface ScenarioResult {
  id: string;
  verdict: "PASS" | "FAIL" | "SKIP";
  reason?: string;
  checks: Check[];
  notes: JsonObject;
}

class Run {
  readonly wire: Wire;
  readonly fixtures: FixtureSet;
  readonly ts: TsLayer;
  readonly tsLog: RequestLog;
  readonly frontBefore: FrontApp | undefined;
  readonly screen: Screen;
  baseline?: SpacesState;
  private seq = 0;

  constructor(
    wire: Wire,
    fixtures: FixtureSet,
    ts: TsLayer,
    tsLog: RequestLog,
    frontBefore: FrontApp | undefined,
    screen: Screen,
  ) {
    this.wire = wire;
    this.fixtures = fixtures;
    this.ts = ts;
    this.tsLog = tsLog;
    this.frontBefore = frontBefore;
    this.screen = screen;
  }

  async launch(label: string, env: Record<string, string> = {}): Promise<number> {
    await this.fixtures.launch({
      label,
      role: "target",
      env: { CU_FIXTURE_ORIGIN: this.screen.bounds.x + "," + this.screen.bounds.y, ...env },
    });
    await pause(500);
    return this.fixtures.pid(label);
  }

  async spaces(label: string): Promise<SpacesState | undefined> {
    const seq = ++this.seq;
    await this.fixtures.trigger(".cu-spaces-" + label, seq + "\n");
    const row = await this.fixtures.waitFor(
      label,
      (candidate) => candidate.event === "spaces" && candidate.seq === seq,
      4_000,
    );
    return parseSpaces(row);
  }

  async allRows(): Promise<JsonObject[]> {
    const rows: JsonObject[] = [];
    for (const label of this.fixtures.instances.keys())
      rows.push(...(await this.fixtures.rows(label)));
    return rows;
  }

  async guard(
    checks: Check[],
    label: string,
    step: string,
    visible = false,
  ): Promise<SpacesState | undefined> {
    const state = await this.spaces(label);
    if (!visible) checks.push(offSpaceCheck(step + ": window off-Space", state));
    const baseline = this.baseline;
    const spaces = baseline
      ? spacesUnchangedCheck(step + ": every display's current Space unchanged", baseline, state)
      : { name: step + ": baseline", ok: false };
    checks.push(spaces);
    const front = await frontApp();
    const frontOk = front?.pid !== undefined && front.pid === this.frontBefore?.pid;
    checks.push({
      name: step + ": frontmost pid unchanged",
      ok: frontOk,
      detail: {
        before: this.frontBefore?.pid ?? null,
        after: front?.pid ?? null,
        fixtureFrontPid: state?.frontPid ?? null,
      },
    });
    const activations = frontmostRows(await this.allRows());
    checks.push({
      name: step + ": no fixture frontmost row",
      ok: activations.length === 0,
      detail: { rows: activations.map((row) => ({ ...row })) },
    });
    if (!spaces.ok || !frontOk)
      throw new Abort(
        step +
          ": " +
          (spaces.ok ? "the frontmost app changed" : "a display's current Space changed"),
      );
    return state;
  }

  expect(checks: Check[], name: string, ok: boolean, detail?: JsonObject): void {
    checks.push(detail ? { name, ok, detail } : { name, ok });
    if (!ok) throw new StepFailed(name);
  }

  async moveOffSpace(label: string): Promise<void> {
    await this.fixtures.trigger(".cu-space-" + label, "auto\n");
    const moved = await this.fixtures.waitFor(label, (row) => row.event === "spaceMove", 4_000);
    if (!moved || moved.moved !== true || moved.space === -1)
      throw new Skip(
        "no desktop Space of display " +
          this.screen.id +
          " is hidden to put the window on (" +
          JSON.stringify(moved ?? null) +
          ")",
      );
    await pause(400);
  }

  async launchedOffSpace(label: string): Promise<number> {
    const pid = await this.launch(label, { CU_FIXTURE_SPACE: "auto" });
    const moved = await this.fixtures.waitFor(label, (row) => row.event === "spaceMove", 4_000);
    if (!moved || moved.moved !== true || moved.space === -1)
      throw new Skip(
        "no desktop Space of display " +
          this.screen.id +
          " is hidden to put the window on (" +
          JSON.stringify(moved ?? null) +
          ")",
      );
    await pause(400);
    return pid;
  }

  windowNumber(rows: JsonObject[]): number | undefined {
    const launched = rows.find((row) => row.event === "launched");
    const windows = launched?.windows;
    if (!Array.isArray(windows)) return undefined;
    const main = windows.find(
      (window): window is JsonObject => isJsonObject(window) && window.window === "main",
    );
    return main && isNumber(main.windowNumber) ? main.windowNumber : undefined;
  }

  tsRows(cmd: string): JsonObject[] {
    return this.tsLog.rows.filter((row) => row.cmd === cmd);
  }
}

async function scenario(
  id: string,
  body: (checks: Check[], notes: JsonObject) => Promise<void>,
): Promise<ScenarioResult> {
  const checks: Check[] = [];
  const notes: JsonObject = {};
  try {
    await body(checks, notes);
    return { id, verdict: verdictOf(checks), checks, notes };
  } catch (error) {
    if (error instanceof Skip) return { id, verdict: "SKIP", reason: error.message, checks, notes };
    if (error instanceof Abort) {
      error.partial = { id, checks, notes };
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    if (!(error instanceof StepFailed))
      checks.push({ name: "error", ok: false, detail: { reason } });
    return { id, verdict: "FAIL", reason, checks, notes };
  }
}

async function seen(run: Run, checks: Check[], notes: JsonObject): Promise<void> {
  const pid = await run.launch("seen");
  run.baseline = await run.spaces("seen");
  notes.baseline = run.baseline
    ? {
        current: run.baseline.displays.map((display) => ({
          ...display,
          desktopSpaces: [...display.desktopSpaces],
        })),
      }
    : null;
  await run.ts.configure({});
  await run.guard(checks, "seen", "seen.0 shown on its display", true);
  const shown = await run.ts.find(pid);
  notes.findVisible = reduce(shown);
  const visibleRoot = rootOf(shown, pid);
  run.expect(
    checks,
    "seen.0 listed on screen while shown",
    visibleRoot?.isOnscreen === true && visibleRoot.off_space === undefined,
  );
  await run.moveOffSpace("seen");
  await run.guard(checks, "seen", "seen.1 moved off-Space");
  const found = await run.ts.find(pid);
  notes.find = reduce(found);
  const root = rootOf(found, pid);
  run.expect(
    checks,
    "seen.2 find_roots lists it off_space, not on screen, readable",
    root?.off_space === true && root.isOnscreen === false && root.off_space_access === "readable",
    { root: root ? (sanitize(root) ?? null) : null },
  );
  await run.guard(checks, "seen", "seen.2 find_roots");
  const observed = await run.ts.observe(String(root?.windowRef));
  notes.observe = reduce(observed);
  const offSpace = observed.details?.off_space;
  run.expect(
    checks,
    "seen.3 observe_ui reads it without discovery",
    !observed.error && isJsonObject(offSpace) && offSpace.discovery_activation === false,
    { error: observed.error ?? null },
  );
  await run.guard(checks, "seen", "seen.3 observe_ui");
  const increment = nodeOf(observed, "cu-increment");
  const field = nodeOf(observed, "cu-field");
  const stateId = stateIdOf(observed);
  run.expect(
    checks,
    "seen.4 the outline has Increment and Field",
    isString(increment?.ref) && isString(field?.ref) && stateId !== undefined,
  );
  const pressed = await run.ts.act(String(stateId), [
    { action: "click", ref: String(increment?.ref) },
  ]);
  notes.press = reduce(pressed);
  await pause(400);
  const afterPress = await run.fixtures.rows("seen");
  run.expect(
    checks,
    "seen.4 press: one increment",
    !pressed.error && countEvents(afterPress, "increment") === 1,
    { error: pressed.error ?? null, increments: countEvents(afterPress, "increment") },
  );
  await run.guard(checks, "seen", "seen.4 press");
  const again = await run.ts.observe(String(root?.windowRef));
  const setState = stateIdOf(again);
  const setField = nodeOf(again, "cu-field");
  const set = await run.ts.act(String(setState), [
    { action: "setText", ref: String(setField?.ref), text: SET_TEXT },
  ]);
  notes.setText = reduce(set);
  await pause(400);
  const afterSet = await run.fixtures.rows("seen");
  checks.push(typedOnceCheck("seen.5 set_text: field holds the digits once", afterSet, SET_TEXT));
  run.expect(checks, "seen.5 set_text answered", !set.error, { error: set.error ?? null });
  await run.guard(checks, "seen", "seen.5 set_text");
  run.expect(
    checks,
    "seen.6 standard mode never activated the app",
    countEvents(afterSet, "appActive") === 0,
  );
}

async function never(
  run: Run,
  checks: Check[],
  notes: JsonObject,
  extendedUsable: boolean,
): Promise<void> {
  const pid = await run.launchedOffSpace("never");
  await run.guard(checks, "never", "never.0 launched off-Space");
  await run.ts.configure({});
  const found = await run.ts.find(pid);
  notes.find = reduce(found);
  const root = rootOf(found, pid);
  run.expect(
    checks,
    "never.1 find_roots lists it off_space, needing discovery",
    root?.off_space === true &&
      root.isOnscreen === false &&
      root.off_space_access === "needs_discovery",
    { root: root ? (sanitize(root) ?? null) : null },
  );
  await run.guard(checks, "never", "never.1 find_roots");
  const refused = await run.ts.observe(String(root?.windowRef));
  notes.observeStandard = reduce(refused);
  run.expect(
    checks,
    "never.2 standard observe_ui refused off_space_window_unresolved",
    (refused.error ?? "").startsWith("off_space_window_unresolved:"),
    { error: refused.error ?? null },
  );
  await run.guard(checks, "never", "never.2 standard observe_ui");
  run.expect(
    checks,
    "never.2 standard mode never activated the app",
    countEvents(await run.fixtures.rows("never"), "appActive") === 0,
  );
  if (!extendedUsable)
    throw new Skip(
      "the helper reports no discovery activation or no extended delivery; the extended half was not run",
    );
  await run.ts.configure({ background_delivery: "extended" });
  const observed = await run.ts.observe(String(root?.windowRef));
  notes.observeExtended = reduce(observed);
  const offSpace = observed.details?.off_space;
  run.expect(
    checks,
    "never.3 extended observe_ui succeeds after one discovery activation",
    !observed.error && isJsonObject(offSpace) && offSpace.discovery_activation === true,
    { error: observed.error ?? null },
  );
  await pause(500);
  const afterDiscovery = await run.fixtures.rows("never");
  run.expect(
    checks,
    "never.3 the app ends inactive after discovery",
    lastActivation(afterDiscovery) === "appInactive" &&
      countEvents(afterDiscovery, "appActive") === 1,
    { appActive: countEvents(afterDiscovery, "appActive"), last: lastActivation(afterDiscovery) },
  );
  await run.guard(checks, "never", "never.3 extended observe_ui");
  const custom = centreOf(nodeOf(observed, "cu-custom-view"));
  const stateId = stateIdOf(observed);
  run.expect(
    checks,
    "never.4 the outline has the custom view",
    custom !== undefined && stateId !== undefined,
  );
  const clickFrom = Date.now();
  const clicked = await run.ts.act(String(stateId), [
    { action: "click", x: custom?.x ?? 0, y: custom?.y ?? 0 },
  ]);
  notes.click = reduce(clicked);
  await pause(600);
  const afterClick = await run.fixtures.rows("never");
  run.expect(
    checks,
    "never.4 coordinate click on Custom View hits it exactly once",
    !clicked.error && customHitsSince(afterClick, clickFrom) === 1,
    { error: clicked.error ?? null, hits: customHitsSince(afterClick, clickFrom) },
  );
  run.expect(
    checks,
    "never.4 the app ends inactive after the click",
    lastActivation(afterClick) === "appInactive",
  );
  await run.guard(checks, "never", "never.4 coordinate click");
  const again = await run.ts.observe(String(root?.windowRef));
  const field = nodeOf(again, "cu-field");
  const typed = await run.ts.act(String(stateIdOf(again)), [
    { action: "typeText", ref: String(field?.ref), text: TYPED },
  ]);
  notes.typeText = reduce(typed);
  await pause(600);
  const afterType = await run.fixtures.rows("never");
  checks.push(typedOnceCheck("never.5 type_text: field holds the digits once", afterType, TYPED));
  run.expect(checks, "never.5 type_text answered", !typed.error, { error: typed.error ?? null });
  run.expect(
    checks,
    "never.5 the app ends inactive after typing",
    lastActivation(afterType) === "appInactive",
  );
  await run.guard(checks, "never", "never.5 type_text");
}

async function blocked(run: Run, checks: Check[], notes: JsonObject): Promise<void> {
  const pid = await run.launchedOffSpace("blocked");
  await run.guard(checks, "blocked", "blocked.0 launched off-Space");
  const windowId = run.windowNumber(await run.fixtures.rows("blocked"));
  run.expect(checks, "blocked.0 the fixture reported its window number", windowId !== undefined);
  const { reply } = await run.wire.send("look", {
    windowId: windowId ?? 0,
    includeImage: true,
    readText: "never",
    backgroundDelivery: "extended",
    appBlocklist: { bundleIds: [TARGET_BUNDLE], pids: [] },
  });
  const error = isJsonObject(reply.error) ? reply.error : undefined;
  notes.wireLook = { ok: reply.ok ?? null, code: error?.code ?? null };
  run.expect(
    checks,
    "blocked.1 wire look refused app_blocked",
    reply.ok === false && error?.code === "app_blocked" && error.effectPossible === false,
    { code: error?.code ?? null },
  );
  await run.guard(checks, "blocked", "blocked.1 wire look");
  await run.ts.configure({ blocked_apps: [TARGET_BUNDLE], background_delivery: "extended" });
  const before = run.tsRows("look").length;
  const found = await run.ts.find(pid);
  notes.find = reduce(found);
  const root = rootOf(found, pid);
  run.expect(
    checks,
    "blocked.2 find_roots flags it blocked and off_space, with no accessibility read",
    root?.blocked === true && root.off_space === true && root.off_space_access === "unchecked",
    { root: root ? (sanitize(root) ?? null) : null },
  );
  const observed = await run.ts.observe(String(root?.windowRef));
  notes.observe = reduce(observed);
  run.expect(
    checks,
    "blocked.3 observe_ui refused",
    (observed.error ?? "").includes("app_blocked") ||
      (observed.error ?? "").includes("not allowed to operate"),
    { error: observed.error ?? null },
  );
  run.expect(
    checks,
    "blocked.3 no look request reached the helper",
    run.tsRows("look").length === before,
  );
  await run.guard(checks, "blocked", "blocked.3 observe_ui");
  run.expect(
    checks,
    "blocked.4 the app was never activated",
    countEvents(await run.fixtures.rows("blocked"), "appActive") === 0,
  );
}

async function foreground(
  run: Run,
  checks: Check[],
  notes: JsonObject,
  capable: boolean,
): Promise<void> {
  if (!capable)
    throw new Skip(
      "the helper reports no off-Space capability; the granted foreground step is not run, because such a helper would activate the target and switch the user's Space",
    );
  if (!run.fixtures.instances.has("seen")) throw new Skip("the seen fixture did not run");
  const pid = run.fixtures.pid("seen");
  await run.guard(checks, "seen", "foreground.0 before");
  const windowId = run.windowNumber(await run.fixtures.rows("seen"));
  await run.ts.reset();
  const look = await run.wire.send("look", {
    windowId: windowId ?? 0,
    includeImage: false,
    readText: "never",
  });
  const result = isJsonObject(look.reply.result) ? look.reply.result : undefined;
  const outline = result?.outline;
  let incrementRef: string | undefined;
  const queue: JsonValue[] = outline === undefined ? [] : [outline];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!isJsonObject(node)) continue;
    if (node.identifier === "cu-increment" && isString(node.ref)) incrementRef = node.ref;
    if (Array.isArray(node.children)) queue.push(...node.children);
  }
  run.expect(
    checks,
    "foreground.1 wire look of the off-Space window",
    look.reply.ok === true && isString(result?.lookId) && incrementRef !== undefined,
  );
  const increments = countEvents(await run.fixtures.rows("seen"), "increment");
  const claim = await run.wire.send("claim", { session: { ...run.wire.session } });
  run.expect(checks, "foreground.2 claim", claim.reply.ok === true);
  try {
    const { reply } = await run.wire.send("act", {
      ...run.wire.actEnvelope(15_000),
      lookId: String(result?.lookId),
      pid,
      action: "press",
      target: { ref: String(incrementRef) },
      params: { delivery: "hid" },
      policy: "foreground",
      foregroundGrant: true,
    });
    const error = isJsonObject(reply.error) ? reply.error : undefined;
    notes.wireAct = {
      ok: reply.ok ?? null,
      code: error?.code ?? null,
      inputSent: error?.inputSent ?? null,
      activationAttempted: error?.activationAttempted ?? null,
    };
    run.expect(
      checks,
      "foreground.2 granted foreground act refused off_space_foreground with no input",
      reply.ok === false &&
        error?.code === "off_space_foreground" &&
        error.inputSent === false &&
        error.activationAttempted === false,
      { code: error?.code ?? null },
    );
  } finally {
    await run.wire
      .send("release", { session: { ...run.wire.session } }, { timeoutMs: 3_000 })
      .catch(() => undefined);
  }
  await pause(400);
  const rows = await run.fixtures.rows("seen");
  run.expect(
    checks,
    "foreground.2 nothing pressed and no activation",
    countEvents(rows, "increment") === increments && countEvents(rows, "appActive") === 0,
  );
  await run.guard(checks, "seen", "foreground.2 wire act");
  await run.ts.configure({ foreground_grant: [TARGET_BUNDLE] });
  const found = await run.ts.find(pid);
  const root = rootOf(found, pid);
  const observed = await run.ts.observe(String(root?.windowRef));
  const custom = centreOf(nodeOf(observed, "cu-custom-view"));
  run.expect(
    checks,
    "foreground.3 observed with a grant configured",
    !observed.error && custom !== undefined,
    { error: observed.error ?? null },
  );
  const foregroundActs = (): number =>
    run.tsRows("act").filter((row) => row.policy === "foreground" || row.foregroundGrant === true)
      .length;
  const before = foregroundActs();
  const clicked = await run.ts.act(String(stateIdOf(observed)), [
    { action: "click", x: custom?.x ?? 0, y: custom?.y ?? 0 },
  ]);
  notes.grantedClick = reduce(clicked);
  await pause(400);
  run.expect(
    checks,
    "foreground.3 act_ui with a grant sent no foreground act and no focus request",
    foregroundActs() === before && run.tsRows("focusWindow").length === 0,
    { foregroundActs: foregroundActs() - before },
  );
  run.expect(
    checks,
    "foreground.3 the app was never activated",
    countEvents(await run.fixtures.rows("seen"), "appActive") === 0,
  );
  await run.guard(checks, "seen", "foreground.3 act_ui with a grant");
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
    console.error("HELPER_IS_MAIN the off-Space check must not use the main helper app or socket");
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
  const tsLog = new RequestLog(join(options.out, "ts-requests.jsonl"));
  const wire = new Wire(options.helperSocket, log);
  const frontBefore = await frontApp();
  const build = await buildFixture(join(options.out, "fixture-build"));
  const fixtures = new FixtureSet(join(options.out, "fixture"), build);
  await fixtures.prepare();
  const proxy = new GuardProxy(join(options.out, "ts.sock"), options.helperSocket);
  proxy.log = tsLog;
  const summary: JsonObject = {
    startedAt: new Date().toISOString(),
    helper: { app: options.helperApp, socket: options.helperSocket },
    fixture: { hash: build.hash, dir: build.dir, logs: fixtures.dir },
    frontBefore: frontBefore
      ? { pid: frontBefore.pid ?? null, bundleId: frontBefore.bundleId ?? null }
      : null,
    typedText: {
      setText: SET_TEXT,
      typeText: TYPED,
      note: "digits only, so the result does not depend on the keyboard input source",
    },
  };
  const results: ScenarioResult[] = [];
  let listed: Screen[] = [];
  let status = "complete";
  let ts: TsLayer | undefined;
  try {
    const checked = await checkHelper(options.helperSocket, helperAppReal, log);
    summary.diagnostics = checked.diagnostics ?? null;
    if (checked.blocked) throw new Error("BLOCKED(" + checked.blocked + ")");
    const diagnostics = (await wire.send("diagnostics", {}, { timeoutMs: 3_000 })).reply.result;
    const offSpace =
      isJsonObject(diagnostics) && isJsonObject(diagnostics.offSpace)
        ? diagnostics.offSpace
        : undefined;
    const extended =
      isJsonObject(diagnostics) && isJsonObject(diagnostics.extendedDelivery)
        ? diagnostics.extendedDelivery
        : undefined;
    summary.offSpaceCapability = offSpace ? (sanitize(offSpace) ?? null) : null;
    summary.extendedDelivery = extended ? (sanitize(extended) ?? null) : null;
    const capable = offSpace?.available === true;
    const extendedUsable =
      capable && offSpace?.discoveryAvailable === true && extended?.available === true;
    await fixtures.launch({
      label: "screens",
      role: "target",
      env: { CU_FIXTURE_SCREENS_ONLY: "1" },
    });
    const screensRow = await fixtures.waitFor("screens", (row) => row.event === "screens", 5_000);
    const screens = parseScreens(screensRow?.screens);
    listed = screens;
    summary.screens = screens.map((screen) => ({
      id: screen.id,
      name: screen.name,
      primary: screen.primary,
    }));
    if (options.display === undefined)
      throw new Error(
        "LIST(pass --display <id> for a display that shows a desktop Space with another desktop Space next to it)",
      );
    const screen = screens.find((candidate) => candidate.id === options.display);
    if (!screen) throw new Error("BLOCKED(unknown display id " + options.display + ")");
    summary.display = { id: screen.id, name: screen.name };
    await proxy.start();
    ts = await loadTs(
      proxy.listen,
      options.helperApp,
      join(options.out, "agent"),
      join(options.out, "cwd"),
    );
    const run = new Run(wire, fixtures, ts, tsLog, frontBefore, screen);
    const steps: [string, (checks: Check[], notes: JsonObject) => Promise<void>][] = [
      ["seen", (checks, notes) => seen(run, checks, notes)],
      ["never", (checks, notes) => never(run, checks, notes, extendedUsable)],
      ["blocked", (checks, notes) => blocked(run, checks, notes)],
      ["foreground", (checks, notes) => foreground(run, checks, notes, capable)],
    ];
    for (const [id, body] of steps) {
      if (id !== "seen" && !run.baseline) {
        results.push({
          id,
          verdict: "SKIP",
          reason: "no baseline Space state (the seen fixture did not report)",
          checks: [],
          notes: {},
        });
        continue;
      }
      results.push(await scenario(id, body));
      if (id === "seen" && results[0]?.verdict === "SKIP") {
        for (const rest of steps.slice(1))
          results.push({
            id: rest[0],
            verdict: "SKIP",
            reason: results[0].reason ?? "skipped",
            checks: [],
            notes: {},
          });
        break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Abort) {
      const partial = error.partial;
      if (partial)
        results.push({
          id: partial.id,
          verdict: "FAIL",
          reason: message,
          checks: partial.checks,
          notes: partial.notes,
        });
      status = "ABORTED(" + message + ")";
    } else
      status =
        message.startsWith("BLOCKED") || message.startsWith("LIST")
          ? message
          : "ABORTED(" + message + ")";
  } finally {
    await ts?.reset().catch(() => undefined);
    await proxy.stop().catch(() => undefined);
    summary.cleanup = await fixtures.quitAll();
    summary.sweptFixturePids = await sweepFixtureProcesses(build);
    await unregisterFixture(build).catch(() => undefined);
    const frontAfter = await frontApp();
    summary.frontAfter = frontAfter
      ? { pid: frontAfter.pid ?? null, bundleId: frontAfter.bundleId ?? null }
      : null;
    summary.forbiddenTsRequests = proxy.blocked.map((entry) => ({ ...entry }));
    await log.flush();
    await tsLog.flush();
  }
  const verdicts = results.map((result) => result.verdict);
  const verdict =
    status !== "complete"
      ? status.startsWith("LIST")
        ? "LIST"
        : status.startsWith("BLOCKED")
          ? "BLOCKED"
          : "FAIL"
      : verdicts.includes("FAIL")
        ? "FAIL"
        : verdicts.every((entry) => entry === "SKIP")
          ? "SKIP"
          : verdicts.includes("SKIP")
            ? "PARTIAL"
            : "PASS";
  summary.status = status;
  summary.verdict = verdict;
  summary.scenarios = results.map((result) => ({
    id: result.id,
    verdict: result.verdict,
    reason: result.reason ?? null,
    firstFailure: result.checks.find((check) => !check.ok)?.name ?? null,
    checks: result.checks.map((check) => ({ ...check })),
    notes: result.notes,
  }));
  summary.finishedAt = new Date().toISOString();
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  for (const result of results)
    console.log(
      "offspace " +
        result.id +
        ": " +
        result.verdict +
        (result.reason ? " (" + result.reason + ")" : ""),
    );
  if (verdict === "LIST")
    for (const screen of listed)
      console.log(
        "  display " +
          screen.id +
          " " +
          screen.name +
          " at " +
          screen.bounds.x +
          "," +
          screen.bounds.y,
      );
  console.log("offspace " + verdict + " " + status + " (" + summaryPath + ")");
  return verdict === "PASS" || verdict === "SKIP" ? 0 : 1;
}

process.exit(await main());
