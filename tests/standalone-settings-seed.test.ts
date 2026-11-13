import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { compile, obj, str } from "@earendil-works/pi-schema";

import { isJsonRecord, type JsonRecord } from "../profile/extensions/lib/runtime-values.ts";
import { fuzzyFileMentionsEnabled } from "../profile/extensions/prompt-editor.ts";
import { DEFAULT_PROFILE_ENABLED_MODELS, installProfile } from "../scripts/install-profile.ts";
import {
  applySettingsSeed,
  parseSettingsSeed,
  readSettingsSeed,
  seedStatePath,
  type SettingsSeed,
} from "../scripts/standalone/settings-seed.ts";

const runFile = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(ROOT, "bin", "choco-pi");
const NODE_DIR = path.dirname(process.execPath);
const isTheme = compile(obj({ name: str() }, { open: true })).check;

async function scratch(t: test.TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "choco-pi-seed-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readJson(file: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  assert.ok(isJsonRecord(parsed), `${file} holds a JSON object`);
  return parsed;
}

/** An agent directory whose settings.json holds what the installer wrote. */
async function agentDirectory(directory: string, settings: JsonRecord) {
  const agentDir = path.join(directory, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  return agentDir;
}

const INSTALLED = { packages: ["/app/packages/choco-pi-ui"], skills: ["/app/profile/skills"] };

/**
 * Stops the computer-use bridge a Pi start under `home` launched. macOS
 * starts it through `open`, outside this process tree, so it outlives Pi.
 */
async function stopBridges(home: string): Promise<string> {
  const pattern = `${home}/Applications/pi-computer-use.app/Contents/MacOS/bridge serve`;
  const running = async () =>
    runFile("pgrep", ["-f", pattern]).then(
      ({ stdout }) => stdout.trim(),
      () => "",
    );
  // The bridge may still be starting when Pi exits.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await runFile("pkill", ["-f", pattern]).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 500));
  return running();
}

test("the shipped seed validates, and every seeded value is accepted by its reader and differs from its default", async (t) => {
  const seed = await readSettingsSeed();
  const values = Object.fromEntries(
    Object.entries(seed.settings).map(([key, entry]) => [key, entry?.value]),
  );
  assert.deepEqual(Object.keys(values).toSorted(), [
    "cacheWarming",
    "enableInstallTelemetry",
    "fullscreenExitOutput",
    "fuzzyFileMentions",
    "quietStartup",
    "terminal",
    "theme",
  ]);
  const text = await readFile(
    path.join(ROOT, "profile", "standalone", "settings.seed.json"),
    "utf8",
  );
  const shipped: unknown = JSON.parse(text);
  assert.ok(isJsonRecord(shipped));
  const withSettings = (settings: JsonRecord) => JSON.stringify({ ...shipped, settings });
  for (const [label, settings] of [
    ["unknown key", { ...seed.settings, defaultModel: { since: 1, value: "x" } }],
    ["invalid value", { ...seed.settings, cacheWarming: { since: 1, value: "always" } }],
    ["since after version", { ...seed.settings, theme: { since: 2, value: "nord" } }],
  ] as const) {
    assert.throws(
      () => parseSettingsSeed(withSettings(settings), label),
      /settings seed|invalid/,
      label,
    );
  }

  const directory = await scratch(t);
  const agentDir = await agentDirectory(directory, values);
  const manager = SettingsManager.create(directory, agentDir);
  assert.deepEqual(manager.drainErrors(), [], "Pi loads the seeded settings without errors");
  const pristine = SettingsManager.inMemory();
  const readers = [
    ["theme", (m: SettingsManager) => m.getTheme(), "nord-dark"],
    ["fullscreenExitOutput", (m: SettingsManager) => m.getFullscreenExitOutput(), "resume-hint"],
    ["cacheWarming", (m: SettingsManager) => m.getCacheWarmingMode(), "streaming"],
    ["quietStartup", (m: SettingsManager) => m.getQuietStartup(), true],
    ["enableInstallTelemetry", (m: SettingsManager) => m.getEnableInstallTelemetry(), false],
    ["terminal", (m: SettingsManager) => m.getShowTerminalProgress(), true],
  ] as const;
  for (const [key, read, expected] of readers) {
    assert.equal(read(manager), expected, `Pi reads ${key}`);
    assert.notEqual(read(pristine), expected, `${key} is not Pi's default`);
  }
  assert.equal(fuzzyFileMentionsEnabled(agentDir), true, "choco-pi reads fuzzyFileMentions");
  assert.equal(fuzzyFileMentionsEnabled(path.join(directory, "empty")), false);
  const theme: unknown = JSON.parse(
    await readFile(
      path.join(ROOT, "packages", "choco-pi-ui", "themes", `${values.theme}.json`),
      "utf8",
    ),
  );
  assert.ok(isTheme(theme) && theme.name === values.theme, "a bundled theme provides it");
});

test("a fresh standalone agent directory gets exactly the seed keys, once", async (t) => {
  const seed = await readSettingsSeed();
  const agentDir = await agentDirectory(await scratch(t), INSTALLED);
  const first = await applySettingsSeed(agentDir, seed);
  assert.equal(first.firstSeed, true);
  assert.deepEqual(first.added, Object.keys(seed.settings));
  const settings = await readJson(path.join(agentDir, "settings.json"));
  assert.deepEqual(settings, {
    ...INSTALLED,
    ...Object.fromEntries(Object.entries(seed.settings).map(([key, entry]) => [key, entry?.value])),
  });
  assert.deepEqual(await readJson(seedStatePath(agentDir)), {
    schema: 1,
    version: seed.version,
    seeded: Object.keys(seed.settings),
    values: Object.fromEntries(
      Object.entries(seed.settings).map(([key, entry]) => [key, entry?.value]),
    ),
  });
  const before = await readFile(path.join(agentDir, "settings.json"), "utf8");
  const second = await applySettingsSeed(agentDir, seed);
  assert.deepEqual(second, { added: [], firstSeed: false, statePath: seedStatePath(agentDir) });
  assert.equal(await readFile(path.join(agentDir, "settings.json"), "utf8"), before);
});

test("a value the user set is never overwritten", async (t) => {
  const seed = await readSettingsSeed();
  const agentDir = await agentDirectory(await scratch(t), {
    ...INSTALLED,
    theme: "nord-light",
    quietStartup: false,
  });
  const result = await applySettingsSeed(agentDir, seed);
  assert.ok(!result.added.includes("theme") && !result.added.includes("quietStartup"));
  const settings = await readJson(path.join(agentDir, "settings.json"));
  assert.equal(settings.theme, "nord-light");
  assert.equal(settings.quietStartup, false);
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ ...settings, theme: undefined }),
  );
  assert.deepEqual(
    (await applySettingsSeed(agentDir, seed)).added,
    [],
    "a key the user had is never seeded later",
  );
});

