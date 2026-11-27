import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { arch } from "node:os";
import { join, resolve } from "node:path";
import type { JsonObject } from "../../src/json.ts";
import { unregisterFixture } from "../desktop.ts";
import { buildFixture, fixtureApps, type FixtureBuild } from "../fixture/build.ts";
import { command, socketBusy } from "../preflight.ts";
import { FixtureSet, frontApp, sweepFixtureProcesses, type FrontApp } from "./fixtures.ts";
import { GuardProxy } from "./guard-proxy.ts";
import {
  Blocked,
  checkHelper,
  scenarios,
  type Scenario,
  type ScenarioContext,
} from "./scenarios.ts";
import { isMainHelper, type Score, type Verdict } from "./score.ts";
import { loadTsLayer, type TsLayer } from "./ts-layer.ts";
import { RequestLog, Wire } from "./wire.ts";

interface Options {
  helperApp: string;
  helperSocket: string;
  out: string;
  ids: string[];
}

class ArgumentError extends Error {}

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
      "usage: run.ts --helper-app <app> --helper-socket <socket> --out <dir> [--scenarios <ids>]",
    );
  const filter = value("--scenarios");
  const known = new Set(scenarios.map((scenario) => scenario.id));
  const ids = filter
    ? filter
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : [...known];
  for (const id of ids)
    if (!known.has(id))
      throw new ArgumentError(`unknown scenario ${id}; known: ${[...known].join(", ")}`);
  if (new Set(ids).size !== ids.length) throw new ArgumentError("duplicate scenario id");
  return {
    helperApp: resolve(helperApp),
    helperSocket: resolve(helperSocket),
    out: resolve(out),
    ids,
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

interface Entry {
  id: string;
  layer: string;
  asserts: string;
  verdict: Verdict;
  firstFailure: string | null;
  failures: string[];
  answers: JsonObject[];
  notes: JsonObject;
  diagnostics: JsonObject | null;
  logs: { requests: string; fixtures: Record<string, string> };
  window: { from: number; to: number } | null;
  durationMs: number;
  cleanup: string[];
}

function withTimeout<T>(work: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`scenario timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

interface RunState {
  options: Options;
  helperAppReal: string;
  build: FixtureBuild;
  guard: GuardProxy;
  ts: () => Promise<TsLayer>;
}

async function runScenario(state: RunState, scenario: Scenario): Promise<Entry> {
  const started = Date.now();
  const dir = join(state.options.out, scenario.id);
  await mkdir(dir);
  const log = new RequestLog(join(dir, "requests.jsonl"));
  state.guard.log = log;
  const fixtures = new FixtureSet(join(dir, "fixture"), state.build);
  await fixtures.prepare();
  const ctx: ScenarioContext = {
    id: scenario.id,
    fixtures,
    wire: new Wire(state.options.helperSocket, log),
    signal: new AbortController().signal,
    ts: state.ts,
    answers: [],
    notes: {},
    window: { from: 0, to: 0 },
    usedTs: false,
  };
  let score: Score;
  let diagnostics: JsonObject | null = null;
  const cleanup: string[] = [];
  const blockedBefore = state.guard.blocked.length;
  try {
    const checked = await checkHelper(state.options.helperSocket, state.helperAppReal, log);
    diagnostics = checked.diagnostics ?? null;
    if (checked.blocked) throw new Blocked(checked.blocked);
    const controller = new AbortController();
    ctx.signal = controller.signal;
    score = await withTimeout(scenario.run(ctx), scenario.timeoutMs, controller);
  } catch (error) {
    if (error instanceof Blocked)
      score = { verdict: `BLOCKED(${error.reason})`, failures: [], notes: {} };
    else {
      const message = error instanceof Error ? error.message : String(error);
      score = { verdict: "FAIL", failures: [`harness: ${message}`], notes: {} };
    }
  } finally {
    if (ctx.usedTs) {
      const ts = await state.ts().catch(() => undefined);
      await ts?.reset();
    }
    await ctx.wire
      .send("release", { session: { ...ctx.wire.session } }, { timeoutMs: 2_000 })
      .catch(() => undefined);
    cleanup.push(...(await fixtures.quitAll()));
    await log.flush();
  }
  const forbidden = state.guard.blocked.slice(blockedBefore);
  if (forbidden.length > 0 && !score.verdict.startsWith("BLOCKED"))
    score = {
      ...score,
      verdict: `BLOCKED(ts_requested_forbidden: ${forbidden.map((row) => String(row.cmd)).join(",")})`,
    };
  if (cleanup.length > 0 && score.verdict !== "FAIL" && !score.verdict.startsWith("BLOCKED"))
    score = {
      ...score,
      verdict: "FAIL",
      failures: [...score.failures, ...cleanup.map((defect) => `HARNESS_DEFECT(${defect})`)],
    };
  const fixtureLogs: Record<string, string> = {};
  for (const instance of fixtures.instances.values()) fixtureLogs[instance.label] = instance.log;
  return {
    id: scenario.id,
    layer: scenario.layer,
    asserts: scenario.asserts,
    verdict: score.verdict,
    firstFailure: score.failures[0] ?? null,
    failures: score.failures,
    answers: ctx.answers,
    notes: { ...ctx.notes, ...score.notes },
    diagnostics,
    logs: { requests: log.path, fixtures: fixtureLogs },
    window: ctx.window.from ? { ...ctx.window } : null,
    durationMs: Date.now() - started,
    cleanup,
  };
}

async function reactivate(front: FrontApp | undefined): Promise<string> {
  const bundleId = front?.bundleId;
  if (!bundleId) return "skipped: no recorded frontmost app";
  if (bundleId === fixtureApps.target.bundleId || bundleId === fixtureApps.holder.bundleId)
    return "skipped: frontmost before the run was a fixture";
  const found = await command("lsappinfo", ["find", `bundleid=${bundleId}`]);
  if (!found.stdout.trim()) return `skipped: ${bundleId} no longer running`;
  const opened = await command("open", ["-b", bundleId]);
  return opened.code === 0
    ? `reactivated ${bundleId}`
    : `open -b ${bundleId} failed: ${opened.stderr.trim()}`;
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
    console.error("HELPER_IS_MAIN the safety harness must not use the main helper app or socket");
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
  const proxySocket = join(options.out, "ts.sock");
  if (Buffer.byteLength(proxySocket) > 100) {
    console.error(`ARGUMENT --out path too long for a unix socket (${proxySocket})`);
    return 2;
  }
  const frontBefore = await frontApp();
  const build = await buildFixture(join(options.out, "fixture-build"));
  const guard = new GuardProxy(proxySocket, options.helperSocket);
  await guard.start();
  let tsPromise: Promise<TsLayer> | undefined;
  const ts = (): Promise<TsLayer> => {
    tsPromise ??= loadTsLayer({
      socket: proxySocket,
      helperApp: options.helperApp,
      foregroundGrant: fixtureApps.target.bundleId,
      agentDir: join(options.out, "ts-agent"),
      cwd: join(options.out, "ts-project"),
    });
    return tsPromise;
  };
  const state: RunState = { options, helperAppReal, build, guard, ts };
  const entries: Entry[] = [];
  const summary = (status: string, extra: JsonObject = {}): string =>
    `${JSON.stringify(
      {
        status,
        startedAt: new Date(startedAt).toISOString(),
        helper: {
          app: options.helperApp,
          socket: options.helperSocket,
          tsProxySocket: proxySocket,
        },
        fixture: { hash: build.hash, dir: build.dir },
        frontBefore: frontBefore ?? null,
        filters: { scenarios: options.ids },
        scenarios: entries,
        ...extra,
      },
      null,
      2,
    )}\n`;
  const startedAt = Date.now();
  let status = "complete";
  let restoredFront = "";
  let swept: number[] = [];
  try {
    for (const scenario of scenarios.filter((candidate) => options.ids.includes(candidate.id))) {
      const entry = await runScenario(state, scenario);
      entries.push(entry);
      console.log(
        `safety ${entry.id} ${entry.verdict}${entry.firstFailure ? ` -- ${entry.firstFailure}` : ""}`,
      );
      await writeFile(summaryPath, summary("running"));
    }
  } catch (error) {
    status = `ABORTED(${error instanceof Error ? error.message : String(error)})`;
  } finally {
    await guard.stop();
    swept = await sweepFixtureProcesses(build);
    await unregisterFixture(build).catch(() => undefined);
    restoredFront = await reactivate(frontBefore).catch(
      (error: Error) => `failed: ${error.message}`,
    );
  }
  const failed = entries.filter(
    (entry) => entry.verdict === "FAIL" || entry.verdict.startsWith("BLOCKED"),
  );
  await writeFile(
    summaryPath,
    summary(status, {
      finishedAt: new Date().toISOString(),
      sweptFixturePids: swept,
      frontRestore: restoredFront,
    }),
  );
  console.log(
    `safety summary ${summaryPath} (${failed.length} failing or blocked of ${entries.length})`,
  );
  return status === "complete" && failed.length === 0 ? 0 : 1;
}

process.exit(await main());
