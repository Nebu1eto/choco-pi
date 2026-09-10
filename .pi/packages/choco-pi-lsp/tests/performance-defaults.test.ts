import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

    resetAsyncGlobalConfigCache();
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
