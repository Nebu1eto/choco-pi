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

export interface ChromiumStop {
  pids: number[];
  crashpad: { pid: number; exitedOnItsOwn: boolean; terminated: boolean }[];
  defects: string[];
}

async function crashpadPids(app: string): Promise<number[]> {
  const listed = await command("pgrep", [
    "-f",
    app + "/Contents/Frameworks/.*chrome_crashpad_handler",
  ]);
  return listed.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

export class ChromiumInstance {
  readonly pid: number;
  readonly userDataDir: string;
  private readonly app: ChromiumApp;
  private crashpadBefore = new Set<number>();
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
    const crashpadBefore = new Set(await crashpadPids(app.app));
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
    instance.crashpadBefore = crashpadBefore;
    const drain = (chunk: Buffer): void => {
      instance.writing = instance.writing
        .then(() => appendFile(logPath, chunk))
        .catch(() => undefined);
    };
    child.stdout.on("data", drain);
    child.stderr.on("data", drain);
    child.once("exit", () => {
      instance.exited = true;
    });
    return instance;
  }

  running(): boolean {
    return !this.exited && alive(this.pid);
  }

  async ownedPids(): Promise<number[]> {
    const owned = new Set<number>();
    const table = await command("ps", ["-A", "-o", "pid=,ppid="]);
    const children = new Map<number, number[]>();
    for (const line of table.stdout.split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    }
    const queue = [this.pid];
    while (queue.length > 0) {
      const pid = queue.shift();
      if (pid === undefined || owned.has(pid)) continue;
      if (pid === this.pid || alive(pid)) owned.add(pid);
      queue.push(...(children.get(pid) ?? []));
    }
    const named = await command("pgrep", ["-f", this.userDataDir]);
    for (const line of named.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isSafeInteger(pid) && pid > 0) owned.add(pid);
    }
    owned.delete(process.pid);
    return [...owned];
  }

  async stop(): Promise<ChromiumStop> {
    const pids = await this.ownedPids();
    const defects: string[] = [];
    if (alive(this.pid)) signal(this.pid, "SIGTERM");
    let until = Date.now() + 5_000;
    while (alive(this.pid) && Date.now() < until) await pause(100);
    const remaining = [...new Set([...pids, ...(await this.ownedPids())])].filter(alive);
    for (const pid of remaining) signal(pid, "SIGTERM");
    until = Date.now() + 2_000;
    while (remaining.some(alive) && Date.now() < until) await pause(100);
    for (const pid of remaining.filter(alive)) signal(pid, "SIGKILL");
    await pause(300);
    const survivors = [...new Set([...remaining, ...(await this.ownedPids())])].filter(alive);
    if (survivors.length > 0)
      defects.push("chromium pids survived SIGKILL: " + survivors.join(","));
    const fresh = (await crashpadPids(this.app.app)).filter(
      (pid) => !this.crashpadBefore.has(pid) && !pids.includes(pid),
    );
    until = Date.now() + 10_000;
    while (fresh.some(alive) && Date.now() < until) await pause(200);
    const lingering = fresh.filter(alive);
    const registered = this.app.bundleId
      ? (await command("lsappinfo", ["find", "bundleid=" + this.app.bundleId])).stdout.trim()
      : "unknown";
    const terminate = lingering.length > 0 && registered === "";
    if (terminate) {
      for (const pid of lingering) signal(pid, "SIGTERM");
      until = Date.now() + 2_000;
      while (lingering.some(alive) && Date.now() < until) await pause(100);
      for (const pid of lingering.filter(alive)) signal(pid, "SIGKILL");
      await pause(300);
    }
    const crashpad = fresh.map((pid) => ({
      pid,
      exitedOnItsOwn: !lingering.includes(pid),
      terminated: terminate && lingering.includes(pid),
    }));
    const left = fresh.filter(alive);
    if (left.length > 0)
      defects.push(
        "crash handler pids " +
          left.join(",") +
          (terminate
            ? " survived SIGKILL"
            : " appeared during the instance and still run (another instance is registered; not signalled)"),
      );
    await this.writing;
    return { pids: [...new Set([...pids, ...remaining])], crashpad, defects };
  }
}
