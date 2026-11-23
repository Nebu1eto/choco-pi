import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isJsonObject, isNumber, type JsonValue } from "../src/json.ts";
import type { RecordValue } from "./assertions.ts";
import { fixtureApps, type FixtureBuild, type FixtureRole } from "./fixture/build.ts";
import { command } from "./preflight.ts";

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export interface FixtureRun {
  dir: string;
  logs: Record<FixtureRole, string>;
  pids: Partial<Record<FixtureRole, number>>;
  closed: boolean;
}

export function newFixtureRun(dir: string): FixtureRun {
  return {
    dir,
    logs: { target: join(dir, "target.jsonl"), holder: join(dir, "holder.jsonl") },
    pids: {},
    closed: false,
  };
}

export class FixtureLaunchError extends Error {
  readonly defects: string[];
  constructor(message: string, defects: string[]) {
    super(message);
    this.name = "FixtureLaunchError";
    this.defects = defects;
  }
}

export interface LaunchDeps {
  open: (args: string[]) => Promise<{ code: number; stderr: string }>;
  quit: (run: FixtureRun) => Promise<string[]>;
  launchMs: number;
  activeMs: number;
  settleMs: number;
}

async function rows(path: string): Promise<RecordValue[]> {
  let input = "";
  try {
    input = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return input.split("\n").flatMap((line) => {
    try {
      const value: JsonValue = JSON.parse(line);
      return isJsonObject(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

export async function fixtureRows(run: FixtureRun, role: FixtureRole): Promise<RecordValue[]> {
  return rows(run.logs[role]);
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function waitFor(
  run: FixtureRun,
  role: FixtureRole,
  match: (row: RecordValue) => boolean,
  ms: number,
): Promise<RecordValue | undefined> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const found = (await fixtureRows(run, role)).find(match);
    if (found) return found;
    await pause(50);
  }
  return undefined;
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function frontmostBundle(): Promise<string | undefined> {
  const front = await command("lsappinfo", ["front"]);
  const asn = front.stdout.trim();
  if (front.code !== 0 || !asn) return undefined;
  const info = await command("lsappinfo", ["info", "-only", "bundleid", asn]);
  return /(?:bundleID|"CFBundleIdentifier")="([^"]+)"/i.exec(info.stdout)?.[1];
}

export async function launchFixture(
  build: FixtureBuild,
  run: FixtureRun,
  deps: LaunchDeps = defaultLaunchDeps,
): Promise<void> {
  await mkdir(dirname(run.dir), { recursive: true });
  try {
    await mkdir(run.dir);
  } catch (error) {
    run.closed = true;
    const why = error instanceof Error ? error.message : String(error);
    throw new FixtureLaunchError(`FIXTURE_LAUNCH directory: ${why}`, []);
  }
  try {
    const holder = await deps.open([
      "-n",
      "--env",
      `CU_FIXTURE_LOG=${run.logs.holder}`,
      build.holder,
    ]);
    if (holder.code !== 0) throw new Error(`FIXTURE_LAUNCH holder: ${holder.stderr.trim()}`);
    const holderUp = await waitFor(run, "holder", (row) => row.event === "launched", deps.launchMs);
    if (!holderUp || !isNumber(holderUp.pid))
      throw new Error("FIXTURE_LAUNCH holder did not start");
    run.pids.holder = holderUp.pid;
    const activeHolder = await waitFor(
      run,
      "holder",
      (row) => row.event === "appActive",
      deps.activeMs,
    );
    if (!activeHolder) throw new Error("FIXTURE_LAUNCH holder never became active");
    const target = await deps.open([
      "-n",
      "-g",
      "--env",
      `CU_FIXTURE_LOG=${run.logs.target}`,
      build.target,
    ]);
    if (target.code !== 0) throw new Error(`FIXTURE_LAUNCH target: ${target.stderr.trim()}`);
    const targetUp = await waitFor(run, "target", (row) => row.event === "launched", deps.launchMs);
    if (!targetUp || !isNumber(targetUp.pid))
      throw new Error("FIXTURE_LAUNCH target did not start");
    run.pids.target = targetUp.pid;
    await pause(deps.settleMs);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new FixtureLaunchError(why, await stopPartial(run, deps));
  }
}

async function stopPartial(run: FixtureRun, deps: LaunchDeps): Promise<string[]> {
  for (const role of ["holder", "target"] as const) {
    if (run.pids[role] !== undefined) continue;
    const late = (await fixtureRows(run, role)).find((row) => row.event === "launched");
    if (late && isNumber(late.pid)) run.pids[role] = late.pid;
  }
  try {
    return await deps.quit(run);
  } catch (error) {
    return [`fixture cleanup failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

export async function holderFrontmost(run: FixtureRun): Promise<string | undefined> {
  const front = await frontmostBundle();
  if (front !== fixtureApps.holder.bundleId) return `frontmost is ${front ?? "unknown"}`;
  const holder = (await fixtureRows(run, "holder")).filter(
    (row) => row.event === "appActive" || row.event === "appInactive",
  );
  if (holder.at(-1)?.event !== "appActive") return "holder log does not end active";
  if ((await fixtureRows(run, "target")).some((row) => row.event === "appActive"))
    return "target became active before the scenario";
  return undefined;
}

export async function resizeTarget(run: FixtureRun): Promise<RecordValue> {
  const at = Date.now();
  await writeFile(join(run.dir, ".cu-resize"), `${at}\n`);
  const done = await waitFor(
    run,
    "target",
    (row) => row.event === "resized" && isNumber(row.ts) && row.ts >= at - 5,
    3_000,
  );
  if (!done) return { ok: false, error: "fixture did not acknowledge .cu-resize", requestedAt: at };
  return { ok: true, requestedAt: at, at: done.ts ?? at, from: done.from, to: done.to };
}

export async function quitFixture(run: FixtureRun): Promise<string[]> {
  if (run.closed) return [];
  run.closed = true;
  const defects: string[] = [];
  try {
    await writeFile(join(run.dir, ".cu-quit"), "quit\n");
  } catch (error) {
    if (run.pids.target !== undefined || run.pids.holder !== undefined)
      defects.push(
        `could not write .cu-quit: ${error instanceof Error ? error.message : String(error)}`,
      );
  }
  for (const role of ["target", "holder"] as const) {
    const pid = run.pids[role];
    if (pid === undefined) continue;
    let until = Date.now() + 3_000;
    while (alive(pid) && Date.now() < until) await pause(50);
    if (alive(pid)) {
      signal(pid, "SIGTERM");
      until = Date.now() + 2_000;
      while (alive(pid) && Date.now() < until) await pause(50);
    }
    if (alive(pid)) {
      signal(pid, "SIGKILL");
      await pause(200);
      defects.push(`fixture ${role} ignored .cu-quit and SIGTERM`);
    }
    if (alive(pid)) defects.push(`fixture ${role} pid ${pid} survived SIGKILL`);
    if (!(await fixtureRows(run, role)).some((row) => row.event === "quitting"))
      defects.push(`fixture ${role} did not log quitting`);
  }
  return defects;
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

const defaultLaunchDeps: LaunchDeps = {
  open: (args) => command("open", args),
  quit: quitFixture,
  launchMs: 10_000,
  activeMs: 5_000,
  settleMs: 800,
};

export async function unregisterFixture(build: FixtureBuild): Promise<void> {
  for (const app of [build.target, build.holder]) await command(LSREGISTER, ["-u", app]);
}
