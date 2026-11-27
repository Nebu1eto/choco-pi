import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { arch } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";
import { unregisterFixture } from "../desktop.ts";
import { buildFixture, fixtureApps, type FixtureBuild } from "../fixture/build.ts";
import { socketBusy } from "../preflight.ts";
import { FixtureSet, frontApp, sweepFixtureProcesses } from "./fixtures.ts";
import { checkHelper } from "./scenarios.ts";
import { isMainHelper } from "./score.ts";
import { RequestLog, Wire } from "./wire.ts";

interface Options {
  helperApp: string;
  helperSocket: string;
  out: string;
  cases: string[];
}

interface Check {
  name: string;
  ok: boolean | null;
  detail?: JsonObject;
}

interface CaseResult {
  id: string;
  verdict: "PASS" | "FAIL" | "BLOCKED" | "INCONCLUSIVE";
  reason?: string;
  checks: Check[];
  notes: JsonObject;
}

class Blocked extends Error {}

const ALL_CASES = ["cancel_wait", "expiry_silent", "expiry_killed", "discovery_hold"];
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const GRANT = { policy: "foreground", foregroundGrant: true };
const EXTENDED = { policy: "background", backgroundDelivery: "extended" };
const TARGET_TITLE = fixtureApps.target.title;
const HOLDER_TITLE = fixtureApps.holder.title;
const EXPIRY_BOUND_MS = 15_000;
const TYPED = "0123456789".repeat(6);

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
      "usage: coordination.ts --helper-app <app> --helper-socket <socket> --out <dir> [--cases <id,id>]",
    );
  const cases = (value("--cases") ?? ALL_CASES.join(",")).split(",").filter(Boolean);
  const unknown = cases.filter((id) => !ALL_CASES.includes(id));
  if (unknown.length > 0) throw new Error("unknown case " + unknown.join(","));
  return {
    helperApp: resolve(helperApp),
    helperSocket: resolve(helperSocket),
    out: resolve(out),
    cases,
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

const errorCode = (reply: JsonObject | undefined): string | undefined =>
  reply && isJsonObject(reply.error) && isString(reply.error.code) ? reply.error.code : undefined;
const resultOf = (reply: JsonObject | undefined): JsonObject | undefined =>
  reply && isJsonObject(reply.result) ? reply.result : undefined;

function findNode(node: JsonObject, match: (node: JsonObject) => boolean): JsonObject | undefined {
  if (match(node)) return node;
  for (const child of Array.isArray(node.children) ? node.children : []) {
    if (!isJsonObject(child)) continue;
    const found = findNode(child, match);
    if (found) return found;
  }
  return undefined;
}

async function windowOf(wire: Wire, pid: number, title: string): Promise<JsonObject | undefined> {
  const listed = await wire.send("listWindows", { pid, session: { ...wire.session } });
  const windows = Array.isArray(listed.reply.result) ? listed.reply.result : [];
  return windows.find((entry): entry is JsonObject => isJsonObject(entry) && entry.title === title);
}

async function lookRef(
  wire: Wire,
  pid: number,
  title: string,
  wanted: (node: JsonObject) => boolean,
): Promise<{ lookId: string; ref: string }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const window = await windowOf(wire, pid, title);
    if (window) {
      const args: JsonObject = {
        includeImage: false,
        readText: "never",
        session: { ...wire.session },
      };
      if (isNumber(window.windowId)) args.windowId = window.windowId;
      if (isString(window.windowRef)) args.windowRef = window.windowRef;
      const result = resultOf((await wire.send("look", args)).reply);
      const node =
        result && isJsonObject(result.outline) ? findNode(result.outline, wanted) : undefined;
      if (result && isString(result.lookId) && node && isString(node.ref))
        return { lookId: result.lookId, ref: node.ref };
    }
    await pause(500);
  }
  throw new Blocked("look: " + title + " element not found");
}

async function claim(wire: Wire): Promise<void> {
  const { reply } = await wire.send("claim", { session: { ...wire.session } });
  if (reply.ok !== true) throw new Blocked("claim refused: " + (errorCode(reply) ?? "?"));
}