test("a key the user deleted is not added again", async (t) => {
  const seed = await readSettingsSeed();
  const agentDir = await agentDirectory(await scratch(t), INSTALLED);
  await applySettingsSeed(agentDir, seed);
  const settingsPath = path.join(agentDir, "settings.json");
  const { theme, ...withoutTheme } = await readJson(settingsPath);
  assert.equal(theme, "nord-dark");
  await writeFile(settingsPath, `${JSON.stringify(withoutTheme, null, 2)}\n`);
  const again = await applySettingsSeed(agentDir, seed);
  assert.deepEqual(again.added, []);
  assert.equal(Object.hasOwn(await readJson(settingsPath), "theme"), false);
});

test("a newer seed version adds only the keys new in that version", async (t) => {
  const agentDir = await agentDirectory(await scratch(t), INSTALLED);
  const v1: SettingsSeed = {
    version: 1,
    settings: { theme: { since: 1, value: "nord-dark" } },
  };
  assert.deepEqual((await applySettingsSeed(agentDir, v1)).added, ["theme"]);
  const settingsPath = path.join(agentDir, "settings.json");
  const { theme: _deleted, ...rest } = await readJson(settingsPath);
  await writeFile(settingsPath, JSON.stringify(rest));
  const v2: SettingsSeed = {
    version: 2,
    settings: {
      theme: { since: 1, value: "nord-dark" },
      // Listed as version 1 although v1 lacked it: version 1 was already applied.
      quietStartup: { since: 1, value: true },
      cacheWarming: { since: 2, value: "streaming" },
    },
  };
  assert.deepEqual((await applySettingsSeed(agentDir, v2)).added, ["cacheWarming"]);
  const settings = await readJson(settingsPath);
  assert.equal(Object.hasOwn(settings, "theme"), false, "the deleted key stays deleted");
  assert.equal(Object.hasOwn(settings, "quietStartup"), false);
  assert.deepEqual(await readJson(seedStatePath(agentDir)), {
    schema: 1,
    version: 2,
    seeded: ["theme", "cacheWarming"],
    values: { theme: "nord-dark", cacheWarming: "streaming" },
  });
  assert.deepEqual((await applySettingsSeed(agentDir, v1)).added, [], "an older seed adds nothing");
  assert.equal((await readJson(seedStatePath(agentDir))).version, 2);
});

