import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bool, compile, obj, str, unknown } from "@earendil-works/pi-schema";
import {
  DEFAULT_CODEX_CONVERSION_CONFIG,
  normalizeCodexConversionConfig,
} from "../src/adapter/activation/config.ts";
import {
  readCodexConversionConfig,
  writeCodexConversionConfig,
} from "../src/adapter/activation/config-store.ts";

const LEGACY_DOCUMENT = {
  executionMode: "code",
  voiceFeaturesOnly: false,
  ui: {
    statusLine: false,
    backgroundShellWidget: true,
    backgroundShellToggleShortcut: "alt+w",
  },
  voice: { v3Voice: "cove", audioSetupCompleted: true, contextReasoning: "high" },
};

const isWrittenLegacyDocument = compile(
  obj(
    {
      voice: unknown(),
      ui: obj(
        { statusLine: bool(), backgroundShellWidget: bool(), backgroundShellToggleShortcut: str() },
        { open: true },
      ),
    },
    { open: true },
  ),
).check;

test("retired voice and background-shell keys are ignored on read", () => {
  const config = normalizeCodexConversionConfig(LEGACY_DOCUMENT);
  assert.equal(config.ui.statusLine, false);
  assert.equal("voice" in config, false);
  assert.equal("backgroundShellWidget" in config.ui, false);
  assert.equal("voice" in DEFAULT_CODEX_CONVERSION_CONFIG, false);
});

test("a settings write keeps retired keys of an existing legacy file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codex-retired-keys-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "choco-pi-codex.json");
  await writeFile(path, JSON.stringify(LEGACY_DOCUMENT), "utf8");

  const config = readCodexConversionConfig(path);
  assert.equal(config.ui.statusLine, false);
  assert.deepEqual(
    writeCodexConversionConfig({ ...config, ui: { ...config.ui, statusLine: true } }, path),
    {
      ok: true,
    },
  );

  const written: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(isWrittenLegacyDocument(written));
  assert.deepEqual(written.voice, LEGACY_DOCUMENT.voice);
  assert.equal(written.ui.statusLine, true);
  assert.equal(written.ui.backgroundShellWidget, true);
  assert.equal(written.ui.backgroundShellToggleShortcut, "alt+w");
});
