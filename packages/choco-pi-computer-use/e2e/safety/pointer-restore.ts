import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { arch } from "node:os";
import { join, resolve } from "node:path";
import { isJsonObject, isNumber, isString, type JsonObject } from "../../src/json.ts";
import { unregisterFixture } from "../desktop.ts";
import { buildFixture } from "../fixture/build.ts";
import { socketBusy } from "../preflight.ts";
import { parseCursorReport } from "./cursors-score.ts";
import { distance, rectOf, type Check, type Point, type Rect } from "./displays-score.ts";
import { FixtureSet, frontApp, sweepFixtureProcesses } from "./fixtures.ts";
import { checkHelper } from "./scenarios.ts";
import { isMainHelper } from "./score.ts";
import { RequestLog, Wire } from "./wire.ts";

interface Options {
  helperApp: string;
  helperSocket: string;
  out: string;
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const HOLDER_TITLE = "CU Focus Holder";
const GRANT = { policy: "foreground", foregroundGrant: true };

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
      "usage: pointer-restore.ts --helper-app <app> --helper-socket <socket> --out <dir>",
    );
  return { helperApp: resolve(helperApp), helperSocket: resolve(helperSocket), out: resolve(out) };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface PointerSample extends Point {
  ts: number;
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
  const wire = new Wire(options.helperSocket, log);
  const frontBefore = await frontApp();
  const build = await buildFixture(join(options.out, "fixture-build"));
  const fixtures = new FixtureSet(join(options.out, "fixture"), build);
  await fixtures.prepare();
  const summary: JsonObject = {
    startedAt: new Date().toISOString(),
    frontBefore: frontBefore
      ? { pid: frontBefore.pid ?? null, bundleId: frontBefore.bundleId ?? null }
      : null,
  };
  const checks: Check[] = [];
  const acts: JsonObject[] = [];
  let status = "complete";
  let claimed = false;
  const samples = async (): Promise<PointerSample[]> =>
    (await fixtures.rows("holder")).flatMap((row) =>
      row.event === "pointer" && isNumber(row.x) && isNumber(row.y) && isNumber(row.ts)
        ? [{ x: row.x, y: row.y, ts: row.ts }]
        : [],
    );
  const latest = async (): Promise<PointerSample | undefined> => (await samples()).at(-1);
  try {
    const checked = await checkHelper(options.helperSocket, await realpath(options.helperApp), log);
    if (checked.blocked) throw new Error("BLOCKED(" + checked.blocked + ")");
    await fixtures.launch({
      label: "holder",
      role: "holder",
      env: { CU_FIXTURE_POINTER_SAMPLER: "1" },
    });
    await pause(600);
    const holderPid = fixtures.pid("holder");
    const front = await frontApp();
    if (front?.pid !== holderPid) throw new Error("BLOCKED(the holder did not become frontmost)");
    const { reply: claim } = await wire.send("claim", { session: { ...wire.session } });
    if (claim.ok !== true) throw new Error("BLOCKED(claim refused)");
    claimed = true;
    const listed = await wire.send("listWindows", { pid: holderPid });
    const windows = Array.isArray(listed.reply.result) ? listed.reply.result : [];
    const window = windows.find((entry) => isJsonObject(entry) && entry.title === HOLDER_TITLE);
    if (!isJsonObject(window) || !isNumber(window.windowId))
      throw new Error("BLOCKED(holder window not found)");
    const look = async (): Promise<{
      lookId: string;
      frame: Rect;
      width: number;
      height: number;
    }> => {
      const { reply } = await wire.send("look", {
        windowId: window.windowId ?? null,
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
        !frame ||
        !image ||
        !isNumber(image.width) ||
        !isNumber(image.height)
      )
        throw new Error("BLOCKED(holder look failed)");
      return { lookId: result.lookId, frame, width: image.width, height: image.height };
    };
    const at = (view: { frame: Rect; width: number; height: number }, fx: number, fy: number) => ({
      global: { x: view.frame.x + view.frame.w * fx, y: view.frame.y + view.frame.h * fy },
      image: { x: view.width * fx, y: view.height * fy },
    });
    const runAct = async (
      name: string,
      build: (view: { lookId: string; frame: Rect; width: number; height: number }) => {
        fields: JsonObject;
        acted: Point;
      },
      warp?: Point,
    ) => {
      const view = await look();
      const start = await latest();
      const { fields, acted } = build(view);
      if (warp) {
        await fixtures.trigger(".cu-warp-on-up-holder", warp.x + " " + warp.y + "\n");
        await fixtures.waitFor("holder", (row) => row.event === "warpArmed", 1_000);
      }
      const sentAt = Date.now();
      const { reply } = await wire.send(
        "act",
        { ...wire.actEnvelope(), pid: holderPid, lookId: view.lookId, ...GRANT, ...fields },
        { timeoutMs: 20_000 },
      );
      const repliedAt = Date.now();
      const cursorState = parseCursorReport((await wire.send("agentCursorState", {})).reply.result);
      await pause(300);
      const all = await samples();
      const end = all.at(-1);
      const during = all.filter((sample) => sample.ts >= sentAt && sample.ts <= repliedAt + 300);
      const reachedActed = during.some((sample) => distance(sample, acted) <= 2);
      const result = isJsonObject(reply.result) ? reply.result : undefined;
      const performed = result && isJsonObject(result.performed) ? result.performed : undefined;
      const errorDetails =
        isJsonObject(reply.error) && isJsonObject(reply.error.details)
          ? reply.error.details
          : undefined;
      const restore = performed?.pointerRestore ?? errorDetails?.pointerRestore ?? null;
      const cursor = cursorState?.cursors.find((entry) => entry.windowId === window.windowId);
      acts.push({
        name,
        ok: reply.ok ?? null,
        outcome: result && isString(result.outcome) ? result.outcome : null,
        error: reply.error ?? null,
        start: start ? { x: start.x, y: start.y } : null,
        end: end ? { x: end.x, y: end.y } : null,
        acted: { ...acted },
        pointerReachedActed: reachedActed,
        pointerRestore: restore,
        changesDuring: during.length,
        cursor: cursor
          ? {
              delivery: cursor.target ? "drawn" : "none",
              target: cursor.target ? { ...cursor.target } : null,
            }
          : null,
      });
      return { start, end, reachedActed, restore, cursor };
    };
    const offsets = { x: 0.8, y: 0.8 };
    for (const name of ["click", "drag", "scroll"]) {
      const outcome = await runAct(name, (view) => {
        const point = at(view, offsets.x, offsets.y);
        if (name === "click")
          return {
            fields: { action: "click", target: point.image, params: {} },
            acted: point.global,
          };
        if (name === "scroll")
          return {
            fields: { action: "scroll", target: point.image, params: { scrollX: 0, scrollY: 60 } },
            acted: point.global,
          };
        const from = at(view, 0.6, 0.8);
        const to = at(view, 0.9, 0.85);
        return {
          fields: { action: "drag", target: from.image, params: { path: [from.image, to.image] } },
          acted: to.global,
        };
      });
      const back =
        outcome.start !== undefined &&
        outcome.end !== undefined &&
        distance(outcome.start, outcome.end) <= 1;
      checks.push({
        name: name + "_pointer_moved_then_restored",
        ok: outcome.reachedActed && back,
        detail: {
          start: outcome.start ? { x: outcome.start.x, y: outcome.start.y } : null,
          end: outcome.end ? { x: outcome.end.x, y: outcome.end.y } : null,
          reachedActed: outcome.reachedActed,
          restore: isJsonObject(outcome.restore) ? outcome.restore : null,
        },
      });
      if (name === "click")
        checks.push({
          name: "click_agent_cursor_drawn_for_foreground",
          ok: outcome.cursor?.target !== undefined,
          detail: { target: outcome.cursor?.target ? { ...outcome.cursor.target } : null },
        });
    }
    const view = await look();
    const warpTo = {
      x: Math.round(view.frame.x + view.frame.w * 0.3),
      y: Math.round(view.frame.y + view.frame.h * 0.3),
    };
    const moved = await runAct(
      "click_user_moves",
      (current) => {
        const point = at(current, offsets.x, offsets.y);
        return {
          fields: { action: "click", target: point.image, params: {} },
          acted: point.global,
        };
      },
      warpTo,
    );
    const warped = (await fixtures.rows("holder")).some((row) => row.event === "warped");
    checks.push({
      name: "user_move_not_overridden",
      ok: warped ? moved.end !== undefined && distance(moved.end, warpTo) <= 1 : null,
      detail: {
        warped,
        warpTo,
        end: moved.end ? { x: moved.end.x, y: moved.end.y } : null,
        restore: isJsonObject(moved.restore) ? moved.restore : null,
      },
    });
  } catch (error) {
    status = "ABORTED(" + (error instanceof Error ? error.message : String(error)) + ")";
  } finally {
    const holder = fixtures.instances.get("holder")?.pid;
    if (claimed && frontBefore?.pid !== undefined && holder !== undefined)
      summary.focusRestore =
        (
          await wire
            .send(
              "restoreUserFocus",
              {
                session: { ...wire.session },
                foregroundGrant: true,
                pid: frontBefore.pid,
                expectedFrontmostPid: holder,
              },
              { timeoutMs: 5_000 },
            )
            .catch(() => undefined)
        )?.reply.ok ?? null;
    if (claimed)
      await wire
        .send("release", { session: { ...wire.session } }, { timeoutMs: 3_000 })
        .catch(() => undefined);
    summary.cleanup = await fixtures.quitAll();
    summary.sweptFixturePids = await sweepFixtureProcesses(build);
    await unregisterFixture(build).catch(() => undefined);
    await pause(300);
    const frontAfter = await frontApp();
    summary.frontAfter = frontAfter
      ? { pid: frontAfter.pid ?? null, bundleId: frontAfter.bundleId ?? null }
      : null;
    await log.flush();
  }
  const verdict =
    status !== "complete"
      ? "BLOCKED"
      : checks.some((check) => check.ok === false)
        ? "FAIL"
        : "PASS";
  Object.assign(summary, {
    status,
    verdict,
    checks: checks.map((check) => ({ ...check })),
    acts,
    finishedAt: new Date().toISOString(),
  });
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  console.log("pointer-restore " + verdict + " " + status + " (" + summaryPath + ")");
  for (const check of checks) console.log("  " + check.name + " " + String(check.ok));
  return verdict === "PASS" ? 0 : 1;
}

process.exit(await main());
