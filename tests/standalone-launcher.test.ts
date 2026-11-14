import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compile, map, nullable, obj, str, type Static } from "@earendil-works/pi-schema";

import {
  BUNFIG_RELATIVE,
  CONTRACT_VARIABLES,
  MANAGEMENT_VERBS,
  PI_BIN_ENTRY,
  PI_CLI_RELATIVE,
  PI_PACKAGE_RELATIVE,
  PI_SUBCOMMANDS,
  UNSET_PI_VARIABLES,
} from "../scripts/standalone/contract.ts";
import { findSystemBun, readRuntimePins } from "../scripts/standalone/provision.ts";

const runFile = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(ROOT, "bin", "choco-pi");
const NODE_DIR = path.dirname(process.execPath);

const EnvReportSchema = obj({
  contract: map(nullable(str())),
  unset: map(nullable(str())),
  requested: map(nullable(str())),
  runtime: obj({ name: str(), source: str(), binary: nullable(str()) }),
  node: str(),
  app: str(),
  path: nullable(str()),
});
type EnvReport = Static<typeof EnvReportSchema>;
const isEnvReport = compile(EnvReportSchema).check;

function parseEnvReport(text: string): EnvReport {
  const parsed: unknown = JSON.parse(text);
  if (!isEnvReport(parsed)) throw new Error(`unexpected self env output: ${text}`);
  return parsed;
}

async function scratch(t: test.TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "choco-pi-launcher-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function selfEnv(
  launcher: string,
  environment: NodeJS.ProcessEnv,
  names: readonly string[],
): Promise<EnvReport> {
  const { stdout } = await runFile(launcher, ["self", "env", "--json", ...names], {
    env: environment,
    timeout: 30_000,
  });
  return parseEnvReport(stdout);
}

const HOSTILE = "/hostile/value";

test("self env applies the contract over hostile inherited values and passes everything else through", async (t) => {
  const directory = await scratch(t);
  const home = path.join(directory, "choco-home");
  const hostile: NodeJS.ProcessEnv = {};
  for (const name of [...CONTRACT_VARIABLES, ...UNSET_PI_VARIABLES]) hostile[name] = HOSTILE;
  delete hostile.PI_SKIP_VERSION_CHECK;
  const passThrough = {
    REX_SERVER: "unix:/tmp/rex.sock",
    REX_SESSION: "session-1",
    REX_BLOCK: "block-7",
    PI_PROGRAM_STATUS: "1",
    PI_OFFLINE: "1",
    PI_TUI_DEBUG: "0",
    FOO: "bar baz",
  };
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...hostile,
    ...passThrough,
    CHOCO_PI_HOME: home,
    HOME: path.join(directory, "user-home"),
  };
  const report = await selfEnv(LAUNCHER, environment, Object.keys(passThrough));
  const launcherReal = await realpath(LAUNCHER);
  const { CHOCO_PI_NODE: selectedNode, ...contract } = report.contract;
  assert.ok(selectedNode !== null && selectedNode !== HOSTILE && path.isAbsolute(selectedNode));
  assert.deepEqual(report.runtime, { name: "node", source: "default", binary: selectedNode });
  assert.deepEqual(contract, {
    CHOCO_PI_HOME: home,
    CHOCO_PI_STANDALONE: "1",
    CHOCO_PI_LAUNCHER: launcherReal,
    PI_CODING_AGENT_DIR: path.join(home, "agent"),
    CHOCO_PI_LSP_HOME: path.join(home, "lsp"),
    PI_ACP_PI_COMMAND: launcherReal,
    CHOCO_PI_HOOKS_PI_BIN: launcherReal,
    PI_SKIP_VERSION_CHECK: "1",
  });
  for (const name of UNSET_PI_VARIABLES) assert.equal(report.unset[name], null, name);
  assert.deepEqual(report.requested, passThrough);
  assert.equal(report.app, ROOT);
  assert.equal(report.path, environment.PATH, "PATH stays unchanged when it has a node");

  const kept = await selfEnv(LAUNCHER, { ...environment, PI_SKIP_VERSION_CHECK: "0" }, []);
  assert.equal(kept.contract.PI_SKIP_VERSION_CHECK, "0", "a user-set PI_SKIP_VERSION_CHECK wins");
});