/** Runs `body` with `directory` made read-only, restoring its mode afterwards. */
async function whileReadOnly<Result>(directory: string, body: () => Promise<Result>) {
  await chmod(directory, 0o500);
  try {
    return await body();
  } finally {
    await chmod(directory, 0o700);
  }
}

const rootSkip = process.getuid?.() === 0 ? "root ignores directory permissions" : null;

test("a failed seed state write leaves settings.json unchanged, so a deleted key never returns", async (t) => {
  if (rootSkip !== null) {
    t.skip(rootSkip);
    return;
  }
  const seed = await readSettingsSeed();
  const agentDir = await agentDirectory(await scratch(t), INSTALLED);
  const settingsPath = path.join(agentDir, "settings.json");
  const before = await readFile(settingsPath, "utf8");
  const stateDirectory = path.dirname(seedStatePath(agentDir));
  await mkdir(stateDirectory);
  await whileReadOnly(stateDirectory, () =>
    assert.rejects(applySettingsSeed(agentDir, seed), /EACCES/),
  );
  assert.equal(await readFile(settingsPath, "utf8"), before, "nothing was seeded");

  // Permissions restored: the retry is the first real seed, and the only one.
  assert.deepEqual((await applySettingsSeed(agentDir, seed)).added, Object.keys(seed.settings));
  const { theme: _deleted, ...withoutTheme } = await readJson(settingsPath);
  await writeFile(settingsPath, `${JSON.stringify(withoutTheme, null, 2)}\n`);
  assert.deepEqual((await applySettingsSeed(agentDir, seed)).added, []);
  assert.equal(Object.hasOwn(await readJson(settingsPath), "theme"), false, "not added again");
});

test("a failed settings write after the state was saved is not retried: under-seeding is intended", async (t) => {
  if (rootSkip !== null) {
    t.skip(rootSkip);
    return;
  }
  const seed = await readSettingsSeed();
  const agentDir = await agentDirectory(await scratch(t), INSTALLED);
  const settingsPath = path.join(agentDir, "settings.json");
  const before = await readFile(settingsPath, "utf8");
  await mkdir(path.dirname(seedStatePath(agentDir)));
  // The state directory stays writable; settings.json's temporary file cannot be created.
  await whileReadOnly(agentDir, () => assert.rejects(applySettingsSeed(agentDir, seed), /EACCES/));
  assert.equal(await readFile(settingsPath, "utf8"), before);
  assert.deepEqual(await readJson(seedStatePath(agentDir)), {
    schema: 1,
    version: seed.version,
    seeded: Object.keys(seed.settings),
    values: Object.fromEntries(
      Object.entries(seed.settings).map(([key, entry]) => [key, entry?.value]),
    ),
  });
  // At most once: the keys were offered, so a retry leaves them unseeded.
  assert.deepEqual(await applySettingsSeed(agentDir, seed), {
    added: [],
    firstSeed: false,
    statePath: seedStatePath(agentDir),
  });
  assert.equal(await readFile(settingsPath, "utf8"), before);
});