async function section(
  wire: Wire,
  op: "acquire" | "release",
  waitMs: number,
  acquireId?: string,
): Promise<JsonObject> {
  const args: JsonObject = { op, waitMs, session: { ...wire.session } };
  if (acquireId) args.acquireId = acquireId;
  return (await wire.send("foregroundSection", args, { timeoutMs: waitMs + 5_000 })).reply;
}

function finish(id: string, checks: Check[], notes: JsonObject): CaseResult {
  const failed = checks.some((check) => check.ok === false);
  const open = checks.some((check) => check.ok === null);
  return { id, verdict: failed ? "FAIL" : open ? "INCONCLUSIVE" : "PASS", checks, notes };
}

async function cancelWait(socket: string, log: RequestLog): Promise<CaseResult> {
  const checks: Check[] = [];
  const notes: JsonObject = {};
  const a = new Wire(socket, log);
  const b = new Wire(socket, log);
  const c = new Wire(socket, log);
  for (const wire of [a, b, c]) await claim(wire);
  try {
    const held = await section(a, "acquire", 1_000);
    if (resultOf(held)?.acquired !== true) throw new Blocked("A could not acquire the section");
    const acquireId = randomUUID();
    const raw = connect(socket);
    raw.on("error", () => undefined);
    const request: JsonObject = {
      id: "coordination-b-acquire",
      cmd: "foregroundSection",
      op: "acquire",
      waitMs: 8_000,
      acquireId,
      session: { ...b.session },
    };
    raw.on("connect", () => raw.write(JSON.stringify(request) + "\n"));
    await pause(400);
    raw.destroy();
    notes.cancel = await section(b, "release", 0, acquireId);
    await pause(200);
    const released = await section(a, "release", 0);
    checks.push({
      name: "A released its section",
      ok: resultOf(released)?.released === true,
      detail: released,
    });
    const next = await section(c, "acquire", 0);
    checks.push({
      name: "C gets the section at once (B's cancelled wait took nothing)",
      ok: resultOf(next)?.acquired === true,
      detail: next,
    });
  } finally {
    for (const wire of [c, b, a]) await section(wire, "release", 0).catch(() => undefined);
    for (const wire of [a, b, c])
      await wire.send("release", { session: { ...wire.session } }).catch(() => undefined);
  }
  return finish("cancel_wait", checks, notes);
}

async function driveA(wire: Wire, targetPid: number): Promise<JsonObject> {
  await claim(wire);
  const acquired = await section(wire, "acquire", 5_000);
  const view = await lookRef(
    wire,
    targetPid,
    TARGET_TITLE,
    (node) => node.identifier === "cu-custom-view",
  );
  const { reply } = await wire.send(
    "act",
    {
      ...wire.actEnvelope(),
      pid: targetPid,
      lookId: view.lookId,
      ...GRANT,
      action: "click",
      target: { ref: view.ref },
      params: {},
    },
    { timeoutMs: 20_000 },
  );
  return { acquired, act: reply, repliedAt: Date.now() };
}

async function driveAInChild(
  options: Options,
  sessionId: string,
  targetPid: number,
  logPath: string,
): Promise<JsonObject> {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      "--child-a",
      options.helperSocket,
      sessionId,
      String(targetPid),
      logPath,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    const line = await new Promise<string>((done, fail) => {
      let buffer = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end >= 0) done(buffer.slice(0, end));
      });
      child.on("exit", (code) => fail(new Blocked("child A exited early (" + String(code) + ")")));
      setTimeout(() => fail(new Blocked("child A did not report")), 30_000);
    });
    const parsed: JsonValue = JSON.parse(line);
    return isJsonObject(parsed) ? parsed : {};
  } finally {
    child.kill("SIGKILL");
  }
}

