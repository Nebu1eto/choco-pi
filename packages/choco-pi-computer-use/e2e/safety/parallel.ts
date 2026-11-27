import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";
import type { UiAction } from "../../src/contract.ts";
import { unregisterFixture } from "../desktop.ts";
import { buildFixture, fixtureApps, type FixtureBuild } from "../fixture/build.ts";
import { command } from "../preflight.ts";
import { FixtureSet, sweepFixtureProcesses, type InstanceSpec } from "./fixtures.ts";
import { GuardProxy } from "./guard-proxy.ts";
import { checkHelper } from "./scenarios.ts";
import { isMainHelper, parseJsonl } from "./score.ts";
import { createContext, sanitize } from "./ts-layer.ts";
import { RequestLog, Wire } from "./wire.ts";

type Delivery = "standard" | "extended";
type Layout = "apps" | "windows";
type ProcessMode = "separate" | "shared";
type Label =
  | "find"
  | "observe"
  | "press"
  | "click_custom"
  | "type"
  | "key"
  | "scroll_down"
  | "scroll_up"
  | "drag";

export interface ClientSpec {
  id: string;
  index: number;
  pid: number;
  window: "main" | "second";
  text: string;
  chars: string;
  workload: Label[];
  result: string;
}

interface ClientProcessSpec {
  specs: ClientSpec[];
  helperApp: string;
  helperSocket: string;
  socket: string;
  requests: string;
  agentDir: string;
  cwd: string;
  delivery: Delivery;
  grant: boolean;
  sequential: boolean;
}

export interface Attempt {
  start: number;
  end: number;
  error?: string;
  text?: string;
  details?: JsonValue;
}

export interface StepRecord {
  n: number;
  label: Label;
  auto: boolean;
  start: number;
  end: number;
  attempts: number;
  ownershipRefusals: number;
  busyRetries: number;
  error?: string;
  text?: string;
  details?: JsonValue;
}

export interface ClientResult {
  id: string;
  pid: number;
  started: number;
  ended: number;
  steps: StepRecord[];
  fatal?: string;
}

export const FULL_WORKLOAD: Label[] = [
  "find",
  "observe",
  "press",
  "click_custom",
  "type",
  "key",
  "press",
  "scroll_down",
  "observe",
  "click_custom",
  "drag",
  "press",
  "scroll_up",
  "observe",
  "click_custom",
  "press",
  "key",
  "press",
  "click_custom",
  "observe",
  "drag",
  "press",
];
export const TYPING_WORKLOAD: Label[] = [
  "find",
  "observe",
  "type",
  "key",
  "observe",
  "key",
  "observe",
];
const LETTERS = ["abde", "fghi", "jklm", "nopq", "rstu", "vwyz"];

export interface ClientText {
  text: string;
  chars: string;
}

export function clientText(index: number): ClientText {
  const letters = LETTERS[(index - 1) % LETTERS.length] ?? "abde";
  let text = `c${index}:`;
  for (let i = 0; text.length < 40; i++) text += letters[i % letters.length];
  return { text, chars: `c:${index}${letters}` };
}

export function offsetOf(slot: number): string {
  const dx = [-540, 120, 780][slot % 3] ?? 0;
  const dy = [440, -100][Math.floor(slot / 3) % 2] ?? 0;
  return `${dx},${dy}`;
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

interface Point {
  x: number;
  y: number;
}

interface Refs {
  root?: string;
  stateId?: string;
  field?: string;
  increment?: string;
  custom?: string;
  scroll?: string;
  scale: number;
  titlebar: number;
}

function refOf(text: string, label: string): string | undefined {
  for (const line of text.split("\n")) {
    const match = /^\s*(@e\d+)\s+\S+\s+"([^"]*)"/.exec(line);
    if (match?.[1] && match[2] === label) return match[1];
  }
  return undefined;
}

function stateIdOf(text: string): string | undefined {
  return /\bstate(?:_id)? ([0-9a-f-]{36})\b/i.exec(text)?.[1];
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n");
}

function jsonOf<T>(result: { details?: T }): JsonValue | undefined {
  if (result.details === undefined) return undefined;
  const parsed: JsonValue = JSON.parse(JSON.stringify(result.details));
  return sanitize(parsed);
}

const OWNERSHIP = /owned_by_other_session|owned by another session|controlled by another session/i;
const BUSY = /^(target_busy|foreground_busy)\b/;
const statusOf = (attempt: Attempt): string =>
  isJsonObject(attempt.details) && isString(attempt.details.status) ? attempt.details.status : "";
const STEP_BUDGET_MS = 240_000;

