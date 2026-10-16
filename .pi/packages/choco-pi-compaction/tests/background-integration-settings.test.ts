/**
 * Background-compaction settings sidecar: lookup precedence and trust,
 * rejection with a visible diagnostic, the backend switch mapping, and the
 * Codex account scope. Defaults, partial overrides and malformed JSON are
 * exercised end to end by the background-integration host and off tests.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import { codexBackgroundAccountScope } from "../../choco-pi-codex/src/adapter/compaction/background-v2.ts";
import { ANTHROPIC_BACKEND_ID } from "../src/anthropic/backend.ts";
import { DEFAULT_BACKGROUND_COMPACTION_SETTINGS } from "../src/background/contract.ts";
import {
  ANTHROPIC_BACKEND_SETTING_ID,
  backgroundCompactionActive,
  backgroundSettingsPaths,
  CODEX_BACKEND_SETTING_ID,
  deriveBackgroundLanes,
  globalBackgroundSettingsPath,
  isBackendEnabled,
  loadBackgroundSettings,
  SidecarRefusedError,
  TEXT_BACKEND_SETTING_ID,
  writeGlobalBackgroundEnabled,
  writeGlobalBackgroundSettings,
  withDerivedDefaultLanes,
} from "../src/background/settings.ts";
import { TEXT_BACKEND_ID } from "../src/background/text-backend.ts";
import { resolveProviderScope } from "../src/extension.ts";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-background-settings-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the first existing sidecar wins", async () => {
  await withDir(async (dir) => {
    const first = join(dir, "first.json");
    const second = join(dir, "second.json");
    await writeFile(second, JSON.stringify({ enabled: true, text: true }));
    await writeFile(first, JSON.stringify({ enabled: false }));
    const loaded = await loadBackgroundSettings([join(dir, "missing.json"), first, second]);
    assert.equal(loaded.source, first);
    assert.equal(loaded.settings.enabled, false);
  });
});

for (const [name, text, fragment] of [
  ["an unknown key", JSON.stringify({ enabled: true, turbo: true }), "failed validation"],
  [
    "hysteresis not below prepareAt",
    JSON.stringify({ enabled: true, text: true, prepareAt: 0.2, hysteresis: 0.3 }),
    "hysteresis must be lower than prepareAt",
  ],
  [
    "output cap above input cap",
    JSON.stringify({ enabled: true, maxInputTokens: 10, maxOutputTokens: 20 }),
    "maxOutputTokens must not exceed maxInputTokens",
  ],
] as const) {
  test(`a sidecar with ${name} disables the feature with a visible diagnostic`, async () => {
    await withDir(async (dir) => {
      const path = join(dir, "background-compaction.json");
      await writeFile(path, text);
      const loaded = await loadBackgroundSettings([path]);
      assert.equal(loaded.settings.enabled, false);
      assert.equal(backgroundCompactionActive(loaded.settings), false);
      const diagnostic = loaded.diagnostic ?? "";
      assert.ok(diagnostic.startsWith(path), "the diagnostic names its source");
      assert.ok(diagnostic.includes(fragment), diagnostic);
      assert.ok(diagnostic.includes("disabled"));
      assert.equal(loaded.source, path);
    });
  });
}

test("an untrusted project cannot supply the sidecar", () => {
  const trusted = backgroundSettingsPaths({ cwd: "/p", agentDir: "/a", projectTrusted: true });
  const untrusted = backgroundSettingsPaths({ cwd: "/p", agentDir: "/a", projectTrusted: false });
  assert.equal(trusted[0], join("/p", ".pi", "extensions", "background-compaction.json"));
  assert.equal(trusted[1], join("/a", "extensions", "background-compaction.json"));
  assert.equal(trusted.length, 3);
  assert.ok(trusted[2]?.endsWith(join(".pi", "extensions", "background-compaction.json")));
  assert.deepEqual(untrusted, trusted.slice(1));
});

test("the Preferences switch writes an owner-only global sidecar a trusted project still overrides", async () => {
  await withDir(async (dir) => {
    const location = {
      cwd: join(dir, "project"),
      agentDir: join(dir, "agent"),
      projectTrusted: true,
    };
    const global = globalBackgroundSettingsPath(location.agentDir);
    await writeGlobalBackgroundEnabled(location.agentDir, true);
    assert.deepEqual(JSON.parse(await readFile(global, "utf8")), { enabled: true, text: true });
    assert.equal((await stat(global)).mode & 0o777, 0o600);
    assert.deepEqual(
      await readdir(dirname(global)),
      ["background-compaction.json"],
      "no temp file",
    );
    const paths = backgroundSettingsPaths(location);
    assert.equal((await loadBackgroundSettings(paths)).source, global);
    const project = paths[0] ?? "";
    await mkdir(dirname(project), { recursive: true });
    await writeFile(project, JSON.stringify({ enabled: false }));
    const loaded = await loadBackgroundSettings(paths);
    assert.equal(loaded.source, project);
    assert.equal(loaded.settings.enabled, false);
  });
});

test("the vendor compaction rows derive the backend switches", () => {
  const table: readonly [boolean, boolean, boolean, boolean][] = [
    // openai server-side, anthropic server-side -> codexNative, anthropicNative
    [true, true, true, true],
    [true, false, true, false],
    [false, true, false, true],
    [false, false, false, false],
  ];
  for (const [openaiServerSide, anthropicServerSide, codexNative, anthropicNative] of table) {
    assert.deepEqual(
      deriveBackgroundLanes({ openaiServerSide, anthropicServerSide }),
      { text: true, codexNative, anthropicNative },
      `openai=${openaiServerSide} anthropic=${anthropicServerSide}`,
    );
  }
});

test("with no sidecar the default switches are on and the native lanes follow the vendor rows", async () => {
  await withDir(async (dir) => {
    const defaults = await loadBackgroundSettings([join(dir, "absent.json")]);
    assert.equal(defaults.source, undefined);
    assert.equal(backgroundCompactionActive(defaults.settings), true, "on by default");
    const lanes = deriveBackgroundLanes({ openaiServerSide: true, anthropicServerSide: true });
    const derived = withDerivedDefaultLanes(defaults, lanes).settings;
    assert.deepEqual(
      {
        text: derived.text,
        codexNative: derived.codexNative,
        anthropicNative: derived.anthropicNative,
      },
      lanes,
    );

    const file = join(dir, "background-compaction.json");
    await writeFile(file, JSON.stringify({ enabled: true }));
    const fromFile = await loadBackgroundSettings([file]);
    assert.equal(
      withDerivedDefaultLanes(fromFile, lanes),
      fromFile,
      "a file keeps its own switches",
    );
    await writeFile(file, "{ not json");
    const rejected = await loadBackgroundSettings([file]);
    assert.equal(
      withDerivedDefaultLanes(rejected, lanes).settings.enabled,
      false,
      "rejected stays off",
    );
  });
});

test("the derived writer keeps other keys, skips unchanged files and refuses malformed ones", async () => {
  await withDir(async (dir) => {
    const agentDir = join(dir, "agent");
    const global = globalBackgroundSettingsPath(agentDir);
    const lanes = deriveBackgroundLanes({ openaiServerSide: true, anthropicServerSide: false });
    assert.equal(
      await writeGlobalBackgroundSettings(agentDir, { lanes, onlyIfExists: true }),
      false,
      "a missing sidecar stays missing",
    );
    await assert.rejects(readFile(global, "utf8"), { code: "ENOENT" });

    assert.equal(await writeGlobalBackgroundSettings(agentDir, { enabled: true, lanes }), true);
    assert.deepEqual(JSON.parse(await readFile(global, "utf8")), {
      text: true,
      codexNative: true,
      anthropicNative: false,
      enabled: true,
    });
    assert.equal((await stat(global)).mode & 0o777, 0o600);

    await writeFile(
      global,
      JSON.stringify({ enabled: true, prepareAt: 0.6, anthropicNative: true }),
    );
    assert.equal(await writeGlobalBackgroundSettings(agentDir, { lanes }), true);
    assert.deepEqual(
      JSON.parse(await readFile(global, "utf8")),
      { enabled: true, prepareAt: 0.6, anthropicNative: false, text: true, codexNative: true },
      "the master switch and tunables are kept",
    );
    assert.equal(
      await writeGlobalBackgroundSettings(agentDir, { lanes, onlyIfExists: true }),
      false,
      "an unchanged file is not rewritten",
    );

    await writeFile(global, "{ enabled: true");
    await assert.rejects(
      writeGlobalBackgroundSettings(agentDir, { lanes }),
      (error) => error instanceof SidecarRefusedError,
    );
    assert.equal(await readFile(global, "utf8"), "{ enabled: true", "file untouched");
    assert.deepEqual(
      await readdir(dirname(global)),
      ["background-compaction.json"],
      "no temp file",
    );
  });
});

test("backend switches map onto backend IDs and require the master switch", () => {
  assert.equal(TEXT_BACKEND_SETTING_ID, TEXT_BACKEND_ID);
  assert.equal(ANTHROPIC_BACKEND_SETTING_ID, ANTHROPIC_BACKEND_ID);
  assert.equal(CODEX_BACKEND_SETTING_ID, "codex-native-v2");
  const all = {
    ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
    enabled: false,
    text: true,
    codexNative: true,
    anthropicNative: true,
  };
  for (const id of [TEXT_BACKEND_ID, ANTHROPIC_BACKEND_ID, CODEX_BACKEND_SETTING_ID]) {
    assert.equal(isBackendEnabled(id, all), false, `${id} is off while enabled:false`);
    assert.equal(isBackendEnabled(id, { ...all, enabled: true }), true, `${id} on`);
  }
  assert.equal(isBackendEnabled("unknown-backend", { ...all, enabled: true }), false);
  const textOnly = { ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS, enabled: true, text: true };
  assert.equal(isBackendEnabled(ANTHROPIC_BACKEND_ID, textOnly), false);
  assert.equal(isBackendEnabled(CODEX_BACKEND_SETTING_ID, textOnly), false);
});

test("Codex sessions get an OAuth scope bound to the hashed account", async () => {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "acct-example" } };
  const token = ["h", Buffer.from(JSON.stringify(claims)).toString("base64"), "s"].join(".");
  const model: Model<Api> = {
    id: "gpt-test",
    name: "codex",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1_000,
  };
  const registry = (apiKey: string) => ({
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey, headers: {} }),
  });
  const on = { ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS, enabled: true, codexNative: true };
  const scope = await resolveProviderScope(model, registry(token), on);
  assert.deepEqual(scope, {
    provider: "openai-codex",
    model: "gpt-test",
    baseUrl: "https://chatgpt.com/backend-api",
    authMode: "oauth",
    accountScope: codexBackgroundAccountScope("acct-example"),
  });
  assert.equal(Object.values(scope).includes("acct-example"), false, "no raw account ID");
  const off = await resolveProviderScope(model, registry(token), {
    ...on,
    codexNative: false,
  });
  assert.equal(off.accountScope, undefined, "nothing read while the Codex switch is off");
  const opaque = await resolveProviderScope(model, registry("not-a-jwt"), on);
  assert.equal(opaque.accountScope, undefined, "an unparseable token fails closed");
  assert.equal(opaque.authMode, undefined);
});
