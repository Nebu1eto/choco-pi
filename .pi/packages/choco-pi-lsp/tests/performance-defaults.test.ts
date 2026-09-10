import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getLensFlagSpec } from "../clients/lsp-flag-registry.ts";
import {
  isAutomaticTypeAcquisitionEnabledAsync,
  resetAsyncGlobalConfigCache,
} from "../clients/lsp-config.ts";
import {
  defaultTypeScriptInitialization,
  typeAcquisitionEnabledFromConfig,
} from "../clients/lsp/typescript-config.ts";
import {
  runLanguageServerPrewarm,
  shouldPrewarmLanguageServers,
} from "../clients/session-warmup-config.ts";

test("language-server session prewarm defaults off and can be enabled", () => {
  const spec = getLensFlagSpec("lsp-warmup");
  assert.equal(spec?.configKey, "warmup.enabled");
  assert.equal(spec?.default, false);
  assert.equal(
    shouldPrewarmLanguageServers(() => spec?.default),
    false,
  );
  assert.equal(
    shouldPrewarmLanguageServers(() => true),
    true,
  );
});

test("explicit warmFiles opt in independently of automatic language warmup", async () => {
  const calls: string[] = [];
  const result = await runLanguageServerPrewarm({
    warmFiles: ["src/index.ts"],
    automaticWarmupEnabled: false,
    warmConfiguredFiles: async (files) => {
      calls.push(`configured:${files.join(",")}`);
    },
    warmDominantLanguage: async () => {
      calls.push("automatic");
    },
  });

  assert.equal(result, "configured");
  assert.deepEqual(calls, ["configured:src/index.ts"]);
});

test("disabled automatic warmup does not warm a dominant language without warmFiles", async () => {
  const calls: string[] = [];
  const result = await runLanguageServerPrewarm({
    warmFiles: [],
    automaticWarmupEnabled: false,
    warmConfiguredFiles: async () => {
      calls.push("configured");
    },
    warmDominantLanguage: async () => {
      calls.push("automatic");
    },
  });

  assert.equal(result, "disabled");
  assert.deepEqual(calls, []);
});

test("TypeScript ATA defaults off and can be enabled", () => {
  assert.equal(typeAcquisitionEnabledFromConfig(undefined), false);
  assert.equal(typeAcquisitionEnabledFromConfig({ typeAcquisition: { enabled: true } }), true);
  assert.deepEqual(defaultTypeScriptInitialization(false), {
    "js/ts": { tsserver: { automaticTypeAcquisition: { enabled: false } } },
    typescript: { disableAutomaticTypeAcquisition: true },
    disableAutomaticTypingAcquisition: true,
  });
  assert.equal(defaultTypeScriptInitialization(true), undefined);
});

test("async TypeScript ATA config preserves resolution and memoizes each path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "choco-pi-lsp-ata-"));
  const configPath = join(directory, "config.json");
  const previousEnv = process.env.CHOCO_PI_LSP_TYPE_ACQUISITION;
  delete process.env.CHOCO_PI_LSP_TYPE_ACQUISITION;
  resetAsyncGlobalConfigCache();

  try {
    assert.equal(await isAutomaticTypeAcquisitionEnabledAsync(configPath), false);

    await writeFile(configPath, '{"typeAcquisition":{"enabled":true}}', "utf-8");
    assert.equal(await isAutomaticTypeAcquisitionEnabledAsync(configPath), true);

    await writeFile(configPath, '{"typeAcquisition":{"enabled":false}}', "utf-8");
    assert.equal(await isAutomaticTypeAcquisitionEnabledAsync(configPath), true);

    resetAsyncGlobalConfigCache();
    assert.equal(await isAutomaticTypeAcquisitionEnabledAsync(configPath), false);

    process.env.CHOCO_PI_LSP_TYPE_ACQUISITION = "1";
    assert.equal(await isAutomaticTypeAcquisitionEnabledAsync(configPath), true);
  } finally {
    resetAsyncGlobalConfigCache();
    if (previousEnv === undefined) delete process.env.CHOCO_PI_LSP_TYPE_ACQUISITION;
    else process.env.CHOCO_PI_LSP_TYPE_ACQUISITION = previousEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test("TypeScript spawn wiring uses only the asynchronous ATA config API", async () => {
  const source = await readFile(new URL("../clients/lsp/server.ts", import.meta.url), "utf-8");
  assert.match(source, /\bisAutomaticTypeAcquisitionEnabledAsync\b/);

  const withoutAsyncApi = source.replaceAll("isAutomaticTypeAcquisitionEnabledAsync", "");
  assert.doesNotMatch(withoutAsyncApi, /\bisAutomaticTypeAcquisitionEnabled\b/);
});

test("runtime session keeps explicit and automatic LSP warm wiring separate", async () => {
  const source = await readFile(new URL("../clients/runtime-session.ts", import.meta.url), "utf-8");

  // Wiring guards: both startup paths must resolve warmFiles before deciding
  // whether automatic dominant-language warming is enabled. The helper tests
  // above own behavioral branching; these assertions protect its call sites.
  const quickPathStart = source.indexOf("const lspConfig = await loadLSPConfig(warmupCwd)");
  const fullPathStart = source.indexOf("// LSP warm files — deferred");
  assert.notEqual(quickPathStart, -1);
  assert.notEqual(fullPathStart, -1);

  const quickPath = source.slice(quickPathStart, fullPathStart);
  const fullPath = source.slice(
    fullPathStart,
    source.indexOf("setSessionLanguages", fullPathStart),
  );

  for (const startupPath of [quickPath, fullPath]) {
    assert.match(startupPath, /const warmFiles = lspConfig\.warmFiles \?\? \[\]/);
    assert.match(
      startupPath,
      /runLanguageServerPrewarm\(\{[\s\S]*?warmFiles,[\s\S]*?automaticWarmupEnabled[\s\S]*?warmConfiguredFiles:[\s\S]*?igniteWarmFiles[\s\S]*?warmDominantLanguage:[\s\S]*?igniteDominantLanguageWarm[\s\S]*?\}\)/,
    );
    assert.ok(
      startupPath.indexOf("const warmFiles =") <
        startupPath.indexOf("shouldPrewarmLanguageServers"),
    );
  }

  // The guarded quick-path fallback must still warm explicitly configured
  // files when dominant-language warming is disallowed by the startup scan.
  assert.match(
    quickPath,
    /if \(!scan\.canWarmCaches\)[\s\S]*?warmFiles\.length > 0[\s\S]*?igniteWarmFiles\(/,
  );
});