async function runClient(spec: ClientSpec, bridgeUrl: string, cwd: string): Promise<ClientResult> {
  const bridge: typeof import("../../src/bridge.ts") = await import(bridgeUrl);
  const ctx = await createContext(cwd);
  const refs: Refs = { scale: 1, titlebar: 32 };
  const steps: StepRecord[] = [];
  const started = Date.now();
  const title = spec.window === "main" ? fixtureApps.target.title : `${fixtureApps.target.title} 2`;
  const fieldLabel = spec.window === "main" ? "Field" : "Field 2";
  const pt = (x: number, y: number): Point => ({
    x: Math.round(x * refs.scale),
    y: Math.round((y + refs.titlebar) * refs.scale),
  });
  const call = async (label: Label): Promise<Attempt> => {
    const start = Date.now();
    const signal = AbortSignal.timeout(90_000);
    const id = `${spec.id}-${label}-${start}`;
    try {
      let result: { content: Array<{ type: string; text?: string }>; details?: object };
      if (label === "find")
        result = await bridge.executeFind(id, { pid: spec.pid }, signal, undefined, ctx);
      else if (label === "observe")
        if (!refs.root) throw new Error("harness: no root; refusing a root-less observation");
        else
          result = await bridge.executeObserve(
            id,
            { root: refs.root, mode: "fused" },
            signal,
            undefined,
            ctx,
          );
      else {
        const action = actionFor(label);
        result = await bridge.executeAct(
          id,
          { stateId: refs.stateId, actions: [action] },
          signal,
          undefined,
          ctx,
        );
      }
      return { start, end: Date.now(), text: resultText(result), details: jsonOf(result) };
    } catch (error) {
      return {
        start,
        end: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const actionFor = (label: Label): UiAction => {
    if (label === "press") return { action: "press", ref: refs.increment ?? "" };
    if (label === "click_custom") return { action: "click", ...pt(160, 400) };
    if (label === "type") return { action: "typeText", text: spec.text, ref: refs.field ?? "" };
    if (label === "key") return { action: "keypress", keys: ["backspace"], ref: refs.field ?? "" };
    if (label === "scroll_down") return { action: "scroll", ref: refs.scroll ?? "", scrollY: 5 };
    if (label === "scroll_up") return { action: "scroll", ref: refs.scroll ?? "", scrollY: -5 };
    return { action: "drag", path: [pt(290, 215), pt(450, 215), pt(600, 215)] };
  };
  const absorb = (label: Label, attempt: Attempt): void => {
    if (attempt.error) {
      if (label !== "find" && label !== "observe") refs.stateId = undefined;
      return;
    }
    const text = attempt.text ?? "";
    const details = isJsonObject(attempt.details) ? attempt.details : {};
    if (label === "find") {
      const windows = Array.isArray(details.windows) ? details.windows : [];
      for (const window of windows)
        if (isJsonObject(window) && window.windowTitle === title && isString(window.windowRef))
          refs.root = window.windowRef;
      return;
    }
    const capture = isJsonObject(details.capture) ? details.capture : undefined;
    if (capture && isNumber(capture.scaleFactor)) refs.scale = capture.scaleFactor;
    const state =
      (capture && isString(capture.stateId) ? capture.stateId : undefined) ?? stateIdOf(text);
    refs.stateId = state;
    refs.field = refOf(text, fieldLabel) ?? refs.field;
    refs.increment = refOf(text, "Increment") ?? refs.increment;
    refs.custom = refOf(text, "Custom View") ?? refs.custom;
    refs.scroll = refOf(text, "cu-scroll") ?? refs.scroll;
  };
  const step = async (label: Label, auto: boolean): Promise<StepRecord> => {
    const begin = Date.now();
    let attempts = 0;
    let ownershipRefusals = 0;
    let busyRetries = 0;
    let last: Attempt;
    for (;;) {
      attempts += 1;
      last = await call(label);
      const message = last.error ?? last.text ?? "";
      const status = statusOf(last);
      if ((BUSY.test(status) || BUSY.test(message)) && Date.now() - begin < STEP_BUDGET_MS) {
        busyRetries += 1;
        await pause(300);
        continue;
      }
      if (
        (status === "owned_by_other_session" || OWNERSHIP.test(message.slice(0, 400))) &&
        Date.now() - begin < STEP_BUDGET_MS
      ) {
        ownershipRefusals += 1;
        if (label !== "find" && label !== "observe") {
          const observe = await call("observe");
          absorb("observe", observe);
        }
        await pause(500);
        continue;
      }
      break;
    }
    absorb(label, last);
    const record: StepRecord = {
      n: steps.length + 1,
      label,
      auto,
      start: last.start,
      end: last.end,
      attempts,
      ownershipRefusals,
      busyRetries,
    };
    if (last.error) record.error = last.error.slice(0, 2000);
    if (last.text) record.text = last.text.slice(0, 1500);
    if (last.details !== undefined) record.details = last.details;
    steps.push(record);
    return record;
  };
  try {
    for (const label of spec.workload) {
      if (label === "find") {
        for (let tries = 0; tries < 20 && !refs.root; tries++) {
          if (tries > 0) await pause(500);
          await step("find", tries > 0);
        }
        if (!refs.root) throw new Error(`no root titled ${title} for pid ${spec.pid}`);
        continue;
      }
      if (label !== "observe" && !refs.stateId) await step("observe", true);
      await step(label, false);
    }
  } catch (error) {
    return { id: spec.id, pid: spec.pid, started, ended: Date.now(), steps, fatal: String(error) };
  }
  return { id: spec.id, pid: spec.pid, started, ended: Date.now(), steps };
}

class RedactingLog extends RequestLog {
  readonly allowed: Set<number>;
  constructor(path: string, allowed: Set<number>) {
    super(path);
    this.allowed = allowed;
  }
  override answer(row: JsonObject, reply: JsonObject | undefined, error?: string): void {
    const cmd = isString(row.cmd) ? row.cmd : "";
    const redact =
      cmd === "listApps" ||
      cmd === "getFrontmost" ||
      cmd === "getUserContext" ||
      (cmd === "listRoots" && !(isNumber(row.pid) && this.allowed.has(row.pid)));
    super.answer(
      row,
      redact && reply ? { id: reply.id ?? null, ok: reply.ok ?? null, redacted: true } : reply,
      error,
    );
  }
}

async function clientMain(specPath: string): Promise<void> {
  const spec: ClientProcessSpec = JSON.parse(await readFile(specPath, "utf8"));
  process.env.PI_CU_SOCKET_PATH = spec.socket;
  process.env.PI_COMPUTER_USE_HELPER_APP_PATH = spec.helperApp;
  process.env.PI_CODING_AGENT_DIR = spec.agentDir;
  process.env.PI_COMPUTER_USE_HEADLESS = "0";
  process.env.PI_COMPUTER_USE_CURSOR_OVERLAY = "0";
  process.env.PI_COMPUTER_USE_BROWSER_USE = "0";
  process.env.PI_COMPUTER_USE_BACKGROUND_DELIVERY = spec.delivery;
  for (const key of [
    "PI_COMPUTER_USE_DELIVERY_POLICY",
    "PI_COMPUTER_USE_EVENT_DELIVERY",
    "PI_COMPUTER_USE_FOREGROUND_PROMPT",
    "PI_COMPUTER_USE_FOREGROUND_GRANT",
  ])
    delete process.env[key];
  if (spec.grant) process.env.PI_COMPUTER_USE_FOREGROUND_GRANT = fixtureApps.target.bundleId;
  await mkdir(spec.agentDir, { recursive: true });
  await mkdir(join(spec.cwd, ".pi"), { recursive: true });
  const proxy = new GuardProxy(spec.socket, spec.helperSocket);
  proxy.log = new RedactingLog(spec.requests, new Set(spec.specs.map((client) => client.pid)));
  await proxy.start();
  const helper = await import("../../src/platform/macos/helper.ts");
  if (helper.HELPER_SOCKET_PATH !== spec.socket) throw new Error("TS helper socket mismatch");
  const bridgeUrl = new URL("../../src/bridge.ts", import.meta.url).href;
  const bridge: typeof import("../../src/bridge.ts") = await import(bridgeUrl);
  const permissions = await import("../../src/platform/macos/permissions.ts");
  process.stdout.write("ready\n");
  await new Promise<void>((done) => {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      if (chunk.includes("go")) done();
    });
  });
  const results: ClientResult[] = [];
  if (spec.sequential)
    for (const client of spec.specs) results.push(await runClient(client, bridgeUrl, spec.cwd));
  else
    results.push(
      ...(await Promise.all(spec.specs.map((client) => runClient(client, bridgeUrl, spec.cwd)))),
    );
  for (const result of results) {
    const client = spec.specs.find((item) => item.id === result.id);
    if (client) await writeFile(client.result, `${JSON.stringify(result, null, 1)}\n`);
  }
  await bridge.shutdownComputerUseSession().catch(() => undefined);
  await permissions.releaseMacosOwnership(AbortSignal.timeout(2_000)).catch(() => false);
  await proxy.log.flush();
  await proxy.stop();
  process.stdin.pause();
  process.exit(0);
}

interface Options {
  helperApp: string;
  helperSocket: string;
  out: string;
  clients: number;
  delivery: Delivery;
  layout: Layout;
  process: ProcessMode;
  reps: number;
  sequential: boolean;
  foreground: boolean;
  holder: boolean;
  fixtureRoot: string;
}

function parse(argv: string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const helperApp = value("--helper-app");
  const helperSocket = value("--helper-socket");
  const out = value("--out");
  if (!helperApp || !helperSocket || !out)
    throw new Error(
      "usage: parallel.ts --helper-app <app> --helper-socket <socket> --out <dir> [--clients 2] [--delivery standard|extended] [--layout apps|windows] [--process separate|shared] [--reps 3] [--sequential] [--foreground] [--fixture-root <dir>]",
    );
  const clients = Number(value("--clients") ?? "2");
  const delivery = value("--delivery") ?? "standard";
  const layout = value("--layout") ?? "apps";
  const processMode = value("--process") ?? "separate";
  const reps = Number(value("--reps") ?? "3");
  if (!Number.isInteger(clients) || clients < 1 || clients > 6) throw new Error("--clients 1..6");
  if (delivery !== "standard" && delivery !== "extended")
    throw new Error("--delivery standard|extended");
  if (layout !== "apps" && layout !== "windows") throw new Error("--layout apps|windows");
  if (processMode !== "separate" && processMode !== "shared")
    throw new Error("--process separate|shared");
  if (layout === "windows" && clients !== 2)
    throw new Error("--layout windows takes exactly 2 clients");
  if (!Number.isInteger(reps) || reps < 1) throw new Error("--reps >= 1");
  return {
    helperApp: resolve(helperApp),
    helperSocket: resolve(helperSocket),
    out: resolve(out),
    clients,
    delivery,
    layout,
    process: processMode,
    reps,
    sequential: argv.includes("--sequential"),
    foreground: argv.includes("--foreground"),
    holder: argv.includes("--holder") || argv.includes("--foreground"),
    fixtureRoot: resolve(value("--fixture-root") ?? join(out, "fixture-build")),
  };
}

interface FrontSample {
  at: number;
  pid?: number;
  bundleId?: string;
}

class FrontSampler {
  readonly samples: FrontSample[] = [];
  private running = true;
  private loop: Promise<void> | undefined;
  start(): void {
    this.loop = (async () => {
      while (this.running) {
        const front = await command("lsappinfo", ["front"]);
        const asn = front.stdout.trim();
        const info = asn
          ? await command("lsappinfo", ["info", "-only", "bundleid", "-only", "pid", asn])
          : undefined;
        const bundleId = info
          ? /"?(?:bundleID|CFBundleIdentifier)"?="([^"]+)"/i.exec(info.stdout)?.[1]
          : undefined;
        const pidText = info ? /"?pid"?\s*=\s*(\d+)/i.exec(info.stdout)?.[1] : undefined;
        const sample: FrontSample = {
          at: Date.now(),
          bundleId,
          pid: pidText ? Number(pidText) : undefined,
        };
        const last = this.samples.at(-1);
        if (!last || last.pid !== sample.pid || last.bundleId !== sample.bundleId)
          this.samples.push(sample);
        await pause(250);
      }
    })();
  }
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}

