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
  CONTRACT_VARIABLES,
  MANAGEMENT_VERBS,
  PI_BIN_ENTRY,
  PI_CLI_RELATIVE,
  PI_PACKAGE_RELATIVE,
  PI_SUBCOMMANDS,
  UNSET_PI_VARIABLES,
} from "../scripts/standalone/contract.ts";

const runFile = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(ROOT, "bin", "choco-pi");
const NODE_DIR = path.dirname(process.execPath);

const EnvReportSchema = obj({
  contract: map(nullable(str())),
  unset: map(nullable(str())),
  requested: map(nullable(str())),
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
  assert.deepEqual(report.contract, {
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
  const verbs = /\n {4}setup \| update \| uninstall \| env \| help\)/.test(script);
  assert.ok(verbs, "management verbs case arm");
  assert.match(script, /\n {4}exec\)/);
  assert.match(script, /\n {4}acp\)/);
  assert.deepEqual([...MANAGEMENT_VERBS].toSorted(), [
    "acp",
    "env",
    "exec",
    "help",
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