test("the legacy profile install keeps the default model scope and seeds nothing; standalone omits the scope", async (t) => {
  const directory = await scratch(t);
  const legacy = path.join(directory, "legacy");
  await installProfile({ root: ROOT, agentDir: legacy, piLauncher: LAUNCHER });
  const legacySettings = await readJson(path.join(legacy, "settings.json"));
  assert.deepEqual(legacySettings.enabledModels, [...DEFAULT_PROFILE_ENABLED_MODELS]);
  for (const key of Object.keys((await readSettingsSeed()).settings)) {
    assert.equal(Object.hasOwn(legacySettings, key), false, `legacy never seeds ${key}`);
  }
  await assert.rejects(readFile(seedStatePath(legacy)), { code: "ENOENT" });

  const standalone = path.join(directory, "standalone");
  await installProfile({
    root: ROOT,
    agentDir: standalone,
    piLauncher: LAUNCHER,
    defaultEnabledModels: [],
  });
  const standaloneSettings = await readJson(path.join(standalone, "settings.json"));
  assert.equal(Object.hasOwn(standaloneSettings, "enabledModels"), false);
  const { enabledModels: _scope, ...legacyRest } = legacySettings;
  assert.deepEqual(standaloneSettings, legacyRest, "the scope is the only difference");
});

test("a fresh standalone setup prints next steps once and starts in RPC mode without warnings", async (t) => {
  const directory = await scratch(t);
  const home = path.join(directory, "home");
  const project = path.join(directory, "project");
  await mkdir(project, { recursive: true });
  // No credentials and nothing inherited: a first start on a clean machine.
  const environment = {
    HOME: path.join(directory, "user"),
    CHOCO_PI_HOME: home,
    TMPDIR: directory,
    PATH: `${NODE_DIR}:/usr/bin:/bin`,
    PI_OFFLINE: "1",
  };
  t.after(() => stopBridges(environment.HOME));
  const setup = () =>
    runFile(LAUNCHER, ["self", "setup"], { cwd: project, env: environment, timeout: 60_000 });
  const first = await setup();
  assert.match(first.stdout, /^seeded: theme, /m);
  assert.match(first.stdout, /^ {2}\/login .*only in .*home\/agent\/auth\.json\)$/m);
  assert.match(first.stdout, /^ {2}\/preferences /m);
  const settingsPath = path.join(home, "agent", "settings.json");
  const settings = await readFile(settingsPath, "utf8");
  const second = await setup();
  assert.doesNotMatch(second.stdout, /seeded:|Next steps/);
  assert.equal(await readFile(settingsPath, "utf8"), settings, "a second setup adds nothing");

  const child = spawn(LAUNCHER, ["--mode", "rpc"], {
    cwd: project,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(`${JSON.stringify({ type: "get_state", id: "ready" })}\n`);
  for await (const line of lines) {
    if (line.includes('"ready"')) break;
  }
  child.stdin.end();
  if (child.exitCode === null) await once(child, "exit");
  assert.equal(await stopBridges(environment.HOME), "", "no bridge left running");
  assert.doesNotMatch(stderr, /No models match pattern/);
  assert.doesNotMatch(stderr, /warning/i, `stderr of a fresh start:\n${stderr}`);
});