interface Child {
  child: ChildProcess;
  ready: Promise<void>;
  exited: Promise<number>;
  log: string[];
}

function startClientProcess(specPath: string): Child {
  const child = spawn(
    process.execPath,
    ["--no-warnings", fileURLToPath(import.meta.url), "--client", specPath],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const log: string[] = [];
  let readyDone: () => void = () => undefined;
  const ready = new Promise<void>((done) => {
    readyDone = done;
  });
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    log.push(chunk);
    if (chunk.includes("ready")) readyDone();
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => log.push(chunk));
  const exited = new Promise<number>((done) => child.once("exit", (code) => done(code ?? 1)));
  const started = Promise.race([
    ready,
    exited.then((code) => {
      throw new Error(
        `client process exited (${code}) before it was ready: ${log.join("").slice(-800)}`,
      );
    }),
  ]);
  return { child, ready: started, exited, log };
}

async function readResult(path: string): Promise<ClientResult | undefined> {
  try {
    const value: ClientResult = JSON.parse(await readFile(path, "utf8"));
    return value;
  } catch {
    return undefined;
  }
}

interface PhaseRun {
  phase: "parallel" | "sequential";
  rep: number;
  dir: string;
  wallMs: number;
  clientWallMs: number[];
  results: (ClientResult | undefined)[];
  specs: ClientSpec[];
  fixture: Record<string, JsonObject[]>;
  fixturePids: Record<string, number>;
  front: FrontSample[];
  requestLogs: string[];
  window: { from: number; to: number };
  clientLogs: string[];
  cleanup: string[];
  inputSourceBefore: JsonValue;
  inputSourceAfter: JsonValue;
}

