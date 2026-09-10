import assert from "node:assert/strict";
import test from "node:test";
import { getLensFlagSpec } from "../clients/lsp-flag-registry.ts";
import {
  defaultTypeScriptInitialization,
  typeAcquisitionEnabledFromConfig,
} from "../clients/lsp/typescript-config.ts";
import { shouldPrewarmLanguageServers } from "../clients/session-warmup-config.ts";

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
