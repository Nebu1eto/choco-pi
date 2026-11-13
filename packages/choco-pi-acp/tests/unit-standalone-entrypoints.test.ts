import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  PiAcpAgent,
  findPiChangelog,
  readPiVersion,
  startupInfoAgentDirs,
  type SessionManagerLike,
} from "../src/acp/agent.ts";
import { getAuthMethods } from "../src/acp/auth.ts";
import { getPiAcpDir, getPiAcpSessionMapPath } from "../src/acp/paths.ts";
import { PiAcpSession } from "../src/acp/session.ts";
import { isBoundaryArray, isBoundaryRecord, parseJsonLine } from "../src/boundary.ts";
import { defaultPiCommand, resolvePiLaunch } from "../src/pi-rpc/command.ts";
import type { PiRpcEvent, PiRpcProcessLike } from "../src/pi-rpc/process.ts";
import type {
  PiAvailableModels,
  PiPromptDisposition,
  PiPromptImage,
  PiState,
} from "../src/pi-rpc/protocol.ts";
import { parseZedTasks, runZedSetupCli } from "../src/zed/setup.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

/**
 * Standalone-mode entry points: the `choco-pi` launcher's env contract
 * (CHOCO_PI_STANDALONE=1, CHOCO_PI_HOME, CHOCO_PI_LAUNCHER, PI_ACP_PI_COMMAND,
 * PI_CODING_AGENT_DIR) moves ACP state under CHOCO_PI_HOME and routes every Pi start through
 * the launcher. Legacy mode (contract unset) keeps the previous values exactly.
 */

/** A scratch install: `<root>/home` is CHOCO_PI_HOME, `<root>/app/bin/choco-pi` the launcher. */
type StandaloneFixture = Readonly<{
  root: string;
  home: string;
  app: string;
  launcher: string;
  pathPi: string;
  calls: string;
}>;