async function readInputSource(socket: string, dir: string): Promise<JsonValue> {
  const log = new RequestLog(join(dir, "input-source.jsonl"));
  try {
    const { reply } = await new Wire(socket, log).send("diagnostics", {}, { timeoutMs: 5_000 });
    return isJsonObject(reply.result) ? (reply.result.inputSource ?? null) : null;
  } catch {
    return null;
  } finally {
    await log.flush();
  }
}

async function runPhase(
  options: Options,
  build: FixtureBuild,
  phase: "parallel" | "sequential",
  rep: number,
): Promise<PhaseRun> {
  const dir = join(options.out, `rep${rep}-${phase}`);
  await mkdir(dir, { recursive: true });
  const fixtures = new FixtureSet(join(dir, "fixture"), build);
  await fixtures.prepare();
  const sampler = new FrontSampler();
  const specs: ClientSpec[] = [];
  const cleanup: string[] = [];
  const children: Child[] = [];
  const clientWallMs: number[] = [];
  let wallMs = 0;
  let socketDir = "";
  let inputSourceBefore: JsonValue = null;
  let from = Date.now();
  try {
    if (options.holder) {
      await fixtures.launch({ label: "holder", role: "holder" });
      await pause(800);
    }
    const instances = options.layout === "windows" ? 1 : options.clients;
    for (let slot = 0; slot < instances; slot++) {
      const env: NonNullable<InstanceSpec["env"]> = {
        CU_FIXTURE_PARALLEL: "1",
        CU_FIXTURE_OFFSET: offsetOf(slot),
      };
      if (options.layout === "windows") env.CU_FIXTURE_WINDOWS = "2";
      await fixtures.launch({ label: `t${slot + 1}`, role: "target", env });
    }
    await pause(800);
    for (let index = 1; index <= options.clients; index++) {
      const label = options.layout === "windows" ? "t1" : `t${index}`;
      const { text, chars } = clientText(index);
      const second = options.layout === "windows" && index === 2;
      specs.push({
        id: `c${index}`,
        index,
        pid: fixtures.pid(label),
        window: second ? "second" : "main",
        text,
        chars,
        workload: second ? TYPING_WORKLOAD : FULL_WORKLOAD,
        result: join(dir, `c${index}.result.json`),
      });
    }
    const groups: ClientSpec[][] =
      options.process === "shared" ? [specs] : specs.map((spec) => [spec]);
    const processSpecs: string[] = [];
    socketDir = await mkdtemp(join(tmpdir(), "cu-par-"));
    for (const [index, group] of groups.entries()) {
      const name = options.process === "shared" ? "shared" : (group[0]?.id ?? `g${index}`);
      const spec: ClientProcessSpec = {
        specs: group,
        helperApp: options.helperApp,
        helperSocket: options.helperSocket,
        socket: join(socketDir, `${name}.sock`),
        requests: join(dir, `${name}.requests.jsonl`),
        agentDir: join(dir, `${name}-agent`),
        cwd: join(dir, `${name}-cwd`),
        delivery: options.delivery,
        grant: options.foreground,
        sequential: phase === "sequential",
      };
      const path = join(dir, `${name}.spec.json`);
      await writeFile(path, `${JSON.stringify(spec, null, 1)}\n`);
      processSpecs.push(path);
    }
    inputSourceBefore = await readInputSource(options.helperSocket, dir);
    sampler.start();
    await pause(500);
    from = Date.now();
    if (phase === "parallel") {
      for (const path of processSpecs) children.push(startClientProcess(path));
      await Promise.all(children.map((child) => child.ready));
      const go = Date.now();
      for (const child of children) child.child.stdin?.write("go\n");
      const ends = await Promise.all(
        children.map(async (child) => {
          await child.exited;
          return Date.now();
        }),
      );
      wallMs = Math.max(...ends) - go;
      clientWallMs.push(...ends.map((end) => end - go));
    } else {
      for (const path of processSpecs) {
        const child = startClientProcess(path);
        children.push(child);
        await child.ready;
        const go = Date.now();
        child.child.stdin?.write("go\n");
        await child.exited;
        clientWallMs.push(Date.now() - go);
      }
      wallMs = clientWallMs.reduce((sum, value) => sum + value, 0);
    }
    await pause(1_500);
  } finally {
    for (const child of children) if (child.child.exitCode === null) child.child.kill("SIGKILL");
    cleanup.push(...(await fixtures.quitAll()));
    await sampler.stop();
    if (socketDir) await rm(socketDir, { recursive: true, force: true });
  }
  const to = Date.now();
  const fixture: Record<string, JsonObject[]> = {};
  const fixturePids: Record<string, number> = {};
  for (const [label, instance] of fixtures.instances) {
    fixture[label] = await fixtures.rows(label);
    if (instance.pid !== undefined) fixturePids[label] = instance.pid;
  }
  const results = await Promise.all(specs.map((spec) => readResult(spec.result)));
  const requestLogs =
    options.process === "shared"
      ? [join(dir, "shared.requests.jsonl")]
      : specs.map((spec) => join(dir, `${spec.id}.requests.jsonl`));
  const clientLogs = children.map((child) => child.log.join("").slice(-4000));
  const inputSourceAfter = await readInputSource(options.helperSocket, dir);
  return {
    phase,
    rep,
    dir,
    wallMs,
    clientWallMs,
    results,
    specs,
    fixture,
    fixturePids,
    front: sampler.samples,
    requestLogs,
    window: { from, to },
    clientLogs,
    cleanup,
    inputSourceBefore,
    inputSourceAfter,
  };
}