test("self exec runs a command under the same contract", async (t) => {
  const directory = await scratch(t);
  const home = path.join(directory, "choco-home");
  const { stdout } = await runFile(LAUNCHER, ["self", "exec", "env"], {
    env: {
      ...process.env,
      CHOCO_PI_HOME: home,
      PI_PACKAGE_DIR: HOSTILE,
      CHOCO_PI_HOOKS_PI_BIN: HOSTILE,
      FOO: "1",
    },
  });
  const lines = new Set(stdout.split("\n"));
  assert.ok(lines.has(`PI_CODING_AGENT_DIR=${path.join(home, "agent")}`));
  assert.ok(lines.has(`CHOCO_PI_HOOKS_PI_BIN=${await realpath(LAUNCHER)}`));
  assert.ok(lines.has("FOO=1"));
  assert.ok(![...lines].some((line) => line.startsWith("PI_PACKAGE_DIR=")));
});

/** A minimal app tree whose launcher and management code are copies of this checkout's. */
async function copyApp(app: string): Promise<void> {
  await mkdir(path.join(app, "bin"), { recursive: true });
  await cp(LAUNCHER, path.join(app, "bin", "choco-pi"));
  await cp(path.join(ROOT, "scripts", "standalone"), path.join(app, "scripts", "standalone"), {
    recursive: true,
  });
  // The management CLI's dependencies, linked one by one: tests write a stub
  // Pi into app/node_modules, which must never reach this checkout's own.
  for (const name of ["@optique/core", "@logtape/logtape", "@earendil-works/pi-schema"]) {
    const link = path.join(app, "node_modules", name);
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(await realpath(path.join(ROOT, "node_modules", name)), link);
  }
}

test("home and node selection: symlinked launcher, install.json parent, recorded node, PATH without node", async (t) => {
  const directory = await scratch(t);
  const home = path.join(directory, "installed");
  const app = path.join(home, "app");
  await copyApp(app);
  await writeFile(
    path.join(home, "install.json"),
    `{\n  "schema": 1,\n  "node_path": "${process.execPath}"\n}\n`,
  );
  const binDir = path.join(directory, "bin");
  await mkdir(binDir);
  await symlink(path.join(app, "bin", "choco-pi"), path.join(binDir, "choco-pi"));
  const environment: NodeJS.ProcessEnv = {
    HOME: path.join(directory, "user-home"),
    PATH: "/usr/bin:/bin",
  };
  const pathHasNode = await runFile("/bin/sh", ["-c", "command -v node"], {
    env: environment,
  }).then(
    () => true,
    () => false,
  );
  const report = await selfEnv(path.join(binDir, "choco-pi"), environment, []);
  assert.equal(
    report.contract.CHOCO_PI_HOME,
    home,
    "the parent of the app wins when it holds install.json",
  );
  assert.equal(report.contract.CHOCO_PI_LAUNCHER, path.join(app, "bin", "choco-pi"));
  assert.equal(report.node, process.execPath, "the recorded node path is used");
  assert.equal(
    report.contract.CHOCO_PI_NODE,
    process.execPath,
    "CHOCO_PI_NODE is the selected node",
  );
  if (!pathHasNode)
    assert.equal(
      report.path,
      `/usr/bin:/bin:${NODE_DIR}`,
      "node dir appended when PATH has no node",
    );

  const fallback = await selfEnv(
    LAUNCHER,
    { ...environment, PATH: `${NODE_DIR}:/usr/bin:/bin` },
    [],
  );
  assert.equal(fallback.contract.CHOCO_PI_HOME, path.join(directory, "user-home", ".choco-pi"));
});

test("Pi dispatch refuses to start without a profile marker", async (t) => {
  const directory = await scratch(t);
  const result = await runFile(LAUNCHER, ["--mode", "rpc"], {
    env: { ...process.env, CHOCO_PI_HOME: path.join(directory, "home"), HOME: directory },
  }).then(
    () => null,
    (error: Error & { code?: number; stderr?: string }) => error,
  );
  assert.ok(result !== null);
  assert.equal(result.code, 1);
  assert.match(String(result.stderr), /run choco-pi self setup/);
});