async function standaloneFixture(): Promise<StandaloneFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "choco-pi-acp-standalone-")));
  const home = join(root, "home");
  const app = join(root, "app");
  const launcher = join(app, "bin", "choco-pi");
  const calls = join(root, "launcher-calls.txt");
  await mkdir(join(app, "bin"), { recursive: true });
  await writeFile(launcher, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\necho 1.5.2\n`);
  await chmod(launcher, 0o755);
  // A different `pi` on PATH that standalone mode must never pick.
  const pathBin = join(root, "path-bin");
  const pathPi = join(pathBin, "pi");
  await mkdir(pathBin);
  await writeFile(pathPi, "#!/bin/sh\necho 0.0.1\n");
  await chmod(pathPi, 0o755);
  return { root, home, app, launcher, pathPi, calls };
}

function contractEnv(fixture: StandaloneFixture): NodeJS.ProcessEnv {
  return {
    HOME: join(fixture.root, "user-home"),
    PATH: join(fixture.root, "path-bin"),
    CHOCO_PI_STANDALONE: "1",
    CHOCO_PI_HOME: fixture.home,
    CHOCO_PI_LAUNCHER: fixture.launcher,
    PI_ACP_PI_COMMAND: fixture.launcher,
    PI_CODING_AGENT_DIR: join(fixture.home, "agent"),
  };
}

test("standalone: the ACP session map lives under CHOCO_PI_HOME/pi-acp", async (t) => {
  const fixture = await standaloneFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const env = contractEnv(fixture);
  assert.equal(getPiAcpDir(env), join(fixture.home, "pi-acp"));
  assert.equal(getPiAcpSessionMapPath(env), join(fixture.home, "pi-acp", "session-map.json"));
});

test("legacy: the ACP session map stays at ~/.pi/pi-acp", () => {
  assert.equal(getPiAcpDir({}), join(homedir(), ".pi", "pi-acp"));
  assert.equal(getPiAcpSessionMapPath({}), join(homedir(), ".pi", "pi-acp", "session-map.json"));
  // CHOCO_PI_HOME alone (no launcher flag) is still legacy mode.
  assert.equal(getPiAcpDir({ CHOCO_PI_HOME: "/elsewhere" }), join(homedir(), ".pi", "pi-acp"));
});

test("standalone: startup-info prompt and extension dirs live under CHOCO_PI_HOME/agent", async (t) => {
  const fixture = await standaloneFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const expected = {
    prompts: join(fixture.home, "agent", "prompts"),
    extensions: join(fixture.home, "agent", "extensions"),
  };
  assert.deepEqual(startupInfoAgentDirs(contractEnv(fixture)), expected);
  // The standalone home decides even before the launcher exports PI_CODING_AGENT_DIR.
  const { PI_CODING_AGENT_DIR: _agentDir, ...withoutAgentDir } = contractEnv(fixture);
  assert.deepEqual(startupInfoAgentDirs(withoutAgentDir), expected);
});

test("legacy: startup-info prompt and extension dirs keep $HOME/.pi/agent", () => {
  assert.deepEqual(startupInfoAgentDirs({ HOME: "/Users/someone" }), {
    prompts: "/Users/someone/.pi/agent/prompts",
    extensions: "/Users/someone/.pi/agent/extensions",
  });
  // The previous code joined an unset HOME as "", giving a relative path.
  assert.deepEqual(startupInfoAgentDirs({}), {
    prompts: join(".pi", "agent", "prompts"),
    extensions: join(".pi", "agent", "extensions"),
  });
});

test("standalone: Pi launches through the launcher, never a PATH pi", async (t) => {
  const fixture = await standaloneFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const env = contractEnv(fixture);
  assert.equal(defaultPiCommand(env), fixture.launcher);
  assert.deepEqual(await resolvePiLaunch(env.PI_ACP_PI_COMMAND, env, "darwin"), {
    command: fixture.launcher,
    argsPrefix: [],
  });
  // Without PI_ACP_PI_COMMAND, CHOCO_PI_LAUNCHER is the default.
  const { PI_ACP_PI_COMMAND: _command, ...withoutCommand } = env;
  assert.deepEqual(await resolvePiLaunch(undefined, withoutCommand, "darwin"), {
    command: fixture.launcher,
    argsPrefix: [],
  });

  assert.equal(await readPiVersion(undefined, env), "1.5.2");
  assert.equal(await readFile(fixture.calls, "utf8"), "--version\n");
  assert.equal(
    await findPiChangelog(undefined, env),
    null,
    "no pinned Pi in the fixture app, and no npm fallback in standalone mode",
  );
  const pinnedPi = join(fixture.app, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(pinnedPi, { recursive: true });
  await writeFile(join(pinnedPi, "CHANGELOG.md"), "# Changelog\n");
  assert.equal(await findPiChangelog(undefined, env), join(pinnedPi, "CHANGELOG.md"));
});

test("legacy: Pi resolves to pi from PATH", async (t) => {
  const fixture = await standaloneFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const env = { PATH: join(fixture.root, "path-bin") };
  assert.equal(defaultPiCommand({}), "pi");
  assert.deepEqual(await resolvePiLaunch(undefined, env, "darwin"), {
    command: fixture.pathPi,
    argsPrefix: [],
  });
  // CHOCO_PI_LAUNCHER without the standalone flag does not change the default.
  assert.equal(defaultPiCommand({ CHOCO_PI_LAUNCHER: fixture.launcher }), "pi");
});

test("terminal auth re-enters the adapter through the launcher in standalone mode only", async (t) => {
  const fixture = await standaloneFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const standalone = getAuthMethods({ env: contractEnv(fixture) })[0]?._meta?.["terminal-auth"];
  assert.deepEqual(parseJsonLine(JSON.stringify(standalone) ?? ""), {
    command: fixture.launcher,
    args: ["self", "acp", "--terminal-login"],
    label: "Launch pi",
  });
  const legacy = getAuthMethods({ env: {} })[0]?._meta?.["terminal-auth"];
  const decoded = parseJsonLine(JSON.stringify(legacy) ?? "");
  assert.ok(isBoundaryRecord(decoded));
  assert.deepEqual(decoded.args, ["--terminal-login"]);
});

/** Run `zed setup --dry-run` in-process and return the printed lines. */
async function zedDryRun(
  environment: NodeJS.ProcessEnv,
  configDirectory: string,
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runZedSetupCli(["setup", "--dry-run", "--zed-config-dir", configDirectory], {
    adapterPath: "/app/packages/choco-pi-acp/bin/choco-pi-acp.ts",
    commandPath: "/runtime/node/bin/node",
    environment,
    output: (line) => lines.push(line),
  });
  return { code, lines };
}

function intended(lines: readonly string[], prefix: string): string {
  const index = lines.findIndex((line) => line.startsWith(prefix));
  const value = lines[index + 1];
  if (index < 0 || value === undefined) throw new Error(`missing ${prefix}`);
  return value;
}

const CONTEXT_CLI = "/app/packages/choco-pi-editor-context/src/cli.ts";

test("standalone: Zed setup dry run names the launcher with self acp", async (t) => {
  const fixture = await standaloneFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const { code, lines } = await zedDryRun(contractEnv(fixture), join(fixture.root, "zed"));
  assert.equal(code, 0, lines.join("\n"));
  assert.ok(lines.includes(`Command path: ${fixture.launcher}`));

  const settings = parseJsonLine(intended(lines, "Intended settings"));
  assert.ok(isBoundaryRecord(settings) && isBoundaryRecord(settings.agent_servers));
  assert.deepEqual(settings.agent_servers["choco-pi"], {
    type: "custom",
    command: fixture.launcher,
    args: ["self", "acp"],
    env: { PI_ACP_ENABLE_EMBEDDED_CONTEXT: "true" },
  });

  const tasks = parseZedTasks(intended(lines, "Intended tasks"));
  assert.equal(tasks.length, 6);
  for (const task of tasks) assert.equal(task.command, fixture.launcher, String(task.label));
  for (const task of tasks.slice(0, 5)) {
    assert.ok(isBoundaryArray(task.args));
    assert.deepEqual(task.args.slice(0, 4), [
      "self",
      "exec",
      "/runtime/node/bin/node",
      CONTEXT_CLI,
    ]);
  }
  assert.equal(tasks[5]?.label, "Choco Pi: Open Terminal Thread");
  assert.deepEqual(tasks[5]?.args, []);
});

test("standalone: the maintained Zed examples match setup output", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "choco-pi-acp-zed-example-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines: string[] = [];
  const code = await runZedSetupCli(["setup", "--dry-run", "--zed-config-dir", join(root, "zed")], {
    adapterPath: "/absolute/path/to/choco-pi-app/packages/choco-pi-acp/bin/choco-pi-acp.ts",
    commandPath: "/absolute/path/to/node",
    environment: {
      CHOCO_PI_STANDALONE: "1",
      CHOCO_PI_HOME: "/absolute/path/to/choco-pi-home",
      CHOCO_PI_LAUNCHER: "/absolute/path/to/choco-pi",
    },
    output: (line) => lines.push(line),
  });
  assert.equal(code, 0, lines.join("\n"));
  const example = (name: string) =>
    readFile(new URL(`../../../editors/zed/${name}`, import.meta.url), "utf8");
  assert.deepEqual(
    parseJsonLine(intended(lines, "Intended settings")),
    parseJsonLine(await example("settings.standalone.example.json")),
  );
  assert.deepEqual(
    parseZedTasks(intended(lines, "Intended tasks")),
    parseZedTasks(await example("tasks.standalone.example.json")),
  );
});

test("standalone: Zed setup refuses a contract without an absolute launcher", async (t) => {
  const fixture = await standaloneFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const { CHOCO_PI_LAUNCHER: _launcher, ...env } = contractEnv(fixture);
  const { code, lines } = await zedDryRun(env, join(fixture.root, "zed"));
  assert.equal(code, 1);
  assert.match(lines.at(-1) ?? "", /needs an absolute CHOCO_PI_LAUNCHER/);
});

test("legacy: Zed setup dry run keeps node + adapter and pi from PATH", async (t) => {
  const fixture = await standaloneFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const { code, lines } = await zedDryRun({}, join(fixture.root, "zed"));
  assert.equal(code, 0, lines.join("\n"));
  assert.ok(lines.includes("Command path: /runtime/node/bin/node"));
  const settings = parseJsonLine(intended(lines, "Intended settings"));
  assert.ok(isBoundaryRecord(settings) && isBoundaryRecord(settings.agent_servers));
  assert.deepEqual(settings.agent_servers["choco-pi"], {
    type: "custom",
    command: "/runtime/node/bin/node",
    args: ["/app/packages/choco-pi-acp/bin/choco-pi-acp.ts"],
    env: { PI_ACP_ENABLE_EMBEDDED_CONTEXT: "true" },
  });
  const tasks = parseZedTasks(intended(lines, "Intended tasks"));
  for (const task of tasks.slice(0, 5)) {
    assert.equal(task.command, "/runtime/node/bin/node");
    assert.ok(isBoundaryArray(task.args));
    assert.equal(task.args[0], CONTEXT_CLI);
  }
  assert.equal(tasks[5]?.command, "pi");
});

/** A session manager that always resolves to one prepared session. */
class SingleSessionManager implements SessionManagerLike {
  private readonly session: PiAcpSession;

  constructor(session: PiAcpSession) {
    this.session = session;
  }

  async create(): Promise<PiAcpSession> {
    return this.session;
  }

  maybeGet(): PiAcpSession {
    return this.session;
  }

  get(): PiAcpSession {
    return this.session;
  }

  getOrCreate(): PiAcpSession {
    return this.session;
  }

  close(): void {}

  disposeAll(): void {}

  async shutdownAll(): Promise<void> {}
}

/** A Pi process fake reporting one configured model. */
class SingleModelProcess implements PiRpcProcessLike {
  onEvent(_handler: (ev: PiRpcEvent) => void): () => void {
    return () => {};
  }

  async prompt(_message: string, _images: PiPromptImage[] = []): Promise<PiPromptDisposition> {
    return "started";
  }

  async getAvailableModels(): Promise<PiAvailableModels> {
    return { models: [{ provider: "test", id: "model", name: "model" }] };
  }

  async getState(): Promise<PiState> {
    return { thinkingLevel: "medium", model: { provider: "test", id: "model" } };
  }
}

test("standalone: session/new startup info comes from the launcher and CHOCO_PI_HOME/agent", async (t) => {
  const fixture = await standaloneFixture();
  const saved = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    await rm(fixture.root, { recursive: true, force: true });
  });
  const env = contractEnv(fixture);
  Object.assign(process.env, env);
  const agentDir = join(fixture.home, "agent");
  await mkdir(join(agentDir, "prompts"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "prompts", "sentinel-prompt.md"), "Say hi\n");
  await writeFile(join(agentDir, "extensions", "sentinel-ext.ts"), "export {};\n");
  const cwd = join(fixture.root, "project");
  await mkdir(cwd);

  const conn = new FakeAgentSideConnection();
  const session = new PiAcpSession({
    sessionId: "s1",
    cwd,
    mcpServers: [],
    proc: new SingleModelProcess(),
    conn: asAgentConn(conn),
  });
  const agent = new PiAcpAgent(asAgentConn(conn), {});
  const sessions: SessionManagerLike = new SingleSessionManager(session);
  // `sessions` is a private implementation detail; `Object.assign` installs the fake.
  Object.assign(agent, { sessions });

  const response = await agent.newSession({ cwd, mcpServers: [] });
  const startupInfo = String(response._meta.piAcp.startupInfo ?? "");
  assert.match(startupInfo, /^pi v1\.5\.2$/m);
  assert.match(startupInfo, /^- \/sentinel-prompt$/m);
  assert.ok(startupInfo.includes(join(agentDir, "extensions", "sentinel-ext.ts")), startupInfo);
  assert.doesNotMatch(startupInfo, /New version available|\.pi\/agent/);
  assert.equal(await readFile(fixture.calls, "utf8"), "--version\n");
  await agent.shutdown(0);
});
