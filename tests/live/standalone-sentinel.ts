/**
 * Manual sentinel probe for the standalone launcher (plan section 7). Never run by the unit suite.
 *
 *   node tests/live/standalone-sentinel.ts --home <scratch HOME> [--launcher <choco-pi>] [--path <PATH>] [--project <cwd>] [--runtime node|bun]
 *
 * <scratch HOME> must already hold a standalone install (default launcher
 * <home>/.local/bin/choco-pi). Sessions run in --project (default a sibling
 * of HOME): with cwd = HOME, Pi's project-scope <cwd>/.pi would be ~/.pi. The probe:
 * 1. creates a poison ~/.pi (fake token, invalid settings JSON, a sentinel
 *    skill, memory, ACP session map, agent-browser config) and records a
 *    recursive listing with sizes, modes and mtimes;
 * 2. starts `choco-pi --mode rpc` (PI_OFFLINE=1) with NODE_OPTIONS importing
 *    this file, which wraps every node:fs and node:fs/promises function and
 *    reports any path under $HOME/.pi; runs get_state and get_commands; then
 *    starts `choco-pi self acp`, initializes it and opens a session;
 * 3. passes when no access is reported, the listing is unchanged, no
 *    "sentinel" skill or command is loaded, and the session started;
 * 4. repeats the RPC round with `chmod 000 ~/.pi`: the session must start
 *    with no EACCES/EPERM on stderr.
 *
 * --runtime sets CHOCO_PI_RUNTIME for every launcher run (default: whatever
 * the install selects); the summary records the runtime the launcher resolved.
 *
 * Limits: Node processes are traced through NODE_OPTIONS. Bun ignores
 * NODE_OPTIONS; BUN_OPTIONS preloads the same tracer, but in Bun it only sees
 * calls made through the `fs` / `fs/promises` objects, not named ESM
 * imports. To cover that gap, every poison file's atime is backdated before
 * the runs and compared afterwards: a content read by any process (Node, Bun
 * or a tool) updates it (relatime), while a stat does not. The listing
 * comparison covers writes by any process. Hits are written to stderr and to
 * a log file asynchronously, so a hit in the last instant before a forced exit
 * could be missed.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { userInfo } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOTS_VARIABLE = "CHOCO_PI_SENTINEL_ROOTS";
const LOG_VARIABLE = "CHOCO_PI_SENTINEL_LOG";
const HIT_PREFIX = "CHOCO_PI_SENTINEL_HIT";
const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- probe side

/** The path-like arguments of an fs call (strings, Buffers, file: URLs); fds and options are skipped. */
function pathArguments(args: readonly unknown[]): string[] {
  const paths: string[] = [];
  for (const argument of args.slice(0, 2)) {
    if (argument instanceof URL) {
      if (argument.protocol === "file:") paths.push(fileURLToPath(argument));
    } else if (Buffer.isBuffer(argument)) {
      paths.push(argument.toString());
    } else if (Object(argument) instanceof String) {
      paths.push(String(argument));
    }
  }
  return paths;
}

function installProbe(roots: readonly string[], logFile: string | undefined): void {
  const appendLog = fsPromises.appendFile;
  let reporting = false;
  const report = (name: string, args: readonly unknown[]) => {
    if (reporting) return;
    reporting = true;
    try {
      for (const candidate of pathArguments(args)) {
        const resolved = path.resolve(candidate);
        if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)))
          continue;
        const entry = path.basename(process.argv[1] ?? "?");
        const line = `${HIT_PREFIX} pid=${process.pid} entry=${entry} ${name} ${resolved}\n`;
        process.stderr.write(line);
        if (logFile !== undefined) appendLog(logFile, line).catch(() => undefined);
      }
    } finally {
      reporting = false;
    }
  };
  const wrapAll = (target: typeof fs | typeof fsPromises, prefix: string) => {
    for (const name of Object.keys(target)) {
      if (/^[A-Z]/.test(name) || name === "promises" || name === "constants") continue;
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      const original = descriptor?.value;
      if (!(original instanceof Function) || descriptor?.configurable !== true) continue;
      const wrapped = (...args: unknown[]) => {
        report(`${prefix}${name}`, args);
        return original.apply(target, args);
      };
      Object.defineProperty(target, name, { ...descriptor, value: wrapped });
    }
  };
  wrapAll(fs, "fs.");
  wrapAll(fsPromises, "fs/promises.");
  syncBuiltinESMExports();
}

