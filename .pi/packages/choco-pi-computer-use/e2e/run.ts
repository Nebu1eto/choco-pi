import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  field,
  jsonl,
  verify,
  verdictOf,
  isolationCheck,
  isolationBlock as blockAfterIsolation,
  type ScenarioNotes,
} from "./assertions.ts";
import { isJsonObject, isString, type JsonObject, type JsonValue } from "../src/json.ts";
import {
  fixtureRows,
  holderFrontmost,
  launchFixture,
  newFixtureRun,
  quitFixture,
  resizeTarget,
  unregisterFixture,
  FixtureLaunchError,
  type FixtureRun,
} from "./desktop.ts";
import { buildFixture, fixtureApps, type FixtureBuild } from "./fixture/build.ts";
import { launch, wire } from "./launch.ts";
import {
  models,
  packagePath,
  piPath,
  plan,
  printable,
  scratchRoot,
  setup,
  slug,
  type Plan,
  type Tier,
  type TierBHelper,
} from "./isolation.ts";
import {
  GateError,
  command,
  gateNames,
  preflight,
  socketBusy,
  type GateName,
} from "./preflight.ts";
import { scenarios, type ScenarioId } from "./scenarios/index.ts";
import { list, selectModels, selectScenarios } from "./selection.ts";
import {
  KILL_GRACE_MS,
  WAIT_BOUND_MS,
  closeSink,
  drainOutput,
  escalate,
  sink,
  stopProcess,
  within,
  type Sink,
} from "./process.ts";
import type { FixtureEvidence } from "./tier-b.ts";

/** Per-scenario wall-clock budget; the model budget below caps it further. */
const SCENARIO_MS = 4 * 60_000;
/**
 * Tier B S4: the proxy cancels a typeText still in flight after this long. The TS transport
 * timeout is max(15 s, chars*25 ms + 4 s) while the real helper types about 12 ms per character,
 * so the transport timeout never fires before the helper finishes; the proxy sends the same
 * `cancel {target: requestId}` instead.
 */
const S4_HARNESS_CANCEL_MS = 3000;
/** A scenario that could not start for a harness-side precondition (fixture, focus). */
class BlockedError extends Error {}
/**
 * S4 waits out the TS transport timeout for its held typeText (max(15 s, chars*25+4 s), 15 s for
 * the 400-character prompt) before the cancel, then needs model turns; one extra minute covers
 * the hold and keeps S4 well above timeout + 90 s.
 */
function scenarioMs(scenario: ScenarioId): number {
  return scenario === "S4" ? SCENARIO_MS + 60_000 : SCENARIO_MS;
}
interface Daemon {
  child: ChildProcess;
  log: Sink;
}
/**
 * Never let a daemon inherit the harness's stdout/stderr: an inherited descriptor keeps the
 * harness output open after the harness is done. Both streams are drained into a scenario log
 * so a chatty daemon cannot block on a full pipe.
 */
