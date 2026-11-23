import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { compile, map, obj, unknown } from "@earendil-works/pi-schema";

import { isJsonRecord, type JsonRecord } from "../profile/extensions/lib/runtime-values.ts";
import { FUZZY_FILE_MENTIONS_SETTING } from "../profile/extensions/prompt-editor.ts";
import {
  DEFAULT_PROFILE_MODEL_THINKING_LEVELS,
  installProfile,
} from "../scripts/install-profile.ts";
import {
  EXCLUDED_SETTINGS,
  IMPORTABLE_SETTINGS,
  importPiSettings,
  importRecordPath,
  importReport,
  readImportRecord,
} from "../scripts/standalone/settings-import.ts";
import {
  applySettingsSeed,
  readSettingsSeed,
  seedStatePath,
} from "../scripts/standalone/settings-seed.ts";

const runFile = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(ROOT, "bin", "choco-pi");
const NODE_DIR = path.dirname(process.execPath);
const FS_TRACE = path.join(ROOT, "tests", "helpers", "fs-trace.ts");
const rootSkip = process.getuid?.() === 0 ? "root ignores directory permissions" : null;

async function scratch(t: test.TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "choco-pi-import-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readJson(file: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  assert.ok(isJsonRecord(parsed), `${file} holds a JSON object`);
  return parsed;
}

async function writeJson(file: string, value: JsonRecord): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const INSTALLED = {
  packages: ["/app/packages/choco-pi-ui"],
  skills: ["/app/profile/skills"],
  modelThinkingLevels: { ...DEFAULT_PROFILE_MODEL_THINKING_LEVELS },
};

async function seededAgent(directory: string): Promise<string> {
  const agentDir = path.join(directory, "agent");
  await writeJson(path.join(agentDir, "settings.json"), INSTALLED);
  await applySettingsSeed(agentDir, await readSettingsSeed());
  return agentDir;
}

async function piSettings(directory: string, settings: JsonRecord): Promise<string> {
  const file = path.join(directory, "pi-home", ".pi", "agent", "settings.json");
  await writeJson(file, settings);
  return file;
}

async function whileReadOnly<Result>(directory: string, body: () => Promise<Result>) {
  await chmod(directory, 0o500);
  try {
    return await body();
  } finally {
    await chmod(directory, 0o700);
  }
}

const isPiSchemaModule = compile(
  obj({ SettingsSchema: obj({ properties: map(unknown()) }, { open: true }) }, { open: true }),
).check;

test("the import allowlist covers every Pi 1.6.0 setting and adds only choco-pi preference readers", async () => {
  const piModule: unknown = await import(
    pathToFileURL(
      path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/core/settings-schema.js"),
    ).href
  );
  assert.ok(isPiSchemaModule(piModule), "Pi 1.6.0 exports SettingsSchema");
  const piKeys = Object.keys(piModule.SettingsSchema.properties);
  const importable = new Set(Object.keys(IMPORTABLE_SETTINGS));
  const excluded = new Set(Object.keys(EXCLUDED_SETTINGS));
  for (const key of piKeys)
    assert.ok(
      importable.has(key) !== excluded.has(key),
      `Pi setting ${key} is classified exactly once`,
    );
  for (const key of [
    "packages",
    "extensions",
    "skills",
    "prompts",
    "themes",
    "hooks",
    "deviceId",
    "trackingId",
    "lastChangelogVersion",
    "extensionChangelogVersions",
    "defaultProjectTrust",
    "scratchGrants",
    "sessionDir",
    "shellPath",
    "externalEditor",
    "shellCommandPrefix",
    "npmCommand",
    "selfUpdateCommand",
    "httpProxy",
  ])
    assert.ok(excluded.has(key) && !importable.has(key), `${key} is excluded`);
  for (const key of importable)
    assert.doesNotMatch(
      key,
      /trust|path|dir$|command$|prefix$|editor$|proxy|device|tracking|secret|password|credential|auth|cookie|grant|hook/i,
      `${key} names no path, identity, trust, command or credential`,
    );
  const chocoPiKeys = [...importable].filter((key) => !piKeys.includes(key)).toSorted();
  assert.deepEqual(chocoPiKeys, [
    "agentLanguage",
    "agentOnUsageLimit",
    "agentPersona",
    "agentStyle",
    "autoCompactionPoint",
    "compactionAnthropic",
    "compactionOpaqueHistory",
    "compactionXai",
    "contextSoftCap",
    "daybreakDefault",
    "diffPaneDefault",
    FUZZY_FILE_MENTIONS_SETTING,
    "promptSuggestion",
    "sessionAutoName",
    "sessionAutoNameModel",
  ]);
});