const REFUSAL_CODES = [
  "owned_by_other_session",
  "target_busy",
  "foreground_busy",
  "key_window_conflict",
  "not_look_owner",
  "input_source_composes",
  "foreground_required",
  "foreground_not_acquired",
  "foreground_lost",
  "user_switched",
  "stale_look",
  "observation_refresh_required",
  "occluded_target",
  "app_blocked",
  "cancelled",
  "target_closed",
  "deadline",
];

export interface Answer {
  kind: "ok" | "worked" | "unknown" | "didnt" | "refused" | "error";
  code?: string;
  extended?: string;
  effectPossible?: boolean;
}

function find(value: JsonValue | undefined, key: string): JsonValue[] {
  const out: JsonValue[] = [];
  const walk = (item: JsonValue | undefined): void => {
    if (Array.isArray(item)) for (const each of item) walk(each);
    else if (isJsonObject(item))
      for (const [name, child] of Object.entries(item)) {
        if (name === key && child !== undefined) out.push(child);
        walk(child);
      }
  };
  walk(value);
  return out;
}

export function answerOf(step: StepRecord): Answer {
  const extended = find(step.details, "extendedDelivery").find(isString);
  if (step.error) {
    const code = REFUSAL_CODES.find((item) => step.error?.includes(item));
    return code ? { kind: "refused", code } : { kind: "error", code: step.error.slice(0, 80) };
  }
  const details = isJsonObject(step.details) ? step.details : {};
  const status = isString(details.status) ? details.status : undefined;
  const errorCode =
    isJsonObject(details.error) && isString(details.error.code) ? details.error.code : undefined;
  const effectPossible = find(step.details, "effectPossible").find(
    (item) => item === true || item === false,
  );
  const possible = effectPossible === true ? true : effectPossible === false ? false : undefined;
  if (status && status !== "ok" && status !== "worked" && status !== "partial") {
    return { kind: "refused", code: status, extended, effectPossible: possible };
  }
  if (step.label === "find" || step.label === "observe") return { kind: "ok" };
  const execution = isJsonObject(details.execution) ? details.execution : undefined;
  const outcomes = find(execution, "outcome").filter(isString);
  if (status === "partial")
    return { kind: "refused", code: errorCode ?? "partial", extended, effectPossible: possible };
  if (outcomes.includes("didnt")) return { kind: "didnt", extended };
  if (outcomes.includes("unknown")) return { kind: "unknown", extended };
  if (outcomes.includes("worked")) return { kind: "worked", extended };
  return { kind: "unknown", code: `outcome:${outcomes.join("/") || "none"}`, extended };
}

export type StepClass =
  | "intended"
  | "honest_refusal"
  | "unverified_no_effect"
  | "wrong_worked_without_effect"
  | "wrong_effect_but_refused"
  | "wrong_duplicate"
  | "wrong_misdelivered"
  | "error";

export type StepTotals = {
  intended: number;
  honest_refusal: number;
  unverified_no_effect: number;
  wrong_worked_without_effect: number;
  wrong_effect_but_refused: number;
  wrong_duplicate: number;
  wrong_misdelivered: number;
  error: number;
};

export interface StepScore {
  n: number;
  label: Label;
  auto: boolean;
  answer: Answer;
  effects: number;
  cls: StepClass;
  ownershipRefusals: number;
  busyRetries: number;
  durationMs: number;
}

export interface ClientScore {
  id: string;
  window: "main" | "second";
  steps: StepScore[];
  totals: StepTotals;
  attempted: number;
  ownershipRefusals: number;
  unattributed: JsonObject[];
  foreignChars: string;
  final: { increments: number | null; customHits: number | null; field: string | null };
  expected: { increments: number; customHits: number; field: string };
  exact: boolean;
  notDone: string[];
  codes: Record<string, number>;
  fatal?: string;
}

const EFFECT_GRACE_MS = 700;

function within(row: JsonObject, step: { start: number; end: number }, nextStart: number): boolean {
  return (
    isNumber(row.ts) &&
    row.ts >= step.start - 30 &&
    row.ts <= step.end + EFFECT_GRACE_MS &&
    row.ts < nextStart - 30
  );
}

export type AllowedRefusal = (label: Label, code: string | undefined, spec: ClientSpec) => boolean;

export function allowedRefusals(delivery: Delivery): AllowedRefusal {
  return (label, code, spec) => {
    if (delivery === "standard" && (label === "click_custom" || label === "drag"))
      return code === "foreground_required";
    if (spec.window === "second" && label === "key")
      return code === "key_window_conflict" || code === "foreground_required";
    return false;
  };
}