function daemon(p: Plan, file: string, args: string[]): Daemon {
  const log = sink(p.daemonLog);
  const child = spawn(file, args, { cwd: p.cwd, env: p.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk: Buffer) => log.stream.write(chunk));
  child.stderr.on("data", (chunk: Buffer) => log.stream.write(chunk));
  child.once("error", (error) => log.errors.push(`spawn: ${error.message}`));
  return { child, log };
}
/** Bounded daemon shutdown; returns harness defects instead of waiting indefinitely. */
async function stopDaemon(target: Daemon): Promise<string[]> {
  const defects: string[] = [];
  const stop = await stopProcess(target.child, "daemon");
  if (stop) defects.push(stop);
  const drain = await drainOutput(target.child, "daemon");
  if (drain) defects.push(drain);
  defects.push(...(await closeSink(target.log, "daemon log")));
  return defects;
}
interface DaemonLauncher {
  start(p: Plan, scenario: ScenarioId): Promise<Daemon>;
}
class TierADaemon implements DaemonLauncher {
  async start(p: Plan, scenario: ScenarioId): Promise<Daemon> {
    const script = join(
      p.cwd,
      ".pi/packages/choco-pi-computer-use/tests/helpers/fake-helper-daemon.ts",
    );
    try {
      await readFile(script);
    } catch {
      throw new GateError("FAKE_DAEMON_MISSING", script);
    }
    return daemon(p, process.execPath, [
      "--experimental-strip-types",
      script,
      "--socket",
      p.socket,
      "--script",
      scenario,
      "--log",
      p.requests,
      "--executable-path",
      join(p.helperApp, "Contents/MacOS/bridge"),
    ]);
  }
}
/** Tier B: the logging proxy between Pi and the already running dev helper daemon. */
function proxyArgs(p: Plan, scenario: ScenarioId): string[] {
  return [
    "--experimental-strip-types",
    fileURLToPath(new URL("./proxy.ts", import.meta.url)),
    "--listen",
    p.socket,
    "--upstream",
    p.upstream ?? "",
    "--log",
    p.requests,
    ...(scenario === "S4" ? ["--cancel-typetext-after-ms", String(S4_HARNESS_CANCEL_MS)] : []),
  ];
}
class TierBProxy implements DaemonLauncher {
  async start(p: Plan, scenario: ScenarioId): Promise<Daemon> {
    if (!p.upstream) throw new GateError("ARGUMENT", "tier b requires --helper-socket");
    return daemon(p, process.execPath, proxyArgs(p, scenario));
  }
}
/** Prompt for a scenario; a tier-specific `<id>.<tier>.txt` overrides `<id>.txt`. */
async function promptFor(tier: Tier, scenario: ScenarioId): Promise<string> {
  const specific = new URL(`./scenarios/${scenario}.${tier}.txt`, import.meta.url);
  try {
    await access(specific);
    return await readFile(specific, "utf8");
  } catch {
    return await readFile(new URL(`./scenarios/${scenario}.txt`, import.meta.url), "utf8");
  }
}
interface Options {
  tier: Tier;
  dryRun: boolean;
  preflightOnly: boolean;
  pi: string;
  baseline?: string;
  mainDaemonPid?: number;
  helper?: TierBHelper;
  substitutions: Map<string, string>;
  requestedWaivers: Map<GateName, string>;
  modelFilter?: string[];
  scenarioFilter?: string[];
}
function options(argv: string[]): Options {
  let tier: Tier = "a";
  let dryRun = false;
  let preflightOnly = false;
  let pi = piPath;
  let baseline: string | undefined;
  let mainDaemonPid: number | undefined;
  let helperApp: string | undefined;
  let helperSocket: string | undefined;
  const substitutions = new Map<string, string>();
  const requestedWaivers = new Map<GateName, string>();
  let modelFilter: string[] | undefined;
  let scenarioFilter: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tier" && argv[i + 1] === "a") {
      tier = "a";
      i++;
    } else if (arg === "--tier" && argv[i + 1] === "b") {
      tier = "b";
      i++;
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--preflight-only") preflightOnly = true;
    else if (arg === "--pi" && argv[i + 1]) pi = argv[++i];
    else if (arg === "--baseline" && argv[i + 1]) baseline = argv[++i];
    else if (arg === "--helper-app" && argv[i + 1]) helperApp = argv[++i];
    else if (arg === "--helper-socket" && argv[i + 1]) helperSocket = argv[++i];
    else if (arg === "--models" && argv[i + 1] && !modelFilter)
      modelFilter = list("--models", argv[++i]);
    else if (arg === "--scenarios" && argv[i + 1] && !scenarioFilter)
      scenarioFilter = list("--scenarios", argv[++i]);
    else if (arg === "--main-daemon-pid" && argv[i + 1]) {
      mainDaemonPid = Number(argv[++i]);
      if (!Number.isSafeInteger(mainDaemonPid) || mainDaemonPid <= 0)
        throw new GateError("ARGUMENT", "invalid daemon pid");
    } else if (arg === "--substitute" && argv[i + 1]) {
      const [from, to] = argv[++i].split("=");
      if (!models.some((model) => model === from) || !to?.includes("/"))
        throw new GateError("ARGUMENT", "invalid substitution");
      substitutions.set(from, to);
    } else if (arg === "--waive-gate" && argv[i + 1]) {
      const waiver = argv[++i];
      const separator = waiver.indexOf("=");
      const gate = gateNames.find((name) => name === waiver.slice(0, separator));
      const reason = waiver.slice(separator + 1).trim();
      if (
        separator < 0 ||
        !gate ||
        !reason ||
        [...reason].some((character) => character.charCodeAt(0) < 32) ||
        requestedWaivers.has(gate)
      )
        throw new GateError(
          "ARGUMENT",
          "--waive-gate requires a unique lint|fmt:check|typecheck|test=<reason>",
        );
      requestedWaivers.set(gate, reason);
    } else throw new GateError("ARGUMENT", `unexpected ${arg}`);
  }
  if ((helperApp === undefined) !== (helperSocket === undefined) || (helperApp && tier !== "b"))
    throw new GateError("ARGUMENT", "--helper-app and --helper-socket go together, tier b only");
  return {
    tier,
    dryRun,
    preflightOnly,
    pi,
    baseline,
    mainDaemonPid,
    helper: helperApp && helperSocket ? { app: helperApp, socket: helperSocket } : undefined,
    substitutions,
    requestedWaivers,
    modelFilter,
    scenarioFilter,
  };
}
async function sessionRows(root: string, sessionId: string): Promise<ReturnType<typeof jsonl>> {
  const directories = await readdir(join(root, "sessions"), { recursive: true });
  const path = directories.find((name) => name.endsWith(`_${sessionId}.jsonl`));
  if (!path) throw new Error(`SESSION_MISSING ${sessionId}`);
  return jsonl(join(root, "sessions", path));
}
async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function mainDaemonPids(explicit?: number): Promise<number[]> {
  if (explicit) return [explicit];
  const found = await command("pgrep", ["-f", "bridge serve --socket"]);
  const pids = found.stdout
    .trim()
    .split("\n")
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  if (found.code !== 0 || pids.length === 0)
    throw new GateError("MAIN_DAEMON_MISSING", "pass --main-daemon-pid");
  return pids;
}
/**
 * Tier B: the dev daemon (queried directly, not through the proxy) runs protocol 7 from the dev
 * app and holds both permissions. Returns the executable path it reports.
 */