async function expiry(
  id: string,
  kill: boolean,
  options: Options,
  log: RequestLog,
  fixtures: FixtureSet,
): Promise<CaseResult> {
  const checks: Check[] = [];
  const notes: JsonObject = {};
  const holderLabel = id + "-holder";
  const targetLabel = id + "-target";
  await fixtures.launch({ label: holderLabel, role: "holder" });
  await fixtures.launch({ label: targetLabel, role: "target" });
  await pause(800);
  const holderPid = fixtures.pid(holderLabel);
  const targetPid = fixtures.pid(targetLabel);
  const front = await frontApp();
  if (front?.pid !== holderPid)
    throw new Blocked("the holder is not frontmost (" + String(front?.bundleId) + ")");
  const a = new Wire(options.helperSocket, log);
  const driven = kill
    ? await driveAInChild(
        options,
        a.session.id,
        targetPid,
        join(options.out, id + ".child-requests.jsonl"),
      )
    : await driveA(a, targetPid);
  const lastReply = Date.now();
  notes.acquired = driven.acquired ?? null;
  notes.act = driven.act ?? null;
  const actOk = isJsonObject(driven.act) && driven.act.ok === true;
  const afterAct = await frontApp();
  notes.frontAfterAct = afterAct?.pid ?? null;
  if (!actOk || afterAct?.pid !== targetPid)
    throw new Blocked(
      "the granted act did not leave the target frontmost (" +
        JSON.stringify(driven.act ?? null) +
        ")",
    );
  let backAt: number | undefined;
  while (Date.now() - lastReply < EXPIRY_BOUND_MS + 5_000) {
    const now = await frontApp();
    if (now?.pid === holderPid) {
      backAt = Date.now();
      break;
    }
    await pause(100);
  }
  await pause(400);
  const focusRows = (await fixtures.rows(holderLabel)).filter(
    (row) =>
      (row.event === "windowKey" || row.event === "windowResignKey") &&
      isNumber(row.ts) &&
      row.ts >= lastReply,
  );
  const lastFocus = focusRows.at(-1);
  const backAfterMs = backAt === undefined ? null : backAt - lastReply;
  notes.holderBackAfterMs = backAfterMs;
  checks.push({
    name: "with no request, the holder is frontmost again within " + EXPIRY_BOUND_MS + " ms",
    ok: backAfterMs !== null && backAfterMs <= EXPIRY_BOUND_MS,
    detail: { backAfterMs },
  });
  checks.push({
    name: "the holder's window is key again",
    ok:
      backAt !== undefined && lastFocus?.event === "windowKey" && lastFocus.title === HOLDER_TITLE,
    detail: { lastFocusRow: lastFocus ?? null },
  });
  const b = new Wire(options.helperSocket, log);
  await claim(b);
  const next = await section(b, "acquire", 8_000);
  const recorded = resultOf(next)?.frontmostPid;
  checks.push({
    name: "B, acquiring afterwards, records the holder (not the target) as the user's app",
    ok: resultOf(next)?.acquired === true && recorded === holderPid,
    detail: { reply: next, holderPid, targetPid },
  });
  await pause(300);
  const frontDuringB = await frontApp();
  checks.push({
    name: "no late restore changes focus during B's section",
    ok: frontDuringB?.pid === holderPid,
    detail: { front: frontDuringB?.pid ?? null },
  });
  await section(b, "release", 0).catch(() => undefined);
  for (const wire of [a, b])
    await wire.send("release", { session: { ...wire.session } }).catch(() => undefined);
  await fixtures.quitAll();
  return finish(id, checks, notes);
}