test("excluded and unknown keys are never imported, and the report names keys only", async (t) => {
  const directory = await scratch(t);
  const agentDir = await seededAgent(directory);
  const before = await readJson(path.join(agentDir, "settings.json"));
  const poison = {
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "touch /tmp/POISON" }] }] },
    packages: ["/legacy/checkout/packages/choco-pi-ui"],
    extensions: ["/legacy/checkout/profile/extensions"],
    skills: ["/legacy/checkout/profile/skills"],
    prompts: ["/legacy/checkout/profile/prompts"],
    deviceId: "POISON-DEVICE",
    trackingId: "POISON-TRACKING",
    defaultProjectTrust: "always",
    scratchGrants: ["/"],
    lastChangelogVersion: "9.9.9",
    extensionChangelogVersions: { x: "1" },
    httpProxy: "http://user:POISON@proxy.invalid",
    shellCommandPrefix: "POISON",
    someFutureKey: "POISON-FUTURE",
  };
  const result = await importPiSettings(agentDir, await piSettings(directory, poison));
  assert.deepEqual(result.imported, []);
  assert.deepEqual(
    result.skipped.map(({ key }) => key),
    Object.keys(poison),
  );
  assert.equal(
    result.skipped.find(({ key }) => key === "someFutureKey")?.reason,
    "not an importable preference",
  );
  assert.deepEqual(await readJson(path.join(agentDir, "settings.json")), before);
  const report = importReport(result).join("\n");
  assert.doesNotMatch(report, /POISON|always|9\.9\.9|legacy/, "no value is printed");
  assert.match(report, /^skipped: hooks \(personal commands/m);
});

test("values their reader rejects, or that look like credentials, are skipped", async (t) => {
  const directory = await scratch(t);
  const agentDir = path.join(directory, "agent");
  await writeJson(path.join(agentDir, "settings.json"), {});
  const result = await importPiSettings(
    agentDir,
    await piSettings(directory, {
      theme: 5,
      transport: "carrier-pigeon",
      agentPersona: "cheerful",
      compaction: { enabled: "yes" },
      terminal: { showImages: true, unknownTerminalKey: true },
      modelThinkingLevels: { "openai/gpt-6-sol": "huge" },
      defaultModel: "sk-proj-0123456789abcdef",
      agentLanguage: "ghp_0123456789abcdefghij0123456789abcdef",
      steeringMode: "all",
    }),
  );
  assert.deepEqual(result.imported, ["steeringMode"]);
  const reasons = new Map(result.skipped.map(({ key, reason }) => [key, reason]));
  for (const key of [
    "theme",
    "transport",
    "agentPersona",
    "compaction",
    "terminal",
    "modelThinkingLevels",
  ])
    assert.equal(reasons.get(key), "the value is not valid for its reader", key);
  assert.equal(reasons.get("defaultModel"), "the value looks like a credential");
  assert.equal(reasons.get("agentLanguage"), "the value looks like a credential");
  assert.deepEqual(await readJson(path.join(agentDir, "settings.json")), { steeringMode: "all" });
});