test("launcher, contract module and Pi's manifest agree", async () => {
  const script = await readFile(LAUNCHER, "utf8");
  const verbs = /\n {4}setup \| update \| uninstall \| env \| runtime \| help\)/.test(script);
  assert.ok(verbs, "management verbs case arm");
  assert.match(script, /\n {4}exec\)/);
  assert.match(script, /\n {4}acp\)/);
  assert.deepEqual([...MANAGEMENT_VERBS].toSorted(), [
    "acp",
    "env",
    "exec",
    "help",
    "runtime",
    "setup",
    "uninstall",
    "update",
  ]);
  const unsetLine = /\nunset (PI_[A-Z_ ]+)\n/.exec(script);
  assert.ok(unsetLine !== null);
  assert.deepEqual(unsetLine[1].trim().split(/\s+/), [...UNSET_PI_VARIABLES]);
  assert.ok(!/PI_\*|PI_\[/.test(script.replace(/^#.*$/gm, "")), "no PI_* wildcard");
  assert.match(
    script,
    new RegExp(`\\nPI_CLI_RELATIVE=${PI_CLI_RELATIVE.replaceAll(".", "\\.")}\\n`),
  );
  const manifest: unknown = JSON.parse(
    await readFile(path.join(ROOT, PI_PACKAGE_RELATIVE, "package.json"), "utf8"),
  );
  const bin = manifest instanceof Object && "bin" in manifest ? manifest.bin : null;
  assert.deepEqual(bin, { pi: PI_BIN_ENTRY });
  const dispatch = script.slice(script.lastIndexOf("\nexec "));
  assert.equal(
    dispatch.trim(),
    'exec "$NODE" "$APP/$PI_CLI_RELATIVE" "$@"',
    "Pi dispatch is a plain exec",
  );
  assert.match(
    script,
    /\n {2}exec "\$BUN" --no-env-file --no-install --config="\$APP\/\$BUNFIG_RELATIVE" "\$APP\/\$PI_CLI_RELATIVE" "\$@"\n/,
    "Bun dispatch is a plain exec with Bun's cwd config and .env loading off",
  );
  assert.match(
    script,
    new RegExp(`\\nBUNFIG_RELATIVE=${BUNFIG_RELATIVE.replaceAll(".", "\\.")}\\n`),
  );
  assert.match(await readFile(path.join(ROOT, BUNFIG_RELATIVE), "utf8"), /intentionally empty/);
});

test("self verbs never collide with Pi subcommands: Pi's words always reach Pi", async (t) => {
  assert.ok(!new Set<string>(PI_SUBCOMMANDS).has("self"), "Pi has no self subcommand");
  const directory = await scratch(t);
  const home = path.join(directory, "home");
  const app = path.join(directory, "app");
  await copyApp(app);
  const stub = path.join(app, PI_CLI_RELATIVE);
  await mkdir(path.dirname(stub), { recursive: true });
  await writeFile(
    stub,
    'process.stdout.write(JSON.stringify(["PI", ...process.argv.slice(2)]));\n',
  );
  await mkdir(path.join(home, "agent", "choco-pi"), { recursive: true });
  await writeFile(path.join(home, "agent", "choco-pi", "profile.json"), "{}\n");
  const environment = { ...process.env, CHOCO_PI_HOME: home, HOME: directory };
  const cases = [
    ...PI_SUBCOMMANDS.map((command) => [command, "--help"]),
    ["self"],
    ["self", "unknown-verb"],
    ["--mode", "rpc", "a b"],
  ];
  for (const args of cases) {
    const { stdout } = await runFile(path.join(app, "bin", "choco-pi"), args, { env: environment });
    assert.deepEqual(JSON.parse(stdout), ["PI", ...args], args.join(" "));
  }
  const { stdout: help } = await runFile(path.join(app, "bin", "choco-pi"), ["self", "help"], {
    env: environment,
  });
  assert.match(help, /Management commands/);
});

async function executableOf(pid: number): Promise<string> {
  if (process.platform === "linux") return readlink(`/proc/${pid}/exe`);
  const { stdout } = await runFile("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"]);
  const first = stdout.split("\n").find((line) => line.startsWith("n"));
  return first === undefined ? "" : first.slice(1);
}

test("AC11: --mode rpc leaves node, titled pi, as the spawned process with no sh or choco-pi in its group", async (t) => {
  const directory = await scratch(t);
  const home = path.join(directory, "home");
  await mkdir(path.join(home, "agent", "choco-pi"), { recursive: true });
  await writeFile(path.join(home, "agent", "choco-pi", "profile.json"), "{}\n");
  const child = spawn(LAUNCHER, ["--mode", "rpc"], {
    cwd: directory,
    detached: true,
    env: { ...process.env, CHOCO_PI_HOME: home, HOME: directory, PI_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const pid = child.pid;
  assert.ok(pid !== undefined);
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(`${JSON.stringify({ type: "get_state", id: "ready" })}\n`);
  for await (const line of lines) {
    if (line.includes('"ready"')) break;
  }
  const { stdout: own } = await runFile("ps", ["-p", String(pid), "-o", "comm=,args="]);
  const executable = await executableOf(pid);
  t.diagnostic(`ps -p ${pid} -o comm=,args=: ${own.trim()}; executable: ${executable}`);
  assert.match(own.trim(), /^(pi|\S*node)\s+pi\b/, `process ${pid} is titled pi: ${own}`);
  assert.match(path.basename(executable), /^node/, "the spawned pid runs node");
  const { stdout: table } = await runFile("ps", ["-A", "-o", "pid=,pgid=,comm=,args="]);
  const group = table
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[1] === String(pid));
  assert.ok(
    group.some((fields) => fields[0] === String(pid)),
    "the spawned pid leads its group",
  );
  t.diagnostic(
    `process group ${pid}: ${group.map((fields) => fields.slice(0, 3).join(" ")).join("; ")}`,
  );
  for (const fields of group) {
    const command = path.basename(fields[2] ?? "");
    assert.ok(
      !["sh", "dash", "bash", "zsh", "choco-pi"].includes(command),
      `unexpected ${fields.join(" ")}`,
    );
    assert.ok(
      !fields.slice(3).join(" ").includes("bin/choco-pi"),
      `launcher still running: ${fields.join(" ")}`,
    );
  }
  child.stdin.end();
  if (child.exitCode === null) await once(child, "exit");
});

// ------------------------------------------------------------ runtime option

type Outcome = { code: number; stdout: string; stderr: string };

async function runLauncher(
  launcher: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<Outcome> {
  return runFile(launcher, args, { env: environment, timeout: 60_000 }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: Error & { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code ?? -1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }),
  );
}

/** A copied app with a stub Pi (prints ["PI", ...argv]) and a profile marker in \`home\`. */
async function stubApp(directory: string, home: string): Promise<string> {
  const app = path.join(directory, "app");
  await copyApp(app);
  const stub = path.join(app, PI_CLI_RELATIVE);
  await mkdir(path.dirname(stub), { recursive: true });
  await writeFile(
    stub,
    'process.stdout.write(JSON.stringify(["PI", ...process.argv.slice(2)]));\n',
  );
  await mkdir(path.join(home, "agent", "choco-pi"), { recursive: true });
  await writeFile(path.join(home, "agent", "choco-pi", "profile.json"), "{}\n");
  return path.join(app, "bin", "choco-pi");
}

/** A fake \`bun\`: answers the installer's probe as \`version\`, prints 1.5.2 for --version, else its argv. */
async function fakeBun(directory: string, version: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const bun = path.join(directory, "bun");
  await writeFile(
    bun,
    [
      "#!/bin/sh",
      `if [ "$1" = --no-env-file ] && [ "$2" = -e ]; then printf '%s\\n%s' '${version}' "$0"; exit 0; fi`,
      `[ "$1" != --version ] || { echo '${version}'; exit 0; }`,
      'for a; do [ "$a" != --version ] || { echo 1.5.2; exit 0; }; done',
      'printf \'%s\\n\' BUN "NODE=$CHOCO_PI_NODE" "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return bun;
}

async function writeLauncherManifest(home: string, fields: Record<string, string>): Promise<void> {
  const lines = Object.entries({ node_path: process.execPath, ...fields }).map(
    ([key, value]) => `  "${key}": ${JSON.stringify(value)}`,
  );
  await writeFile(path.join(home, "install.json"), `{\n  "schema": 1,\n${lines.join(",\n")}\n}\n`);
}

const BASE_PATH = "/usr/bin:/bin";

async function pathHasBun(searchPath: string): Promise<boolean> {
  return runFile("/bin/sh", ["-c", "command -v bun"], { env: { PATH: searchPath } }).then(
    () => true,
    () => false,
  );
}

test("runtime precedence: CHOCO_PI_RUNTIME, then install.json, then node; Bun gets a hardened plain exec", async (t) => {
  const directory = await scratch(t);
  const home = path.join(directory, "home");
  const launcher = await stubApp(directory, home);
  const app = path.dirname(path.dirname(launcher));
  const bun = await fakeBun(path.join(directory, "recorded-bun"), "1.4.4");
  const environment = { HOME: directory, PATH: BASE_PATH, CHOCO_PI_HOME: home };
  const bunArgv = (...args: string[]) =>
    [
      "BUN",
      `NODE=${process.execPath}`,
      "--no-env-file",
      "--no-install",
      `--config=${path.join(app, BUNFIG_RELATIVE)}`,
      path.join(app, PI_CLI_RELATIVE),
      ...args,
      "",
    ].join("\n");
  const args = ["--mode", "rpc", "a b"];

  await writeLauncherManifest(home, {});
  assert.deepEqual(JSON.parse((await runLauncher(launcher, args, environment)).stdout), [
    "PI",
    ...args,
  ]);
  assert.deepEqual((await selfEnv(launcher, environment, [])).runtime, {
    name: "node",
    source: "default",
    binary: process.execPath,
  });

  await writeLauncherManifest(home, { runtime: "bun", bun_path: bun });
  const persisted = await runLauncher(launcher, args, environment);
  assert.equal(
    persisted.stdout,
    bunArgv(...args),
    "install.json runtime bun runs the recorded bun",
  );
  assert.deepEqual((await selfEnv(launcher, environment, [])).runtime, {
    name: "bun",
    source: "install.json",
    binary: bun,
  });

  const forcedNode = await runLauncher(launcher, args, {
    ...environment,
    CHOCO_PI_RUNTIME: "node",
  });
  assert.deepEqual(JSON.parse(forcedNode.stdout), ["PI", ...args], "env beats install.json");
  assert.equal(
    (await selfEnv(launcher, { ...environment, CHOCO_PI_RUNTIME: "node" }, [])).runtime.source,
    "env",
  );

  await writeLauncherManifest(home, { runtime: "node", bun_path: bun });
  const forcedBun = await runLauncher(launcher, args, { ...environment, CHOCO_PI_RUNTIME: "bun" });
  assert.equal(forcedBun.stdout, bunArgv(...args), "env bun beats install.json node");
  const empty = await runLauncher(launcher, args, { ...environment, CHOCO_PI_RUNTIME: "" });
  assert.deepEqual(JSON.parse(empty.stdout), ["PI", ...args], "an empty CHOCO_PI_RUNTIME is unset");

  if (await pathHasBun(BASE_PATH)) {
    t.diagnostic(`${BASE_PATH} has a bun; PATH-bun cases skipped`);
    return;
  }
  await writeLauncherManifest(home, { runtime: "bun" });
  const pins = await readRuntimePins();
  await fakeBun(path.join(directory, "path-bun"), pins.bunMinimumVersion);
  const viaPath = await runLauncher(launcher, args, {
    ...environment,
    PATH: `${path.join(directory, "path-bun")}:${BASE_PATH}`,
  });
  assert.match(viaPath.stdout, /^BUN\n/, "a PATH bun at the pinned minimum is used");
  await mkdir(path.join(home, "runtime", "bun", "bin"), { recursive: true });
  await fakeBun(path.join(home, "runtime", "bun", "bin"), "1.4.4");
  const report = await selfEnv(launcher, environment, []);
  assert.equal(report.runtime.binary, path.join(home, "runtime", "bun", "bin", "bun"));
});

test("invalid runtime values are errors naming node and bun, and start nothing", async (t) => {
  const directory = await scratch(t);
  const home = path.join(directory, "home");
  const launcher = await stubApp(directory, home);
  const environment = { HOME: directory, PATH: BASE_PATH, CHOCO_PI_HOME: home };
  await writeLauncherManifest(home, {});
  for (const value of ["deno", "Bun", "node "]) {
    const result = await runLauncher(launcher, ["--version"], {
      ...environment,
      CHOCO_PI_RUNTIME: value,
    });
    assert.equal(result.code, 1, value);
    assert.match(result.stderr, /CHOCO_PI_RUNTIME must be node or bun/, value);
    assert.equal(result.stdout, "", "Pi never started");
  }
  await writeLauncherManifest(home, { runtime: "deno" });
  for (const args of [["--version"], ["self", "env"]]) {
    const result = await runLauncher(launcher, args, environment);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /records runtime 'deno'; it must be node or bun/);
    assert.equal(result.stdout, "");
  }
});

test("Bun selected but unavailable exits 1 with guidance and never falls back to Node", async (t) => {
  if (await pathHasBun(BASE_PATH)) {
    t.skip(`${BASE_PATH} has a bun`);
    return;
  }
  const directory = await scratch(t);
  const home = path.join(directory, "home");
  const launcher = await stubApp(directory, home);
  const old = path.join(directory, "old-bun");
  await fakeBun(old, "1.0.0");
  const environment = { HOME: directory, PATH: `${old}:${BASE_PATH}`, CHOCO_PI_HOME: home };
  await writeLauncherManifest(home, {
    runtime: "bun",
    bun_path: path.join(directory, "gone", "bun"),
  });
  for (const [label, extra] of [
    ["install.json", {}],
    ["env", { CHOCO_PI_RUNTIME: "bun" }],
  ] as const) {
    const result = await runLauncher(launcher, ["--mode", "rpc"], { ...environment, ...extra });
    assert.equal(result.code, 1, label);
    assert.equal(result.stdout, "", `${label}: neither Node nor the old bun ran Pi`);
    assert.match(result.stderr, /Bun is selected .* but no usable bun was found/, label);
    assert.match(result.stderr, /choco-pi self runtime node/, label);
    assert.match(result.stderr, /install\.sh --runtime bun/, label);
    if (label === "env") assert.match(result.stderr, /unset CHOCO_PI_RUNTIME/);
  }
  const report = await selfEnv(launcher, environment, []);
  assert.deepEqual(report.runtime, { name: "bun", source: "install.json", binary: null });
});

/** A copied app that shares this checkout's node_modules (pi-schema and the real Pi). */
async function linkedApp(directory: string): Promise<string> {
  const app = path.join(directory, "app");
  await copyApp(app);
  await rm(path.join(app, "node_modules"), { recursive: true });
  await symlink(path.join(ROOT, "node_modules"), path.join(app, "node_modules"));
  return path.join(app, "bin", "choco-pi");
}

test("self runtime shows the effective runtime and its source, and persists node or bun", async (t) => {
  if (await pathHasBun(BASE_PATH)) {
    t.skip(`${BASE_PATH} has a bun`);
    return;
  }
  const directory = await scratch(t);
  const home = path.join(directory, "home");
  await mkdir(path.join(home, "agent", "choco-pi"), { recursive: true });
  await writeFile(path.join(home, "agent", "choco-pi", "profile.json"), "{}\n");
  const launcher = await linkedApp(directory);
  const app = path.dirname(path.dirname(launcher));
  const manifestFile = path.join(home, "install.json");
  const legacy = {
    schema: 1,
    name: "choco-pi",
    home,
    app,
    source: null,
    ref: null,
    rev: null,
    node_path: process.execPath,
    bin_link: null,
    created: [manifestFile],
    installed_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(manifestFile, `${JSON.stringify(legacy, null, 2)}\n`);
  const bunDir = path.join(directory, "bun-bin");
  const bun = await fakeBun(bunDir, "1.4.4");
  const environment = { HOME: directory, PATH: `${bunDir}:${BASE_PATH}`, CHOCO_PI_HOME: home };
  const readManifest = async () => {
    const parsed: unknown = JSON.parse(await readFile(manifestFile, "utf8"));
    return parsed instanceof Object ? new Map(Object.entries(parsed)) : new Map<string, unknown>();
  };

  const shown = await runLauncher(launcher, ["self", "runtime"], environment);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(
    shown.stdout,
    /^runtime=node\nsource=default\nbinary=.*\nnode=.*\npersisted=node \(default\)\n$/,
  );

  const toBun = await runLauncher(launcher, ["self", "runtime", "bun"], environment);
  assert.equal(toBun.code, 0, toBun.stderr);
  assert.match(
    toBun.stdout,
    new RegExp(`bun: system ${bun.replaceAll(".", "\\.")} \\(1\\.4\\.4\\)`),
  );
  let manifest = await readManifest();
  assert.equal(manifest.get("runtime"), "bun");
  assert.equal(manifest.get("bun_path"), bun);
  const run = await runLauncher(launcher, ["--mode", "rpc"], { ...environment, PATH: BASE_PATH });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^BUN\n/, "the recorded bun runs Pi even with no bun on PATH");

  const afterBun = await runLauncher(launcher, ["self", "runtime"], environment);
  assert.match(
    afterBun.stdout,
    new RegExp(
      `^runtime=bun\\nsource=${manifestFile.replaceAll(".", "\\.")}\\nbinary=${bun.replaceAll(".", "\\.")}\\n`,
    ),
  );
  const overridden = await runLauncher(launcher, ["self", "runtime"], {
    ...environment,
    CHOCO_PI_RUNTIME: "node",
  });
  assert.match(overridden.stdout, /^runtime=node\nsource=env CHOCO_PI_RUNTIME\n/);

  const toNode = await runLauncher(launcher, ["self", "runtime", "node"], environment);
  assert.equal(toNode.code, 0, toNode.stderr);
  manifest = await readManifest();
  assert.equal(manifest.get("runtime"), "node");
  assert.equal(manifest.get("bun_path"), bun, "the bun path stays recorded for a later switch");

  const invalid = await runLauncher(launcher, ["self", "runtime", "deno"], environment);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /Expected one of "node" and "bun", but got "deno"/);
  await rm(manifestFile);
  const unmanaged = await runLauncher(launcher, ["self", "runtime", "bun"], {
    ...environment,
    PATH: `${environment.PATH}:${NODE_DIR}`,
  });
  assert.equal(unmanaged.code, 1);
  assert.match(unmanaged.stderr, /set CHOCO_PI_RUNTIME=bun per invocation/);
});

test("AC11 under Bun: --mode rpc leaves bun as the spawned process with no sh or choco-pi in its group", async (t) => {
  const pins = await readRuntimePins();
  const directory = await scratch(t);
  const systemBun = await findSystemBun(process.env.PATH ?? "", pins.bunMinimumVersion, directory);
  if (systemBun === null) {
    t.skip(`needs bun >= ${pins.bunMinimumVersion} on PATH`);
    return;
  }
  const home = path.join(directory, "home");
  await mkdir(path.join(home, "agent", "choco-pi"), { recursive: true });
  await writeFile(path.join(home, "agent", "choco-pi", "profile.json"), "{}\n");
  const child = spawn(LAUNCHER, ["--mode", "rpc"], {
    cwd: directory,
    detached: true,
    env: {
      ...process.env,
      CHOCO_PI_HOME: home,
      HOME: directory,
      PI_OFFLINE: "1",
      CHOCO_PI_RUNTIME: "bun",
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const pid = child.pid;
  assert.ok(pid !== undefined);
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(`${JSON.stringify({ type: "get_state", id: "ready" })}\n`);
  for await (const line of lines) {
    if (line.includes('"ready"')) break;
  }
  const { stdout: own } = await runFile("ps", ["-p", String(pid), "-o", "comm=,args="]);
  const executable = await executableOf(pid);
  t.diagnostic(`ps -p ${pid} -o comm=,args=: ${own.trim()}; executable: ${executable}`);
  assert.match(path.basename(executable), /^bun/, "the spawned pid runs bun");
  assert.match(
    own,
    /--no-env-file --no-install --config=\S+bunfig\.toml \S+\/dist\/bundle\/cli\.js --mode rpc/,
  );
  const { stdout: table } = await runFile("ps", ["-A", "-o", "pid=,pgid=,comm=,args="]);
  const group = table
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[1] === String(pid));
  assert.ok(
    group.some((fields) => fields[0] === String(pid)),
    "the spawned pid leads its group",
  );
  t.diagnostic(
    `process group ${pid}: ${group.map((fields) => fields.slice(0, 3).join(" ")).join("; ")}`,
  );
  for (const fields of group) {
    const command = path.basename(fields[2] ?? "");
    assert.ok(!["sh", "dash", "bash", "zsh", "choco-pi"].includes(command), fields.join(" "));
    assert.ok(!fields.slice(3).join(" ").includes("bin/choco-pi"), fields.join(" "));
  }
  child.stdin.end();
  if (child.exitCode === null) await once(child, "exit");
});