async function discoveryHold(
  options: Options,
  log: RequestLog,
  fixtures: FixtureSet,
): Promise<CaseResult> {
  const checks: Check[] = [];
  const notes: JsonObject = {};
  const a = new Wire(options.helperSocket, log);
  const b = new Wire(options.helperSocket, log);
  const diagnostics = resultOf((await a.send("diagnostics", {})).reply);
  const offSpace =
    diagnostics && isJsonObject(diagnostics.offSpace) ? diagnostics.offSpace : undefined;
  const extended =
    diagnostics && isJsonObject(diagnostics.extendedDelivery)
      ? diagnostics.extendedDelivery
      : undefined;
  if (offSpace?.discoveryAvailable !== true || extended?.available !== true)
    throw new Blocked("discovery or extended delivery unavailable");
  const label = "discovery-target";
  await fixtures.launch({
    label,
    role: "target",
    env: { CU_FIXTURE_WEB: "1", CU_FIXTURE_SPACE: "auto", CU_FIXTURE_SPACE_WINDOWS: "main" },
  });
  const moved = await fixtures.waitFor(label, (row) => row.event === "spaceMove", 5_000);
  notes.spaceMove = moved ?? null;
  if (!moved || moved.moved !== true)
    throw new Blocked(
      "no hidden desktop Space for the main window (" + JSON.stringify(moved ?? null) + ")",
    );
  if (!(await fixtures.waitFor(label, (row) => row.event === "webReady", 10_000)))
    throw new Blocked("web window not ready");
  await pause(500);
  const pid = fixtures.pid(label);
  await claim(a);
  await claim(b);
  const web = await lookRef(
    a,
    pid,
    "CU Fixture Web",
    (node) => node.role === "AXTextField" && node.title === "Web Field",
  );
  const mainWindow = await windowOf(b, pid, TARGET_TITLE);
  notes.mainWindow = mainWindow ?? null;
  if (!mainWindow || !isNumber(mainWindow.windowId)) throw new Blocked("main window not listed");
  const startedAt = Date.now();
  const typing = a.send(
    "act",
    {
      ...a.actEnvelope(),
      pid,
      lookId: web.lookId,
      ...EXTENDED,
      action: "typeText",
      target: { ref: web.ref },
      params: { text: TYPED },
    },
    { timeoutMs: 60_000 },
  );
  await pause(300);
  const observing = b.send(
    "look",
    {
      windowId: mainWindow.windowId,
      includeImage: false,
      readText: "never",
      backgroundDelivery: "extended",
      session: { ...b.session },
    },
    { timeoutMs: 30_000 },
  );
  const [typed, observed] = await Promise.all([typing, observing]);
  await pause(1_000);
  const rows = (await fixtures.rows(label)).filter(
    (row) => isNumber(row.ts) && row.ts >= startedAt,
  );
  const lastWeb = rows.filter((row) => row.event === "webValue").at(-1);
  const keyRows = rows.filter(
    (row) =>
      (row.event === "targetKeyDown" && row.window !== "web") ||
      (row.event === "fieldValue" && isNumber(row.length) && row.length > 0),
  );
  const observedResult = resultOf(observed.reply);
  const offSpaceInfo =
    observedResult && isJsonObject(observedResult.offSpace) ? observedResult.offSpace : undefined;
  notes.typeReply = { ok: typed.reply.ok ?? null, error: typed.reply.error ?? null };
  notes.lookReply = {
    ok: observed.reply.ok ?? null,
    error: observed.reply.error ?? null,
    offSpace: offSpaceInfo ?? null,
  };
  notes.timing = { type: typed.row, look: observed.row };
  checks.push({
    name: "every digit landed in the web input",
    ok: lastWeb?.value === TYPED,
    detail: { last: lastWeb ?? null },
  });
  checks.push({
    name: "no key reached the main window",
    ok: keyRows.length === 0,
    detail: { rows: keyRows.length, first: keyRows[0] ?? null },
  });
  const lookCode = errorCode(observed.reply);
  const typedAt = typed.row.respondedAt;
  const lookAt = observed.row.respondedAt;
  const waited = isNumber(lookAt) && isNumber(typedAt) && lookAt >= typedAt;
  checks.push({
    name: "B's discovery waited for A's act or was refused target_busy",
    ok: lookCode === "target_busy" || (observed.reply.ok === true && waited),
    detail: { code: lookCode ?? null, waited },
  });
  checks.push({
    name: "a discovery activation was exercised (else this proves nothing)",
    ok: lookCode === "target_busy" || offSpaceInfo?.discoveryActivation === true ? true : null,
    detail: { offSpace: offSpaceInfo ?? null },
  });
  for (const wire of [a, b])
    await wire.send("release", { session: { ...wire.session } }).catch(() => undefined);
  await fixtures.quitAll();
  return finish("discovery_hold", checks, notes);
}