test("a key is imported when absent or still the seeded value; a value changed in choco-pi wins", async (t) => {
  const directory = await scratch(t);
  const agentDir = await seededAgent(directory);
  const settingsPath = path.join(agentDir, "settings.json");
  await writeJson(settingsPath, {
    ...(await readJson(settingsPath)),
    cacheWarming: "off",
    agentStyle: "concise",
  });
  const result = await importPiSettings(
    agentDir,
    await piSettings(directory, {
      theme: "dracula",
      cacheWarming: "idle",
      agentStyle: "detailed",
      agentLanguage: "Korean",
      quietStartup: "header",
      terminal: { showTerminalProgress: false, showImages: false },
    }),
  );
  assert.deepEqual(result.imported, ["theme", "agentLanguage", "terminal"]);
  assert.deepEqual(result.kept, ["cacheWarming", "agentStyle"]);
  const settings = await readJson(settingsPath);
  assert.equal(settings.theme, "dracula", "the seeded value is replaced");
  assert.deepEqual(settings.terminal, { showTerminalProgress: false, showImages: false });
  assert.equal(settings.agentLanguage, "Korean", "an absent key is added");
  assert.equal(settings.cacheWarming, "off", "the user's change wins");
  assert.equal(settings.agentStyle, "concise", "the user's own key wins");
  assert.equal(settings.quietStartup, "header");
  assert.match(importReport(result).join("\n"), /^kept: cacheWarming \(/m);
});

test("modelThinkingLevels merges per model over profile defaults only", async (t) => {
  const directory = await scratch(t);
  const agentDir = await seededAgent(directory);
  const settingsPath = path.join(agentDir, "settings.json");
  const levels = {
    ...DEFAULT_PROFILE_MODEL_THINKING_LEVELS,
    "anthropic/claude-opus-5": "max",
    "custom/model": "low",
  };
  await writeJson(settingsPath, { ...(await readJson(settingsPath)), modelThinkingLevels: levels });
  assert.equal(DEFAULT_PROFILE_MODEL_THINKING_LEVELS["openai/gpt-6-sol"], "low");
  const result = await importPiSettings(
    agentDir,
    await piSettings(directory, {
      modelThinkingLevels: {
        "anthropic/claude-opus-5": "high",
        "openai/gpt-6-sol": "high",
        "custom/model": "xhigh",
        "new/model": "medium",
        "openai/gpt-6-luna": DEFAULT_PROFILE_MODEL_THINKING_LEVELS["openai/gpt-6-luna"],
      },
    }),
  );
  assert.deepEqual(result.imported, ["modelThinkingLevels"]);
  assert.deepEqual(result.imported_model_thinking_levels, ["openai/gpt-6-sol", "new/model"]);
  assert.deepEqual(result.kept, [
    'modelThinkingLevels["anthropic/claude-opus-5"]',
    'modelThinkingLevels["custom/model"]',
  ]);
  assert.deepEqual((await readJson(settingsPath)).modelThinkingLevels, {
    ...levels,
    "openai/gpt-6-sol": "high",
    "new/model": "medium",
  });
});

test("a second import refuses without --force, and --force never replaces or re-adds an imported key", async (t) => {
  const directory = await scratch(t);
  const agentDir = await seededAgent(directory);
  const settingsPath = path.join(agentDir, "settings.json");
  const source = await piSettings(directory, { theme: "dracula", agentLanguage: "Korean" });
  const first = await importPiSettings(agentDir, source, { now: new Date("2026-01-02T03:04:05Z") });
  assert.deepEqual(first.imported, ["theme", "agentLanguage"]);
  assert.deepEqual(await readImportRecord(agentDir), {
    schema: 1,
    source,
    imported_at: "2026-01-02T03:04:05.000Z",
    imported: ["theme", "agentLanguage"],
    imported_model_thinking_levels: [],
    skipped: [],
    kept: [],
  });
  await assert.rejects(importPiSettings(agentDir, source), /already imported; rerun with --force/);

  const { agentLanguage: _deleted, ...rest } = await readJson(settingsPath);
  await writeJson(settingsPath, { ...rest, theme: "solarized" });
  await writeJson(source, { theme: "gruvbox", agentLanguage: "Japanese", steeringMode: "all" });
  const forced = await importPiSettings(agentDir, source, { force: true });
  assert.deepEqual(forced.imported, ["steeringMode"]);
  assert.deepEqual(forced.kept, ["theme", "agentLanguage"]);
  const settings = await readJson(settingsPath);
  assert.equal(settings.theme, "solarized", "a changed imported value is kept");
  assert.equal(Object.hasOwn(settings, "agentLanguage"), false, "a deleted one is not re-added");
  assert.equal(settings.steeringMode, "all");
  assert.deepEqual((await readImportRecord(agentDir))?.imported, [
    "theme",
    "agentLanguage",
    "steeringMode",
  ]);
});

test("the import record is written before settings.json: a failed settings write imports nothing, at most once", async (t) => {
  if (rootSkip !== null) {
    t.skip(rootSkip);
    return;
  }
  const directory = await scratch(t);
  const agentDir = await seededAgent(directory);
  const settingsPath = path.join(agentDir, "settings.json");
  const before = await readFile(settingsPath, "utf8");
  const source = await piSettings(directory, { theme: "dracula" });
  await whileReadOnly(agentDir, () => assert.rejects(importPiSettings(agentDir, source), /EACCES/));
  assert.equal(await readFile(settingsPath, "utf8"), before, "settings.json is unchanged");
  assert.deepEqual((await readImportRecord(agentDir))?.imported, ["theme"]);
  await assert.rejects(importPiSettings(agentDir, source), /already imported/);
  const forced = await importPiSettings(agentDir, source, { force: true });
  assert.deepEqual(forced.imported, []);
  assert.equal((await readJson(settingsPath)).theme, "nord-dark");
});

test("a failed record write leaves settings.json unchanged and the import can run again", async (t) => {
  if (rootSkip !== null) {
    t.skip(rootSkip);
    return;
  }
  const directory = await scratch(t);
  const agentDir = await seededAgent(directory);
  const settingsPath = path.join(agentDir, "settings.json");
  const before = await readFile(settingsPath, "utf8");
  const source = await piSettings(directory, { theme: "dracula" });
  await whileReadOnly(path.dirname(importRecordPath(agentDir)), () =>
    assert.rejects(importPiSettings(agentDir, source), /EACCES/),
  );
  assert.equal(await readFile(settingsPath, "utf8"), before);
  assert.equal(await readImportRecord(agentDir), null);
  assert.deepEqual((await importPiSettings(agentDir, source)).imported, ["theme"]);
});

test("the seed never overwrites a key the import set", async (t) => {
  const directory = await scratch(t);
  const agentDir = path.join(directory, "agent");
  await writeJson(path.join(agentDir, "settings.json"), INSTALLED);
  const source = await piSettings(directory, { theme: "dracula", cacheWarming: "idle" });
  assert.deepEqual((await importPiSettings(agentDir, source)).imported, ["theme", "cacheWarming"]);
  const seed = await applySettingsSeed(agentDir, await readSettingsSeed());
  assert.ok(!seed.added.includes("theme") && !seed.added.includes("cacheWarming"));
  const settings = await readJson(path.join(agentDir, "settings.json"));
  assert.equal(settings.theme, "dracula");
  assert.equal(settings.cacheWarming, "idle");
});

async function poisonedHome(directory: string) {
  const home = path.join(directory, "user");
  const piAgent = path.join(home, ".pi", "agent");
  await writeJson(path.join(piAgent, "settings.json"), {
    theme: "dracula",
    agentLanguage: "Korean",
    hooks: { SessionStart: [] },
    packages: ["/legacy/packages/choco-pi-ui"],
    deviceId: "POISON",
    transport: "carrier-pigeon",
  });
  const poisoned = [
    path.join(piAgent, "auth.json"),
    path.join(piAgent, "trust.json"),
    path.join(piAgent, "mcp.json"),
    path.join(piAgent, "sessions", "poison.jsonl"),
  ];
  for (const file of poisoned) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "POISON: never read this\n");
  }
  const snapshot = async () =>
    Promise.all(
      poisoned.map(async (file) => {
        const info = await stat(file);
        return [file, await readFile(file, "utf8"), info.mtimeMs, info.size];
      }),
    );
  return { home, piAgent, poisoned, snapshot };
}

