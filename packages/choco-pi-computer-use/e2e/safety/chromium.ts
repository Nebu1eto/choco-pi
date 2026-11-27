import { spawn } from "node:child_process";
import { access, appendFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { isJsonObject, isString, type JsonObject, type JsonValue } from "../../src/json.ts";
import { command } from "../preflight.ts";
import { matrixPage } from "./matrix-page.ts";

export const CHROMIUM_TITLE = "CU Matrix Chromium";

const CANDIDATES = [
  "/Applications/Google Chrome.app",
  "/Applications/Chromium.app",
  "/Applications/Google Chrome Beta.app",
];

export interface ChromiumApp {
  app: string;
  binary: string;
  version: string | null;
  bundleId: string | null;
}

export async function findChromium(): Promise<ChromiumApp | undefined> {
  for (const app of CANDIDATES) {
    const name = app.slice(app.lastIndexOf("/") + 1, -".app".length);
    const binary = join(app, "Contents/MacOS", name);
    try {
      await access(binary);
    } catch {
      continue;
    }
    const plist = async (key: string): Promise<string | null> => {
      const read = await command("plutil", [
        "-extract",
        key,
        "raw",
        join(app, "Contents/Info.plist"),
      ]);
      return read.code === 0 ? read.stdout.trim() : null;
    };
    return {
      app,
      binary,
      version: await plist("CFBundleShortVersionString"),
      bundleId: await plist("CFBundleIdentifier"),
    };
  }
  return undefined;
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

interface PendingReset {
  seq: number;
  text: string;
}

export class PageServer {
  readonly rows: JsonObject[] = [];
  readonly log: string;
  private readonly server: Server;
  private seq = 0;
  private pending: PendingReset | undefined;
  private readonly waiters = new Set<ServerResponse>();
  private writing: Promise<void> = Promise.resolve();
  url = "";

  constructor(log: string) {
    this.log = log;
    this.server = createServer((request, response) => this.handle(request, response));
  }

  async start(): Promise<string> {
    await writeFile(this.log, "");
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (address === null || !(address instanceof Object)) throw new Error("server has no port");
    this.url = "http://127.0.0.1:" + String(address.port) + "/";
    return this.url;
  }

  requestReset(text: string): number {
    this.seq += 1;
    this.pending = { seq: this.seq, text };
    for (const waiter of this.waiters) this.reply(waiter, this.pending);
    this.waiters.clear();
    return this.seq;
  }

  async waitFor(match: (row: JsonObject) => boolean, ms: number): Promise<JsonObject | undefined> {
    const until = Date.now() + ms;
    for (;;) {
      const found = this.rows.find(match);
      if (found || Date.now() >= until) return found;
      await pause(25);
    }
  }

  async stop(): Promise<void> {
    for (const waiter of this.waiters) this.reply(waiter, {});
    this.waiters.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.writing;
  }

  private reply(response: ServerResponse, body: JsonObject | PendingReset): void {
    if (response.writableEnded) return;
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  }

  private record(value: JsonValue): void {
    if (!isJsonObject(value) || !isString(value.event)) return;
    const row: JsonObject = { ...value, ts: Date.now(), app: "chromium" };
    this.rows.push(row);
    const line = JSON.stringify(row) + "\n";
    this.writing = this.writing
      .then(() => appendFile(this.log, line))
      .catch((error: Error) => console.error("chromium log write failed: " + error.message));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(matrixPage(CHROMIUM_TITLE));
      return;
    }
    if (request.method === "GET" && url.pathname === "/control") {
      const after = Number(url.searchParams.get("after") ?? "0");
      if (this.pending && this.pending.seq > after) {
        this.reply(response, this.pending);
        return;
      }
      this.waiters.add(response);
      const timer = setTimeout(() => {
        this.waiters.delete(response);
        this.reply(response, {});
      }, 20_000);
      response.once("close", () => {
        clearTimeout(timer);
        this.waiters.delete(response);
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/event") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        if (body.length < 65_536) body += chunk;
      });
      request.on("end", () => {
        try {
          this.record(JSON.parse(body));
        } catch (error) {
          console.error(
            "chromium event parse failed: " +
              (error instanceof Error ? error.message : String(error)),
          );
        }
        response.writeHead(204);
        response.end();
      });
      return;
    }
    response.writeHead(404);
    response.end();
  }
}

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

export interface ProcessRow {
  pid: number;
  ppid: number;
  started: string;
  executable: string;
  args: string;
}

export interface ChromiumLeftover {
  pid: number;
  executable: string;
  reason: string;
}

export interface OwnershipInput {
  spawnedPid: number;
  recorded: Map<number, string>;
  table: ProcessRow[];
  appBundle: string;
  userDataDir: string;
  selfPid: number;
}

export interface Ownership {
  owned: ProcessRow[];
  leftovers: ChromiumLeftover[];
}

function namesDirectory(args: string, flag: string, dir: string, below: boolean): boolean {
  const needle = flag + dir;
  for (let at = args.indexOf(needle); at >= 0; at = args.indexOf(needle, at + 1)) {
    if (at > 0 && args[at - 1] !== " ") continue;
    const next = args[at + needle.length];
    if (next === undefined || next === " " || (below && next === "/")) return true;
  }
  return false;
}

function annotationNamesDirectory(args: string, dir: string): boolean {
  return args
    .split(" ")
    .some(
      (arg) =>
        arg.startsWith("--annotation=") &&
        (arg.endsWith("=" + dir) || arg.includes("=" + dir + "/")),
    );
}

export function classifyProcesses(input: OwnershipInput): Ownership {
  const rows = new Map(input.table.map((row) => [row.pid, row]));
  const spawned = rows.get(input.spawnedPid);
  if (spawned) {
    const children = new Map<number, ProcessRow[]>();
    for (const row of input.table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
    const seen = new Set<number>();
    const queue = [spawned];
    while (queue.length > 0) {
      const row = queue.shift();
      if (!row || seen.has(row.pid)) continue;
      seen.add(row.pid);
      input.recorded.set(row.pid, row.started);
      queue.push(...(children.get(row.pid) ?? []));
    }
  }
  const owned = new Map<number, ProcessRow>();
  for (const [pid, started] of input.recorded) {
    const row = rows.get(pid);
    if (row && row.started === started && pid !== input.selfPid) owned.set(pid, row);
  }
  const bundle = input.appBundle.endsWith("/") ? input.appBundle : input.appBundle + "/";
  const leftovers: ChromiumLeftover[] = [];
  for (const row of input.table) {
    if (owned.has(row.pid) || row.pid === input.selfPid) continue;
    const inBundle = row.executable.startsWith(bundle);
    if (!inBundle && !row.args.includes(input.userDataDir)) continue;
    const profileArgument = namesDirectory(row.args, "--user-data-dir=", input.userDataDir, false);
    const crashArgument =
      row.executable.includes("chrome_crashpad_handler") &&
      (namesDirectory(row.args, "--database=", input.userDataDir, true) ||
        annotationNamesDirectory(row.args, input.userDataDir));
    if (inBundle && (profileArgument || crashArgument)) {
      owned.set(row.pid, row);
      continue;
    }
    leftovers.push({
      pid: row.pid,
      executable: row.executable,
      reason: inBundle
        ? "not a descendant, and no argument names this run's profile directory"
        : "executable outside " + input.appBundle,
    });
  }
  return { owned: [...owned.values()], leftovers };
}

export async function readProcessTable(): Promise<ProcessRow[]> {
  const [tree, executables, argv] = await Promise.all([
    command("ps", ["-A", "-o", "pid=,ppid=,lstart="]),
    command("ps", ["-A", "-o", "pid=,comm="]),
    command("ps", ["-A", "-ww", "-o", "pid=,args="]),
  ]);
  const byPid = (text: string): Map<number, string> => {
    const out = new Map<number, string>();
    for (const line of text.split("\n")) {
      const match = /^\s*(\d+) (.*)$/.exec(line);
      if (match?.[1]) out.set(Number(match[1]), (match[2] ?? "").trim());
    }
    return out;
  };
  const paths = byPid(executables.stdout);
  const args = byPid(argv.stdout);
  const rows: ProcessRow[] = [];
  for (const line of tree.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    const pid = Number(match[1]);
    rows.push({
      pid,
      ppid: Number(match[2]),
      started: match[3],
      executable: paths.get(pid) ?? "",
      args: args.get(pid) ?? "",
    });
  }
  return rows;
}

export interface ChromiumStop {
  pids: number[];
  crashpad: { pid: number; exitedOnItsOwn: boolean; terminated: boolean }[];
  leftovers: ChromiumLeftover[];
  defects: string[];
}

export class ChromiumInstance {
  readonly pid: number;
  readonly userDataDir: string;
  private readonly app: ChromiumApp;
  private readonly recorded = new Map<number, string>();
  private recorder: ReturnType<typeof setInterval> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private exited = false;

  private constructor(pid: number, userDataDir: string, app: ChromiumApp) {
    this.pid = pid;
    this.userDataDir = userDataDir;
    this.app = app;
  }

  static async launch(
    app: ChromiumApp,
    userDataDir: string,
    url: string,
    logPath: string,
  ): Promise<ChromiumInstance> {
    const child = spawn(
      app.binary,
      [
        "--user-data-dir=" + userDataDir,
        "--no-first-run",
        "--no-default-browser-check",
        "--use-mock-keychain",
        "--disable-sync",
        "--disable-extensions",
        "--disable-default-apps",
        "--disable-background-networking",
        "--disable-component-update",
        "--window-position=1220,450",
        "--window-size=480,560",
        "--new-window",
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    if (child.pid === undefined) throw new Error("CHROMIUM_LAUNCH no pid");
    const instance = new ChromiumInstance(child.pid, userDataDir, app);
    const drain = (chunk: Buffer): void => {
      instance.writing = instance.writing
        .then(() => appendFile(logPath, chunk))
        .catch(() => undefined);
    };
    child.stdout.on("data", drain);
    child.stderr.on("data", drain);
    child.once("exit", () => {
      instance.exited = true;
      instance.stopRecorder();
    });
    const recorder = setInterval(() => {
      instance.ownership().catch(() => undefined);
    }, 2_000);
    recorder.unref();
    instance.recorder = recorder;
    return instance;
  }

  running(): boolean {
    return !this.exited && alive(this.pid);
  }

  private stopRecorder(): void {
    if (this.recorder) clearInterval(this.recorder);
    this.recorder = undefined;
  }

  async ownership(): Promise<Ownership> {
    const table = await readProcessTable();
    const spawnedLive = !this.exited && alive(this.pid);
    return classifyProcesses({
      spawnedPid: spawnedLive ? this.pid : -1,
      recorded: this.recorded,
      table,
      appBundle: this.app.app,
      userDataDir: this.userDataDir,
      selfPid: process.pid,
    });
  }

  async ownedPids(): Promise<number[]> {
    return (await this.ownership()).owned.map((row) => row.pid);
  }

  async stop(): Promise<ChromiumStop> {
    const first = await this.ownership();
    const defects: string[] = [];
    if (alive(this.pid)) signal(this.pid, "SIGTERM");
    let until = Date.now() + 5_000;
    while (alive(this.pid) && Date.now() < until) await pause(100);
    this.stopRecorder();
    const again = await this.ownership();
    const ownedRows = new Map([...first.owned, ...again.owned].map((row) => [row.pid, row]));
    const remaining = [...ownedRows.keys()].filter(alive);
    for (const pid of remaining) signal(pid, "SIGTERM");
    until = Date.now() + 2_000;
    while (remaining.some(alive) && Date.now() < until) await pause(100);
    for (const pid of remaining.filter(alive)) signal(pid, "SIGKILL");
    await pause(300);
    const last = await this.ownership();
    const survivors = [...new Set([...remaining, ...last.owned.map((row) => row.pid)])].filter(
      alive,
    );
    if (survivors.length > 0)
      defects.push("chromium pids survived SIGKILL: " + survivors.join(","));
    let leftovers = last.leftovers;
    until = Date.now() + 10_000;
    while (leftovers.length > 0 && Date.now() < until) {
      await pause(200);
      leftovers = (await this.ownership()).leftovers;
    }
    if (leftovers.length > 0)
      defects.push(
        "chromium leftovers (ownership not established, not signalled): " +
          leftovers.map((left) => String(left.pid) + " " + left.executable).join(", "),
      );
    const crashpad = [...ownedRows.values()]
      .filter((row) => row.executable.includes("chrome_crashpad_handler"))
      .map((row) => ({
        pid: row.pid,
        exitedOnItsOwn: !remaining.includes(row.pid),
        terminated: remaining.includes(row.pid),
      }));
    await this.writing;
    return { pids: [...ownedRows.keys()], crashpad, leftovers, defects };
  }
}