export function scoreClient(
  spec: ClientSpec,
  result: ClientResult | undefined,
  rows: JsonObject[],
  launchedAt: number,
  allowed: AllowedRefusal = () => false,
): ClientScore {
  const totals: StepTotals = {
    intended: 0,
    honest_refusal: 0,
    unverified_no_effect: 0,
    wrong_worked_without_effect: 0,
    wrong_effect_but_refused: 0,
    wrong_duplicate: 0,
    wrong_misdelivered: 0,
    error: 0,
  };
  const fieldEvent = spec.window === "main" ? "fieldValue" : "field2Value";
  const mine = (row: JsonObject): boolean =>
    spec.window === "main"
      ? ["increment", "customHit", "fieldValue", "dragUp", "dragDown", "scrollPosition"].includes(
          String(row.event),
        )
      : row.event === "field2Value";
  const effectRows = rows.filter(
    (row) => mine(row) && isNumber(row.ts) && row.ts > launchedAt + 400 && row.event !== "dragDown",
  );
  const used = new Set<JsonObject>();
  const steps: StepScore[] = [];
  const codes: Record<string, number> = {};
  let fieldValue = "";
  let ownership = 0;
  const records = result?.steps ?? [];
  for (const [index, step] of records.entries()) {
    const nextStart = records[index + 1]?.start ?? Number.POSITIVE_INFINITY;
    const answer = answerOf(step);
    if (answer.code) codes[answer.code] = (codes[answer.code] ?? 0) + 1;
    if (step.ownershipRefusals)
      codes.owned_by_other_session_retried =
        (codes.owned_by_other_session_retried ?? 0) + step.ownershipRefusals;
    ownership += step.ownershipRefusals;
    const inside = effectRows.filter((row) => within(row, step, nextStart) && !used.has(row));
    let effects = 0;
    let misdelivered = false;
    let duplicate = false;
    const take = (match: (row: JsonObject) => boolean): JsonObject[] => {
      const hits = inside.filter(match);
      for (const hit of hits) used.add(hit);
      return hits;
    };
    if (step.label === "press") {
      effects = take((row) => row.event === "increment").length;
      duplicate = effects > 1;
    } else if (step.label === "click_custom") {
      effects = take((row) => row.event === "customHit").length;
      duplicate = effects > 1;
    } else if (step.label === "drag") {
      const ups = take((row) => row.event === "dragUp");
      effects = ups.filter((row) => row.startRegion === "A" && row.endRegion === "B").length;
      duplicate = ups.length > 1;
    } else if (step.label === "scroll_down" || step.label === "scroll_up") {
      effects = take((row) => row.event === "scrollPosition").length > 0 ? 1 : 0;
    } else if (step.label === "type" || step.label === "key") {
      const values = take((row) => row.event === fieldEvent).map((row) =>
        isString(row.value) ? row.value : "",
      );
      const before = fieldValue;
      const after = values.at(-1) ?? before;
      const intended = step.label === "type" ? before + spec.text : before.slice(0, -1);
      if (values.length > 0) {
        effects = after === intended ? 1 : 0;
        if (after !== intended) misdelivered = true;
        if (step.label === "type" && after.split(spec.text).length > 2) duplicate = true;
      }
      fieldValue = after;
    }
    const noEffectClaim = answer.kind === "refused" || answer.kind === "didnt";
    let cls: StepClass;
    if (step.label === "find" || step.label === "observe")
      cls =
        answer.kind === "ok" ? "intended" : answer.kind === "refused" ? "honest_refusal" : "error";
    else if (duplicate) cls = "wrong_duplicate";
    else if (misdelivered) cls = "wrong_misdelivered";
    else if (effects > 0)
      cls =
        noEffectClaim && answer.effectPossible === false
          ? "wrong_effect_but_refused"
          : noEffectClaim && answer.kind === "didnt"
            ? "wrong_effect_but_refused"
            : "intended";
    else if (answer.kind === "worked") cls = "wrong_worked_without_effect";
    else if (noEffectClaim) cls = "honest_refusal";
    else if (answer.kind === "unknown") cls = "unverified_no_effect";
    else cls = "error";
    totals[cls] += 1;
    steps.push({
      n: step.n,
      label: step.label,
      auto: step.auto,
      answer,
      effects,
      cls,
      ownershipRefusals: step.ownershipRefusals,
      busyRetries: step.busyRetries ?? 0,
      durationMs: step.end - step.start,
    });
  }
  const unattributed = effectRows.filter((row) => !used.has(row) && row.event !== "scrollPosition");
  const strayScroll = effectRows.filter((row) => !used.has(row) && row.event === "scrollPosition");
  if (strayScroll.length) unattributed.push({ event: "scrollPosition", count: strayScroll.length });
  const quitting = rows.findLast((row) => row.event === "quitting");
  const finalField = quitting
    ? spec.window === "main"
      ? isString(quitting.value)
        ? quitting.value
        : null
      : isString(quitting.field2)
        ? quitting.field2
        : null
    : null;
  const foreignChars = [...(finalField ?? "")]
    .filter((char) => !spec.chars.includes(char))
    .join("");
  const intendedOf = (label: Label): number =>
    steps.filter((item) => item.label === label && item.cls === "intended" && !item.auto).length;
  const expected = {
    increments: intendedOf("press"),
    customHits: intendedOf("click_custom"),
    field: fieldValue,
  };
  const final = {
    increments:
      spec.window === "main" && quitting && isNumber(quitting.increments)
        ? quitting.increments
        : null,
    customHits:
      spec.window === "main" && quitting && isNumber(quitting.customHits)
        ? quitting.customHits
        : null,
    field: finalField,
  };
  const wrong =
    totals.wrong_duplicate +
    totals.wrong_effect_but_refused +
    totals.wrong_misdelivered +
    totals.wrong_worked_without_effect;
  const requested = steps.filter((item) => !item.auto && item.label !== "find");
  const notDone = requested.filter(
    (item) =>
      item.cls !== "intended" &&
      !(item.cls === "honest_refusal" && allowed(item.label, item.answer.code, spec)),
  );
  const workloadRun = requested.length === spec.workload.filter((label) => label !== "find").length;
  const exact =
    wrong === 0 &&
    notDone.length === 0 &&
    workloadRun &&
    !result?.fatal &&
    result !== undefined &&
    unattributed.length === 0 &&
    foreignChars.length === 0 &&
    (spec.window === "second" ||
      (final.increments === expected.increments && final.customHits === expected.customHits)) &&
    final.field === expected.field;
  return {
    id: spec.id,
    window: spec.window,
    steps,
    totals,
    attempted: steps.filter((item) => !item.auto).length,
    ownershipRefusals: ownership,
    unattributed,
    foreignChars,
    final,
    expected,
    exact,
    notDone: notDone.map(
      (item) => `${item.n}:${item.label}:${item.cls}:${item.answer.code ?? item.answer.kind}`,
    ),
    codes,
    fatal: result ? result.fatal : "no result file",
  };
}