async function childA(argv: string[]): Promise<number> {
  const [socket, sessionId, targetPid, logPath] = argv;
  if (!socket || !sessionId || !targetPid || !logPath) return 2;
  const wire = new Wire(socket, new RequestLog(logPath));
  wire.session.id = sessionId;
  const driven = await driveA(wire, Number(targetPid));
  process.stdout.write(JSON.stringify(driven) + "\n");
  await pause(120_000);
  return 0;
}

async function runCase(
  id: string,
  options: Options,
  log: RequestLog,
  build: FixtureBuild,
): Promise<CaseResult> {
  const fixtures = new FixtureSet(join(options.out, "fixture-" + id), build);
  await fixtures.prepare();
  try {
    if (id === "cancel_wait") return await cancelWait(options.helperSocket, log);
    if (id === "discovery_hold") return await discoveryHold(options, log, fixtures);
    return await expiry(id, id === "expiry_killed", options, log, fixtures);
  } catch (error) {
    return {
      id,
      verdict: error instanceof Blocked ? "BLOCKED" : "FAIL",
      reason: error instanceof Error ? error.message : String(error),
      checks: [],
      notes: {},
    };
  } finally {
    await fixtures.quitAll().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const childIndex = process.argv.indexOf("--child-a");
  if (childIndex >= 0) return await childA(process.argv.slice(childIndex + 1));
  let options: Options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    console.error("ARGUMENT " + (error instanceof Error ? error.message : String(error)));
    return 2;
  }
  if (isMainHelper(options.helperApp, options.helperSocket)) {
    console.error("HELPER_IS_MAIN");
    return 2;
  }
  if (process.platform !== "darwin" || arch() !== "arm64") return 2;
  const summaryPath = join(options.out, "summary.json");
  if (await exists(summaryPath)) {
    console.error("OUT_NOT_FRESH " + summaryPath);
    return 2;
  }
  if (!(await socketBusy(options.helperSocket))) {
    console.error("HELPER_SOCKET no daemon at " + options.helperSocket);
    return 2;
  }
  await mkdir(options.out, { recursive: true });
  const log = new RequestLog(join(options.out, "requests.jsonl"));
  const build = await buildFixture(join(options.out, "fixture-build"));
  const results: CaseResult[] = [];
  const summary: JsonObject = { startedAt: new Date().toISOString() };
  try {
    const checked = await checkHelper(options.helperSocket, await realpath(options.helperApp), log);
    if (checked.blocked) throw new Blocked(checked.blocked);
    for (const id of options.cases) results.push(await runCase(id, options, log, build));
  } catch (error) {
    summary.status = "BLOCKED(" + (error instanceof Error ? error.message : String(error)) + ")";
  } finally {
    summary.sweptFixturePids = await sweepFixtureProcesses(build);
    await unregisterFixture(build).catch(() => undefined);
    await log.flush();
  }
  const complete = summary.status === undefined;
  summary.status ??= "complete";
  summary.cases = results.map((result) => ({
    id: result.id,
    verdict: result.verdict,
    reason: result.reason ?? null,
    checks: result.checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      detail: check.detail ?? null,
    })),
    notes: result.notes,
  }));
  summary.finishedAt = new Date().toISOString();
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  for (const result of results) {
    console.log(
      "coordination " +
        result.id +
        ": " +
        result.verdict +
        (result.reason ? " (" + result.reason + ")" : ""),
    );
    for (const check of result.checks) console.log("  " + String(check.ok) + "  " + check.name);
  }
  const pass =
    complete && results.length > 0 && results.every((result) => result.verdict === "PASS");
  console.log(
    "coordination " +
      (pass ? "PASS" : "FAIL") +
      " " +
      String(summary.status) +
      " (" +
      summaryPath +
      ")",
  );
  return pass ? 0 : 1;
}

process.exit(await main());