async function tracedSetup(directory: string, home: string, args: readonly string[]) {
  const log = path.join(directory, `trace-${args.length}-${Date.now()}.log`);
  const result = await runFile(LAUNCHER, ["self", "setup", ...args], {
    cwd: directory,
    timeout: 120_000,
    env: {
      HOME: home,
      CHOCO_PI_HOME: path.join(home, ".choco-pi"),
      TMPDIR: directory,
      PATH: `${NODE_DIR}:/usr/bin:/bin`,
      PI_OFFLINE: "1",
      NODE_OPTIONS: `--import=${pathToFileURL(FS_TRACE).href}`,
      FS_TRACE_ROOT: home,
      FS_TRACE_LOG: log,
    },
  });
  const lines = (await readFile(log, "utf8")).split("\n").filter((line) => line !== "");
  const piRoot = path.join(home, ".pi");
  const underPi = lines.filter((line) => {
    const file = line.slice(line.indexOf(" ") + 1);
    return file === piRoot || file.startsWith(`${piRoot}/`);
  });
  return { stdout: result.stdout, lines, underPi };
}

test("default setup reads nothing under ~/.pi; --import-pi-settings reads only ~/.pi/agent/settings.json", async (t) => {
  const directory = await scratch(t);
  const { home, piAgent, snapshot } = await poisonedHome(directory);
  const before = await snapshot();
  const agentSettings = path.join(home, ".choco-pi", "agent", "settings.json");

  const plain = await tracedSetup(directory, home, []);
  assert.ok(
    plain.lines.some((line) => line.endsWith(agentSettings)),
    "the trace sees choco-pi's own settings (the hook ran)",
  );
  assert.deepEqual(plain.underPi, [], "default setup touches nothing under ~/.pi");
  assert.doesNotMatch(plain.stdout, /imported/);
  assert.match(plain.stdout, /--import-pi-settings/, "the next steps mention the optional import");

  const imported = await tracedSetup(directory, home, ["--import-pi-settings"]);
  assert.deepEqual(imported.underPi, [`promises.readFile ${path.join(piAgent, "settings.json")}`]);
  assert.match(imported.stdout, /^imported: theme, agentLanguage$/m);
  assert.match(imported.stdout, /^skipped: hooks \(/m);
  assert.match(imported.stdout, /^skipped: transport \(the value is not valid for its reader\)$/m);
  assert.doesNotMatch(imported.stdout, /POISON|dracula|Korean|carrier/);
  const settings = await readJson(agentSettings);
  assert.equal(settings.theme, "dracula");
  assert.ok(!Object.hasOwn(settings, "deviceId") && !Object.hasOwn(settings, "hooks"));

  await assert.rejects(
    tracedSetup(directory, home, ["--import-pi-settings"]),
    /already imported on .*rerun with --force/,
  );
  const elsewhere = path.join(directory, "elsewhere.json");
  await writeJson(elsewhere, { steeringMode: "all" });
  const fromFile = await tracedSetup(directory, home, [
    "--import-pi-settings",
    "--from",
    elsewhere,
    "--force",
  ]);
  assert.deepEqual(fromFile.underPi, []);
  assert.match(fromFile.stdout, /^imported: steeringMode$/m);

  assert.deepEqual(await snapshot(), before, "poisoned files keep their content and mtime");
  assert.deepEqual(
    (await readdir(path.join(home, ".pi"), { recursive: true })).toSorted(),
    [
      "agent",
      "agent/auth.json",
      "agent/mcp.json",
      "agent/sessions",
      "agent/sessions/poison.jsonl",
      "agent/settings.json",
      "agent/trust.json",
    ],
    "nothing was created under ~/.pi",
  );
});

test("--from and --force need --import-pi-settings", async (t) => {
  const directory = await scratch(t);
  const home = path.join(directory, "user");
  await mkdir(home);
  const run = runFile(LAUNCHER, ["self", "setup", "--force"], {
    env: {
      HOME: home,
      CHOCO_PI_HOME: path.join(home, ".choco-pi"),
      TMPDIR: directory,
      PATH: `${NODE_DIR}:/usr/bin:/bin`,
    },
  });
  await assert.rejects(run, /apply only with --import-pi-settings/);
  await assert.rejects(stat(path.join(home, ".choco-pi", "agent")), { code: "ENOENT" });
});

test("the legacy profile install writes no import or seed state", async (t) => {
  const directory = await scratch(t);
  const agentDir = path.join(directory, "legacy");
  await installProfile({ root: ROOT, agentDir, piLauncher: LAUNCHER });
  await assert.rejects(readFile(importRecordPath(agentDir)), { code: "ENOENT" });
  await assert.rejects(readFile(seedStatePath(agentDir)), { code: "ENOENT" });
  const settings = await readJson(path.join(agentDir, "settings.json"));
  assert.deepEqual(Object.keys(settings).toSorted(), [
    "enabledModels",
    "extensions",
    "modelThinkingLevels",
    "packages",
    "prompts",
    "skills",
  ]);
});