export interface Disturbance {
  at: number;
  source: "lsappinfo" | "fixture";
  pid?: number;
  bundleId?: string;
  who: string;
}

export interface FocusReport {
  disturbances: Disturbance[];
  userActivations: number;
  targetActiveRows: number;
  targetsLeftActive: string[];
}

export function disturbancesOf(
  run: Pick<PhaseRun, "front" | "fixture" | "fixturePids" | "window">,
  owned: { pids: Set<number>; bundleIds: Set<string> },
  allowHolder: boolean,
  holderMustStay = false,
): FocusReport {
  const disturbances: Disturbance[] = [];
  let userActivations = 0;
  const fixturePids = new Map(Object.entries(run.fixturePids).map(([label, pid]) => [pid, label]));
  const holderPid = run.fixturePids.holder;
  const classify = (pid: number | undefined, bundleId: string | undefined): string | undefined => {
    if (pid !== undefined && fixturePids.has(pid)) {
      const label = fixturePids.get(pid) ?? "";
      return allowHolder && pid === holderPid ? undefined : `fixture ${label}`;
    }
    if (pid !== undefined && owned.pids.has(pid)) return "harness or helper process";
    if (bundleId && owned.bundleIds.has(bundleId)) return `owned bundle ${bundleId}`;
    if (bundleId?.startsWith("com.choco-pi.")) return `choco-pi bundle ${bundleId}`;
    return undefined;
  };
  const first = run.front[0];
  for (const sample of run.front.slice(1)) {
    const who = classify(sample.pid, sample.bundleId);
    if (who)
      disturbances.push({
        at: sample.at,
        source: "lsappinfo",
        pid: sample.pid,
        bundleId: sample.bundleId,
        who,
      });
    else userActivations += 1;
  }
  const seen = new Set<string>();
  for (const rows of Object.values(run.fixture))
    for (const row of rows) {
      if (row.event !== "frontmost" || !isNumber(row.ts) || row.ts < run.window.from) continue;
      const pid = isNumber(row.frontPid) ? row.frontPid : undefined;
      const bundleId = isString(row.bundleId) ? row.bundleId : undefined;
      const key = `${Math.round(row.ts / 100)}:${pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const who = classify(pid, bundleId);
      if (who) disturbances.push({ at: row.ts, source: "fixture", pid, bundleId, who });
    }
  if (holderMustStay)
    for (const row of run.fixture.holder ?? []) {
      if (!isNumber(row.ts) || row.ts < run.window.from) continue;
      if (["appInactive", "windowResignKey", "keyDown", "mouseDown"].includes(String(row.event)))
        disturbances.push({
          at: row.ts,
          source: "fixture",
          pid: run.fixturePids.holder,
          who: `holder ${String(row.event)}`,
        });
    }
  disturbances.sort((a, b) => a.at - b.at);
  let targetActiveRows = 0;
  const targetsLeftActive: string[] = [];
  for (const [label, rows] of Object.entries(run.fixture)) {
    if (label === "holder") continue;
    targetActiveRows += rows.filter((row) => row.event === "appActive").length;
    const last = rows
      .filter((row) => row.event === "appActive" || row.event === "appInactive")
      .at(-1);
    const quitting = rows.findLast((row) => row.event === "quitting");
    if (last?.event === "appActive" || quitting?.active === true) targetsLeftActive.push(label);
  }
  void first;
  return { disturbances, userActivations, targetActiveRows, targetsLeftActive };
}

export function holderOf(
  rows: JsonObject[],
  front: FrontSample[],
  holderPid: number | undefined,
): JsonObject {
  const misdelivered = rows.filter(
    (row) =>
      row.event === "keyDown" ||
      row.event === "mouseDown" ||
      (row.event === "fieldValue" && row.value !== ""),
  );
  const focus = rows.filter((row) => row.event === "appActive" || row.event === "appInactive");
  const keyRows = rows.filter(
    (row) =>
      (row.event === "windowKey" || row.event === "windowResignKey") && row.window === "main",
  );
  return {
    misdelivered: misdelivered.map((row) => ({ event: row.event ?? null, ts: row.ts ?? null })),
    deactivations: rows.filter((row) => row.event === "appInactive").length,
    endsActive: focus.at(-1)?.event === "appActive",
    endsKey: keyRows.at(-1)?.event === "windowKey",
    frontmostAtEnd: front.at(-1)?.pid === holderPid,
  };
}

type CodeCounts = Record<string, number>;

function helperCodes(requestRows: JsonObject[]): JsonObject {
  const out: JsonObject = {};
  const bump = (key: string): void => {
    const previous = out[key];
    out[key] = (isNumber(previous) ? previous : 0) + 1;
  };
  for (const row of requestRows) {
    const response = isJsonObject(row.response) ? row.response : undefined;
    const error = response && isJsonObject(response.error) ? response.error : undefined;
    if (error && isString(error.code)) bump(`${String(row.cmd)}:${error.code}`);
    if (row.transportError) bump(`${String(row.cmd)}:transport`);
  }
  return out;
}

async function readRows(path: string): Promise<JsonObject[]> {
  try {
    return parseJsonl(await readFile(path, "utf8"));
  } catch {
    return [];
  }
}

function add(into: Record<string, number>, from: Record<string, number>): void {
  for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + value;
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  if (isMainHelper(options.helperApp, options.helperSocket)) {
    console.error("HELPER_IS_MAIN");
    process.exitCode = 2;
    return;
  }
  await mkdir(options.out, { recursive: true });
  const helperAppReal = await realpath(options.helperApp);
  const checkLog = new RequestLog(join(options.out, "helper-check.jsonl"));
  const checked = await checkHelper(options.helperSocket, helperAppReal, checkLog);
  await checkLog.flush();
  if (checked.blocked) {
    console.error(`BLOCKED(${checked.blocked})`);
    process.exitCode = 2;
    return;
  }
  const helperPid =
    checked.diagnostics && isNumber(checked.diagnostics.pid) ? checked.diagnostics.pid : undefined;
  const build = await buildFixture(options.fixtureRoot);
  const runs: JsonObject[] = [];
  const config: JsonObject = {
    clients: options.clients,
    delivery: options.delivery,
    layout: options.layout,
    process: options.process,
    foreground: options.foreground,
    holder: options.holder,
    reps: options.reps,
    helperApp: options.helperApp,
    helperSocket: options.helperSocket,
    helperPid: helperPid ?? null,
    fixtureHash: build.hash,
  };
  try {
    for (let rep = 1; rep <= options.reps; rep++) {
      const phases: ("parallel" | "sequential")[] =
        options.sequential && rep === 1 ? ["parallel", "sequential"] : ["parallel"];
      for (const phase of phases) {
        const run = await runPhase(options, build, phase, rep);
        const launchedAt = (label: string): number => {
          const row = run.fixture[label]?.find((item) => item.event === "launched");
          return row && isNumber(row.ts) ? row.ts : 0;
        };
        const clients = run.specs.map((spec, index) => {
          const label = options.layout === "windows" ? "t1" : `t${spec.index}`;
          return scoreClient(
            spec,
            run.results[index],
            run.fixture[label] ?? [],
            launchedAt(label),
            allowedRefusals(options.delivery),
          );
        });
        const owned = {
          pids: new Set<number>([process.pid, ...(helperPid ? [helperPid] : [])]),
          bundleIds: new Set<string>([fixtureApps.target.bundleId, fixtureApps.holder.bundleId]),
        };
        const focus = disturbancesOf(
          run,
          owned,
          options.holder,
          options.holder && !options.foreground,
        );
        const requestRows = (await Promise.all(run.requestLogs.map(readRows))).flat();
        const totals: CodeCounts = {};
        const codes: Record<string, number> = {};
        for (const client of clients) {
          add(totals, client.totals);
          add(codes, client.codes);
        }
        const entry: JsonObject = {
          phase,
          rep,
          dir: run.dir,
          wallMs: run.wallMs,
          clientWallMs: run.clientWallMs,
          attempted: clients.reduce((sum, client) => sum + client.attempted, 0),
          totals,
          exactClients: clients.filter((client) => client.exact).length,
          crossDelivery: clients.reduce(
            (sum, client) => sum + client.unattributed.length + (client.foreignChars ? 1 : 0),
            0,
          ),
          duplicates: totals.wrong_duplicate ?? 0,
          ownershipRefusals: clients.reduce((sum, client) => sum + client.ownershipRefusals, 0),
          busyRetries: clients.reduce(
            (sum, client) => sum + client.steps.reduce((n, step) => n + step.busyRetries, 0),
            0,
          ),
          inputSource: { before: run.inputSourceBefore, after: run.inputSourceAfter },
          disturbances: focus.disturbances.map((item) => ({ ...item })),
          userActivations: focus.userActivations,
          targetActiveRows: focus.targetActiveRows,
          targetsLeftActive: focus.targetsLeftActive,
          clientCodes: codes,
          helperCodes: helperCodes(requestRows),
          clients: clients.map((client) => ({
            id: client.id,
            window: client.window,
            exact: client.exact,
            attempted: client.attempted,
            totals: client.totals,
            final: client.final,
            expected: client.expected,
            foreignChars: client.foreignChars,
            unattributed: client.unattributed,
            ownershipRefusals: client.ownershipRefusals,
            notDone: client.notDone,
            fatal: client.fatal ?? null,
            steps: client.steps.map((step) => ({ ...step, answer: { ...step.answer } })),
          })),
          front: run.front.map((sample) => ({ ...sample })),
          window: run.window,
          cleanup: run.cleanup,
          clientLogTails: run.clientLogs,
          requestLogs: run.requestLogs,
          fixtureDir: join(run.dir, "fixture"),
        };
        if (options.holder)
          entry.holder = holderOf(run.fixture.holder ?? [], run.front, run.fixturePids.holder);
        runs.push(entry);
        const t = totals;
        console.log(
          `${phase} rep${rep}: wall=${run.wallMs}ms attempted=${String(entry.attempted)} intended=${t.intended ?? 0} refused=${t.honest_refusal ?? 0} unverified=${t.unverified_no_effect ?? 0} wrong=${(t.wrong_duplicate ?? 0) + (t.wrong_effect_but_refused ?? 0) + (t.wrong_misdelivered ?? 0) + (t.wrong_worked_without_effect ?? 0)} error=${t.error ?? 0} exact=${String(entry.exactClients)}/${clients.length} disturbances=${focus.disturbances.length} leftActive=${focus.targetsLeftActive.join(",") || "none"} ownership=${String(entry.ownershipRefusals)} busyRetries=${String(entry.busyRetries)} inputSource=${JSON.stringify(run.inputSourceBefore)}`,
        );
        await writeFile(
          join(options.out, "summary.json"),
          `${JSON.stringify({ config, status: "running", runs }, null, 1)}\n`,
        );
        if (!options.foreground && focus.disturbances.length > 0) {
          console.log(`FOCUS_TAKEN ${JSON.stringify(focus.disturbances)}`);
          throw new Error("focus taken in user-present mode; configuration stopped");
        }
      }
    }
    await writeFile(
      join(options.out, "summary.json"),
      `${JSON.stringify({ config, status: "done", runs }, null, 1)}\n`,
    );
  } catch (error) {
    await writeFile(
      join(options.out, "summary.json"),
      `${JSON.stringify({ config, status: `stopped: ${String(error)}`, runs }, null, 1)}\n`,
    );
    throw error;
  } finally {
    const swept = await sweepFixtureProcesses(build);
    if (swept.length) console.error(`swept fixture pids ${swept.join(",")}`);
    await unregisterFixture(build);
  }
}

const invoked =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const clientIndex = process.argv.indexOf("--client");
if (!invoked) {
} else if (clientIndex >= 0) {
  const path = process.argv[clientIndex + 1];
  if (!path) throw new Error("--client <spec.json>");
  await clientMain(path);
} else {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
