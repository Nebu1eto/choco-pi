import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNumber, type JsonObject } from "../../src/json.ts";
import type { FixtureBuild, FixtureRole } from "../fixture/build.ts";
import { command } from "../preflight.ts";
import { parseJsonl } from "./score.ts";

export interface InstanceSpec {
  label: string;
  role: FixtureRole;
  env?: Record<string, string>;
  activate?: boolean;
}

export interface Instance {
  label: string;
  role: FixtureRole;
  log: string;
  pid?: number;
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

export class FixtureSet {
  readonly dir: string;
  readonly build: FixtureBuild;
  readonly instances = new Map<string, Instance>();
  private closed = false;

  constructor(dir: string, build: FixtureBuild) {
    this.dir = dir;
    this.build = build;
  }

  async prepare(): Promise<void> {
    await mkdir(this.dir);
  }

  logOf(label: string): string {
    return join(this.dir, `${label}.jsonl`);
  }

  async rows(label: string): Promise<JsonObject[]> {
    try {
      return parseJsonl(await readFile(this.logOf(label), "utf8"));
    } catch {
      return [];
    }
  }

  async waitFor(
    label: string,
    match: (row: JsonObject) => boolean,
    ms: number,
  ): Promise<JsonObject | undefined> {
    const until = Date.now() + ms;
    for (;;) {
      const found = (await this.rows(label)).find(match);
      if (found || Date.now() >= until) return found;
      await pause(40);
    }
  }

  async launch(spec: InstanceSpec, timeoutMs = 10_000): Promise<Instance> {
    if (this.closed) throw new Error("fixture set already closed");
    if (this.instances.has(spec.label)) throw new Error(`duplicate fixture label ${spec.label}`);
    const instance: Instance = { label: spec.label, role: spec.role, log: this.logOf(spec.label) };
    this.instances.set(spec.label, instance);
    const env = { ...spec.env, CU_FIXTURE_LOG: instance.log, CU_FIXTURE_INSTANCE: spec.label };
    const args = ["-n"];
    if (spec.role === "target" && !spec.activate) args.push("-g");
    for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
    args.push(spec.role === "target" ? this.build.target : this.build.holder);
    const opened = await command("open", args);
    if (opened.code !== 0) throw new Error(`FIXTURE_LAUNCH ${spec.label}: ${opened.stderr.trim()}`);
    const up = await this.waitFor(spec.label, (row) => row.event === "launched", timeoutMs);
    if (!up || !isNumber(up.pid)) throw new Error(`FIXTURE_LAUNCH ${spec.label} did not start`);
    instance.pid = up.pid;
    return instance;
  }

  pid(label: string): number {
    const pid = this.instances.get(label)?.pid;
    if (pid === undefined) throw new Error(`fixture ${label} has no pid`);
    return pid;
  }

  async trigger(name: string, body = "1\n"): Promise<void> {
    await writeFile(join(this.dir, name), body);
  }

  async quitAll(): Promise<string[]> {
    if (this.closed) return [];
    this.closed = true;
    const defects: string[] = [];
    try {
      await writeFile(join(this.dir, ".cu-quit"), "quit\n");
    } catch (error) {
      defects.push(
        `could not write .cu-quit: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const instance of this.instances.values()) {
      if (instance.pid === undefined) {
        const late = (await this.rows(instance.label)).find((row) => row.event === "launched");
        if (late && isNumber(late.pid)) instance.pid = late.pid;
      }
    }
    await Promise.all(
      [...this.instances.values()].map(async (instance) => {
        const pid = instance.pid;
        if (pid === undefined) return;
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
          defects.push(`fixture ${instance.label} ignored .cu-quit and SIGTERM`);
        }
        if (alive(pid)) defects.push(`fixture ${instance.label} pid ${pid} survived SIGKILL`);
      }),
    );
    return defects;
  }
}

export async function sweepFixtureProcesses(build: FixtureBuild): Promise<number[]> {
  const listed = await command("pgrep", ["-f", build.dir]);
  const pids = listed.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  for (const pid of pids) signal(pid, "SIGKILL");
  return pids;
}

export interface FrontApp {
  asn: string;
  bundleId?: string;
  pid?: number;
}

export async function frontApp(): Promise<FrontApp | undefined> {
  const front = await command("lsappinfo", ["front"]);
  const asn = front.stdout.trim();
  if (front.code !== 0 || !asn) return undefined;
  const info = await command("lsappinfo", ["info", "-only", "bundleid", "-only", "pid", asn]);
  const bundleId = /"?(?:bundleID|CFBundleIdentifier)"?="([^"]+)"/i.exec(info.stdout)?.[1];
  const pid = /"?pid"?\s*=\s*(\d+)/i.exec(info.stdout)?.[1];
  return { asn, bundleId, pid: pid === undefined ? undefined : Number(pid) };
}