const probeRoots = process.env[ROOTS_VARIABLE];
// The module URL is a real path; argv[1] may go through a symlink (/tmp on macOS).
const mainArgument = process.argv[1];
const isMain =
  mainArgument !== undefined &&
  (await fsPromises.realpath(mainArgument).catch(() => path.resolve(mainArgument))) === SELF;
if (probeRoots !== undefined && !isMain) {
  installProbe(probeRoots.split(path.delimiter).filter(Boolean), process.env[LOG_VARIABLE]);
}

// --------------------------------------------------------- orchestrator side

type Options = {
  home: string;
  launcher: string;
  searchPath: string;
  project: string;
  runtime: "node" | "bun" | null;
};

function parseOptions(args: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (
      !["--home", "--launcher", "--path", "--project", "--runtime"].includes(args[index]) ||
      value === undefined
    ) {
      throw new Error(
        `usage: standalone-sentinel.ts --home DIR [--launcher FILE] [--path PATH] [--project DIR] [--runtime node|bun]; bad argument ${args[index]}`,
      );
    }
    values.set(args[index], value);
  }
  const home = values.get("--home");
  if (home === undefined) throw new Error("--home is required");
  const runtime = values.get("--runtime") ?? null;
  if (runtime !== null && runtime !== "node" && runtime !== "bun")
    throw new Error(`--runtime must be node or bun, got ${runtime}`);
  return {
    home: path.resolve(home),
    launcher: path.resolve(
      values.get("--launcher") ?? path.join(home, ".local", "bin", "choco-pi"),
    ),
    searchPath: values.get("--path") ?? `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    project: path.resolve(values.get("--project") ?? path.join(home, "..", "sentinel-project")),
    runtime,
  };
}

const POISON = new Map<string, string>([
  [
    "agent/auth.json",
    `${JSON.stringify({ anthropic: { type: "api_key", key: "sk-sentinel-poison" } })}\n`,
  ],
  ["agent/settings.json", "{ this is not JSON: sentinel poison\n"],
  ["agent/web-search.json", `${JSON.stringify({ provider: "sentinel-poison" })}\n`],
  [
    "skills/sentinel/SKILL.md",
    "---\nname: sentinel\ndescription: Sentinel poison skill; must never load.\n---\nPoison.\n",
  ],
  ["agent-memory/x/MEMORY.md", "sentinel poison memory\n"],
  ["pi-acp/session-map.json", `${JSON.stringify({ poison: "sentinel" })}\n`],
  ["config/pi-agent-browser-native/config.json", `${JSON.stringify({ poison: "sentinel" })}\n`],
  [".choco-pi-sentinel", "created by tests/live/standalone-sentinel.ts\n"],
]);

async function exists(file: string): Promise<boolean> {
  return fsPromises.lstat(file).then(
    () => true,
    () => false,
  );
}

async function preparePoison(piDir: string): Promise<void> {
  const real = path.join(userInfo().homedir, ".pi");
  if (path.resolve(piDir) === real) throw new Error(`refusing to touch the real ${real}`);
  if ((await exists(piDir)) && !(await exists(path.join(piDir, ".choco-pi-sentinel")))) {
    throw new Error(`${piDir} exists and was not created by this probe`);
  }
  await fsPromises.rm(piDir, { recursive: true, force: true });
  for (const [relative, contents] of POISON) {
    const target = path.join(piDir, relative);
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    await fsPromises.writeFile(target, contents);
  }
}

async function listing(root: string): Promise<string> {
  const entries = [".", ...(await fsPromises.readdir(root, { recursive: true }))].toSorted();
  const lines: string[] = [];
  for (const entry of entries) {
    const info = await fsPromises.lstat(path.join(root, entry));
    lines.push(`${entry}\t${info.mode.toString(8)}\t${info.size}\t${info.mtimeMs}`);
  }
  return lines.join("\n");
}

/** Backdated atime of the poison files: any content read moves it forward. */
const BACKDATED_ATIME = new Date("2001-01-01T00:00:00.000Z");

async function backdatePoisonAtimes(piDir: string): Promise<void> {
  for (const relative of POISON.keys()) {
    const file = path.join(piDir, relative);
    const info = await fsPromises.lstat(file);
    await fsPromises.utimes(file, BACKDATED_ATIME, info.mtime);
  }
}

async function readPoisonFiles(piDir: string): Promise<string[]> {
  const read: string[] = [];
  for (const relative of POISON.keys()) {
    const info = await fsPromises.lstat(path.join(piDir, relative));
    if (info.atimeMs !== BACKDATED_ATIME.getTime()) read.push(relative);
  }
  return read;
}

/** `self env --json`'s runtime report under the probe environment. */
async function resolvedRuntime(options: Options, environment: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn(options.launcher, ["self", "env", "--json"], {
    cwd: options.project,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (output += chunk));
  child.stderr.resume();
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  if (code !== 0) return `self env failed (exit ${code})`;
  return String(jsonField(output, "runtime"));
}

type Exchange = {
  responses: Map<string, string>;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

/** Runs `args` through the launcher, writes `requests` one per line, waits for responses with `ids`. */
async function exchange(
  options: Options,
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
  requests: readonly string[],
  idOf: (line: string) => string | null,
  stderrFile: string,
): Promise<Exchange> {
  const stderrHandle = await fsPromises.open(stderrFile, "w");
  const child = spawn(options.launcher, args, {
    cwd: options.project,
    env: environment,
    stdio: ["pipe", "pipe", stderrHandle.fd],
  });
  const { stdin, stdout } = child;
  if (stdin === null || stdout === null) throw new Error("spawn did not create stdio pipes");
  const responses = new Map<string, string>();
  const wanted = requests.length;
  let timedOut = false;
  const lines = createInterface({ input: stdout });
  const timer = setTimeout(() => {
    timedOut = true;
    lines.close();
  }, 90_000);
  let next = 0;
  stdin.write(`${requests[next++]}\n`);
  for await (const line of lines) {
    const id = idOf(line);
    if (id === null) continue;
    responses.set(id, line);
    if (next < wanted) stdin.write(`${requests[next++]}\n`);
    if (responses.size === wanted) break;
  }
  clearTimeout(timer);
  stdin.end();
  const exited = new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
  const killer = setTimeout(() => child.kill("SIGTERM"), 15_000);
  const exitCode = await exited;
  clearTimeout(killer);
  await stderrHandle.close();
  return { responses, stderr: await fsPromises.readFile(stderrFile, "utf8"), exitCode, timedOut };
}

/** A top-level field of a JSON line: booleans as is, objects re-serialized, others as strings; null when absent. */
function jsonField(line: string | undefined, key: string): string | boolean | null {
  if (line === undefined) return null;
  const parsed: unknown = JSON.parse(line);
  const value =
    parsed instanceof Object ? Object.getOwnPropertyDescriptor(parsed, key)?.value : undefined;
  if (value === undefined || value === null) return null;
  if (value === true || value === false) return value;
  return value instanceof Object ? JSON.stringify(value) : String(value);
}

function rpcId(line: string): string | null {
  try {
    const id = jsonField(line, "id");
    return jsonField(line, "type") === "response" && id !== null ? String(id) : null;
  } catch {
    return null;
  }
}

function acpId(line: string): string | null {
  try {
    const id = jsonField(line, "id");
    return jsonField(line, "method") === null && id !== null ? String(id) : null;
  } catch {
    return null;
  }
}

async function runRpc(options: Options, environment: NodeJS.ProcessEnv, stderrFile: string) {
  const result = await exchange(
    options,
    environment,
    ["--mode", "rpc"],
    [
      JSON.stringify({ type: "get_state", id: "state" }),
      JSON.stringify({ type: "get_commands", id: "commands" }),
    ],
    rpcId,
    stderrFile,
  );
  const commandsText = result.responses.get("commands");
  return {
    started: jsonField(result.responses.get("state"), "success") === true,
    commandsListed: jsonField(commandsText, "success") === true,
    sentinelLoaded: /sentinel/i.test(commandsText ?? ""),
    result,
  };
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const piDir = path.join(options.home, ".pi");
  const realPiDir = path.join(await fsPromises.realpath(options.home), ".pi");
  const work = path.join(options.home, "..", `sentinel-${process.pid}`);
  await fsPromises.mkdir(work, { recursive: true });
  await fsPromises.mkdir(options.project, { recursive: true });
  await preparePoison(piDir);
  await backdatePoisonAtimes(piDir);
  const before = await listing(piDir);
  const logFile = path.join(work, "hits.log");
  const environment: NodeJS.ProcessEnv = {
    HOME: options.home,
    PATH: options.searchPath,
    TERM: "dumb",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `--import=${SELF}`,
    BUN_OPTIONS: `--preload=${SELF}`,
    [ROOTS_VARIABLE]: [...new Set([piDir, realPiDir])].join(path.delimiter),
    [LOG_VARIABLE]: logFile,
  };
  if (options.runtime !== null) environment.CHOCO_PI_RUNTIME = options.runtime;
  const runtime = await resolvedRuntime(options, environment);

  const rpc = await runRpc(options, environment, path.join(work, "rpc.stderr"));
  const acp = await exchange(
    options,
    environment,
    ["self", "acp"],
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: options.project, mcpServers: [] },
      }),
    ],
    acpId,
    path.join(work, "acp.stderr"),
  );
  const afterFirst = await listing(piDir);

  const originalMode = (await fsPromises.stat(piDir)).mode & 0o7777;
  await fsPromises.chmod(piDir, 0o000);
  let locked;
  try {
    locked = await runRpc(options, environment, path.join(work, "rpc-locked.stderr"));
  } finally {
    await fsPromises.chmod(piDir, originalMode);
  }
  const afterLocked = await listing(piDir);
  const readFiles = await readPoisonFiles(piDir);
  const logged = (await exists(logFile)) ? await fsPromises.readFile(logFile, "utf8") : "";
  const hits = [
    ...new Set(
      [rpc.result.stderr, acp.stderr, locked.result.stderr, logged]
        .flatMap((text) => text.split("\n"))
        .filter((line) => line.startsWith(HIT_PREFIX)),
    ),
  ];
  const acpSession = acp.responses.get("2");
  const summary = {
    runtime,
    hits,
    read_files: readFiles,
    listing_unchanged: before === afterFirst && before === afterLocked,
    rpc_started: rpc.started,
    rpc_commands_listed: rpc.commandsListed,
    sentinel_loaded: rpc.sentinelLoaded,
    rpc_exit: rpc.result.exitCode,
    acp_initialized: jsonField(acp.responses.get("1"), "result") !== null,
    acp_session:
      acpSession === undefined
        ? "no response"
        : jsonField(acpSession, "error") === null
          ? "created"
          : acpSession.slice(0, 300),
    locked_started: locked.started,
    locked_eacces: /EACCES|EPERM/.test(locked.result.stderr),
    extension_errors: [rpc.result.stderr, acp.stderr, locked.result.stderr]
      .flatMap((text) => text.split("\n"))
      .filter(
        (line) => /Failed to load extension|Error:/.test(line) && !line.startsWith(HIT_PREFIX),
      ),
    work,
  };
  const pass =
    hits.length === 0 &&
    readFiles.length === 0 &&
    (options.runtime === null || runtime.includes(`"name":"${options.runtime}"`)) &&
    summary.listing_unchanged &&
    summary.rpc_started &&
    summary.rpc_commands_listed &&
    !summary.sentinel_loaded &&
    summary.acp_initialized &&
    summary.locked_started &&
    !summary.locked_eacces;
  console.log(JSON.stringify({ pass, ...summary }, null, 2));
  return pass ? 0 : 1;
}

if (isMain) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