async function checkTierB(p: Plan): Promise<string> {
  const socket = p.upstream;
  if (!socket) throw new GateError("ARGUMENT", "tier b requires --helper-socket");
  const diagnostics = await wire(socket, { id: randomUUID(), cmd: "diagnostics" });
  const values = field(diagnostics, "result");
  const executable = field(values, "executablePath");
  if (
    field(values, "protocolVersion") !== 7 ||
    !isString(executable) ||
    (await realpath(executable)) !== (await realpath(join(p.helperApp, "Contents/MacOS/bridge")))
  )
    throw new GateError("HELPER_DIAGNOSTICS", "protocol or dev executable mismatch");
  const permissions = await wire(socket, { id: randomUUID(), cmd: "checkPermissions" });
  const granted = field(permissions, "result");
  if (
    field(granted, "accessibility") !== true ||
    field(granted, "screenRecordingCapturable") !== true
  )
    throw new GateError(
      "PERMISSIONS",
      "System Settings: Privacy & Security > Accessibility and Screen & System Audio Recording",
    );
  return executable;
}
/**
 * Tier B shares one daemon across scenarios: wait (at most 40 s, beyond the 30 s owner TTL) until
 * no earlier Pi session owns it, proven by a harness claim that is released at once.
 */
async function ownerFree(socket: string): Promise<void> {
  const session = { id: `e2e-harness-${randomUUID()}`, generation: 0 };
  const until = Date.now() + 40_000;
  for (;;) {
    const claimed = await wire(socket, { id: randomUUID(), cmd: "claim", session });
    if (claimed.ok === true) {
      const released = await wire(socket, { id: randomUUID(), cmd: "release", session });
      if (field(field(released, "result"), "released") !== true)
        throw new BlockedError("owner: harness claim was not released");
      return;
    }
    if (field(field(claimed, "error"), "code") !== "owned_by_other_session" || Date.now() > until)
      throw new BlockedError(`owner: ${JSON.stringify(field(claimed, "error"))}`);
    await new Promise((done) => setTimeout(done, 2000));
  }
}
async function ready(socket: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (await socketBusy(socket)) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new GateError("DAEMON_START_FAILED", socket);
}
async function run(): Promise<void> {
  const args = options(process.argv.slice(2));
  const selectedScenarios = selectScenarios(args.tier, args.scenarioFilter);
  const pairs = models.map((original) => ({
    original,
    resolved: args.substitutions.get(original) ?? original,
  }));
  selectModels(pairs, args.modelFilter);
  const root = scratchRoot();
  try {
    await setup(root, args.tier);
  } catch (error) {
    throw new GateError("ISOLATION_DIR", error instanceof Error ? error.message : String(error));
  }
  const checked = await preflight({
    root,
    tier: args.tier,
    executable: args.pi,
    substitutions: args.substitutions,
    dryRun: args.dryRun,
    baseline: args.baseline,
    requireBaseline: args.preflightOnly || !args.dryRun,
    requestedWaivers: args.requestedWaivers,
    helper: args.helper,
  });
  if (checked.models.some((model, index) => model !== pairs[index]?.resolved))
    throw new GateError("ARGUMENT", "preflight model resolution mismatch");
  const resolved = selectModels(pairs, args.modelFilter);
  const scenarioRows = scenarios.filter((row) => selectedScenarios.includes(row.id));
  const summaryPath = join(root, "summary.json");
  const verdicts: {
    tier: Tier;
    model: string;
    scenario: ScenarioId;
    verdict: string;
    notes?: ScenarioNotes;
  }[] = [];
  /** Tier B provenance recorded in summary.json (helper, proxy, fixture build). */
  let tierB: JsonObject | undefined;
  async function summary(status: string): Promise<void> {
    const content: JsonObject = {
      tier: args.tier,
      models: resolved,
      filters: {
        models: args.modelFilter ?? null,
        scenarios: args.scenarioFilter ? selectedScenarios : null,
      },
      baseline: checked.baseline ?? null,
      gateWaivers: checked.waivers.map((waiver) => ({ ...waiver })),
    };
    if (tierB) content.tierB = tierB;
    content.status = status;
    await writeFile(summaryPath, `${JSON.stringify({ ...content, verdicts }, null, 2)}\n`);
  }
  await summary(args.dryRun ? "dry-run" : args.preflightOnly ? "preflight-only" : "running");
  const system = await readFile(new URL("./scenarios/system.txt", import.meta.url), "utf8");
  console.log(
    `E2E=${root}\nmodels=${resolved.join(",")}\nscenarios=${selectedScenarios.join(",")}`,
  );
  for (const waiver of checked.waivers)
    console.log(
      `Gate waiver: ${waiver.gate} | baseline=${waiver.baselineStatus} | reason=${waiver.reason}`,
    );
  console.log(`summary=${summaryPath}`);
  if (args.dryRun) {
    for (const model of resolved)
      for (const scenario of scenarioRows) {
        const prompt = await promptFor(args.tier, scenario.id);
        const p = plan(root, args.tier, model, scenario.id, prompt, system, args.pi, args.helper);
        console.log(`\n${args.tier}/${model}/${scenario.id}\n${printable(p)}`);
        const fake = join(
          p.cwd,
          ".pi/packages/choco-pi-computer-use/tests/helpers/fake-helper-daemon.ts",
        );
        console.log(
          `daemon=${JSON.stringify(
            args.tier === "a"
              ? [
                  process.execPath,
                  "--experimental-strip-types",
                  fake,
                  "--socket",
                  p.socket,
                  "--script",
                  scenario.id,
                  "--log",
                  p.requests,
                  "--executable-path",
                  join(p.helperApp, "Contents/MacOS/bridge"),
                ]
              : [process.execPath, ...proxyArgs(p, scenario.id)],
          )}`,
        );
        if (args.tier === "b")
          console.log(
            `fixture=open -n --env CU_FIXTURE_LOG=${join(p.fixtureDir, "holder.jsonl")} <${fixtureApps.holder.name}.app>; open -n -g --env CU_FIXTURE_LOG=${join(p.fixtureDir, "target.jsonl")} <${fixtureApps.target.name}.app>`,
          );
      }
    console.log(
      "dry-run: no Pi process spawned; version/model-list and live daemon gates deferred",
    );
    return;
  }
  if (args.preflightOnly) {
    console.log("preflight PASS");
    return;
  }
  const baselinePids = await mainDaemonPids(args.mainDaemonPid);
  if (!(await Promise.all(baselinePids.map(alive))).every(Boolean))
    throw new GateError("MAIN_DAEMON_MISSING", baselinePids.join(","));
  let build: FixtureBuild | undefined;
  if (args.tier === "b") {
    try {
      build = await buildFixture(join(root, "b", "fixture"));
    } catch (error) {
      throw new GateError("FIXTURE_BUILD", error instanceof Error ? error.message : String(error));
    }
    tierB = {
      helperApp: args.helper?.app ?? null,
      helperSocket: args.helper?.socket ?? null,
      proxySocket: join(root, "b", "bridge.sock"),
      fixtureHash: build.hash,
      fixtureDir: build.dir,
      s4HarnessCancelMs: S4_HARNESS_CANCEL_MS,
    };
    await summary("running");
    console.log(`fixture=${build.dir}`);
  }
  const launcher: DaemonLauncher = args.tier === "a" ? new TierADaemon() : new TierBProxy();
  const owned = new Set<Daemon>();
  let allPass = true;
  try {
    for (const model of resolved) {
      const modelDeadline = Date.now() + 30 * 60_000;
      /**
       * Isolation is proven only by S1's isolation checks (allowlisted tools, no global agent path,
       * scratch helper path, stderr diagnostics), never by its scenario assertions. When S1 never
       * reached those checks, isolation is unproven and the remaining scenarios stay blocked.
       */
      let isolationBlock: string | undefined;
      for (const scenario of scenarioRows) {
        if (isolationBlock) {
          const verdict = `BLOCKED(${isolationBlock})`;
          verdicts.push({ tier: args.tier, model, scenario: scenario.id, verdict });
          await summary("running");
          console.log(`${args.tier} ${model} ${scenario.id} ${verdict}`);
          continue;
        }
        const prompt = await promptFor(args.tier, scenario.id);
        let verdict = "BLOCKED(unrun)";
        let notes: ScenarioNotes | undefined;
        let isolation: string[] | undefined;
        const defects: string[] = [];
        for (let attempt = 0; attempt < 4; attempt++) {
          notes = undefined;
          isolation = undefined;
          if (Date.now() >= modelDeadline) {
            verdict = "BLOCKED(model-budget)";
            break;
          }
          const p = plan(
            root,
            args.tier,
            model,
            scenario.id,
            prompt,
            system,
            args.pi,
            args.helper,
            attempt,
          );
          await mkdir(join(root, args.tier, slug(model)), { recursive: true });
          if (await socketBusy(p.socket)) throw new GateError("SOCKET_BUSY", p.socket);
          const daemon = await launcher.start(p, scenario.id);
          owned.add(daemon);
          // The scenario deadline stops Pi (inside launch) and the daemon, each with SIGTERM
          // then SIGKILL after KILL_GRACE_MS, and the loop advances regardless.
          const budget = Math.max(0, Math.min(scenarioMs(scenario.id), modelDeadline - Date.now()));
          const deadline = new AbortController();
          let scenarioTimedOut = false;
          let cancelDaemonKill: (() => void) | undefined;
          const timer = setTimeout(() => {
            scenarioTimedOut = true;
            deadline.abort();
            cancelDaemonKill = escalate(daemon.child);
          }, budget);
          let backoff: number | undefined;
          let fixtureRun: FixtureRun | undefined;
          let helperExecutable: string | undefined;
          let tierBClosed = false;
          // Tier B: stop the proxy (flushing its log) and quit the fixture exactly once, before
          // scoring, so the logs are complete and the fixture has written its final state. The
          // fixture run exists before its launch, so a partial launch is stopped too; quitFixture
          // is a no-op when launchFixture already stopped it.
          const closeTierB = async (): Promise<void> => {
            if (tierBClosed) return;
            tierBClosed = true;
            try {
              defects.push(...(await stopDaemon(daemon)));
            } finally {
              if (fixtureRun) defects.push(...(await quitFixture(fixtureRun)));
            }
          };
          try {
            await ready(p.socket);
            if (args.tier === "b") {
              if (!build) throw new BlockedError("fixture: not built");
              helperExecutable = await checkTierB(p);
              await ownerFree(p.upstream ?? "");
              const launching = newFixtureRun(p.fixtureDir);
              fixtureRun = launching;
              try {
                await launchFixture(build, launching);
              } catch (error) {
                if (error instanceof FixtureLaunchError) defects.push(...error.defects);
                throw new BlockedError(
                  `fixture: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
              const notFront = await holderFrontmost(launching);
              if (notFront) throw new BlockedError(`holder-not-frontmost: ${notFront}`);
            }
            const runFixture = fixtureRun;
            const mutate =
              scenario.id === "S5" && runFixture ? () => resizeTarget(runFixture) : undefined;
            const piStart = Date.now();
            // launch bounds its own waits; this watchdog is a last resort so the run advances.
            const launched = await within(
              launch(p, deadline.signal, scenario.id, mutate),
              budget + KILL_GRACE_MS + 4 * WAIT_BOUND_MS,
            );
            const piEnd = Date.now();
            if (!launched.ok) throw new Error(`HARNESS_DEFECT launch watchdog (${launched.error})`);
            const result = launched.value;
            defects.push(...result.defects);
            if (args.tier === "b") await closeTierB();
            if (result.intervention)
              await writeFile(
                join(root, args.tier, slug(model), `${scenario.id}.intervention.json`),
                `${JSON.stringify(result.intervention)}\n`,
              );
            const events = await jsonl(p.events);
            const session = await sessionRows(root, p.sessionId);
            const capacityPattern = /capacity|rate.limit|overload|429|529/i;
            const stderr = await readFile(p.stderr, "utf8");
            if (
              (result.code !== 0 && capacityPattern.test(stderr)) ||
              events.some(
                (event) =>
                  event.type === "message_end" &&
                  field(event.message, "stopReason") === "error" &&
                  capacityPattern.test(JSON.stringify(event.message)),
              )
            ) {
              verdict = "BLOCKED(capacity)";
              if (attempt < 3) backoff = [10_000, 30_000, 60_000][attempt];
            } else {
              const requests = await jsonl(p.requests);
              const fixture: FixtureEvidence | undefined = fixtureRun && {
                target: await fixtureRows(fixtureRun, "target"),
                holder: await fixtureRows(fixtureRun, "holder"),
                start: piStart,
                end: piEnd,
                targetPid: fixtureRun.pids.target,
              };
              const checked = verify(
                scenario.id,
                { events, session, requests, intervention: result.intervention, fixture },
                root,
                args.tier,
              );
              const errors = [...checked.errors];
              notes = checked.notes;
              if (scenario.id === "S1") {
                const settingsValue: JsonValue = JSON.parse(
                  await readFile(join(root, "agent/settings.json"), "utf8"),
                );
                isolation = !isJsonObject(settingsValue)
                  ? ["invalid agent settings"]
                  : isolationCheck(
                      events,
                      session,
                      root,
                      settingsValue,
                      packagePath,
                      await readFile(p.stderr, "utf8"),
                      await readFile(p.events, "utf8"),
                      JSON.stringify(session),
                      helperExecutable,
                    );
                errors.push(...isolation.map((error) => `isolation: ${error}`));
              }
              if (result.code !== 0 || result.timedOut || scenarioTimedOut)
                errors.push(
                  `Pi exit=${result.code} timedOut=${result.timedOut || scenarioTimedOut}`,
                );
              verdict = verdictOf(errors, checked.inconclusive);
            }
          } catch (error) {
            const why = error instanceof Error ? error.message : String(error);
            verdict =
              error instanceof BlockedError
                ? `BLOCKED(${why})`
                : `FAIL(${scenarioTimedOut ? "scenario deadline; " : ""}${why})`;
          } finally {
            clearTimeout(timer);
            cancelDaemonKill?.();
            if (args.tier === "b") await closeTierB();
            else defects.push(...(await stopDaemon(daemon)));
            owned.delete(daemon);
          }
          if (backoff !== undefined) {
            await new Promise((done) => setTimeout(done, backoff));
            continue;
          }
          break;
        }
        if (defects.length) {
          const defect = `HARNESS_DEFECT(${defects.join("; ")})`;
          verdict = verdict === "PASS" ? `FAIL(${defect})` : `${verdict} ${defect}`;
        }
        console.log(`${args.tier} ${model} ${scenario.id} ${verdict}`);
        verdicts.push({ tier: args.tier, model, scenario: scenario.id, verdict, notes });
        await summary("running");
        if (verdict !== "PASS") allPass = false;
        if (scenario.id === "S1") isolationBlock = blockAfterIsolation(isolation);
      }
    }
  } catch (error) {
    // Leave evidence of a partial run; the verdicts so far are already recorded.
    const why = error instanceof Error ? error.message : String(error);
    await summary(`ABORTED(${why})`);
    throw error;
  } finally {
    for (const daemon of owned) {
      for (const defect of await stopDaemon(daemon)) console.error(`HARNESS_DEFECT ${defect}`);
      owned.delete(daemon);
    }
    if (build) await unregisterFixture(build);
    if (!(await Promise.all(baselinePids.map(alive))).every(Boolean))
      console.error("MAIN_DAEMON_STOPPED");
  }
  if (owned.size) throw new Error("OWNED_PROCESS_REMAINS");
  if (!(await Promise.all(baselinePids.map(alive))).every(Boolean))
    throw new Error("MAIN_DAEMON_STOPPED");
  await summary(allPass ? "PASS" : "FAIL_OR_BLOCKED");
  if (!allPass) throw new Error("E2E_VERDICTS_NOT_PASS");
}
try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof GateError ? 2 : 1;
}
