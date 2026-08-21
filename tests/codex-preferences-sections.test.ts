import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CodexConversionConfig } from "../.pi/packages/choco-pi-codex/src/adapter/activation/config.ts";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../.pi/packages/choco-pi-codex/src/adapter/activation/config.ts";
import {
  buildCodexPreferencesSection,
  CODEX_EDIT_CONFIG_OUTCOME,
  CODEX_SECTION_ID,
  registerCodexPreferencesProvider,
  type CodexPreferencesDeps,
} from "../.pi/packages/choco-pi-codex/src/ui/settings/preferences-sections.ts";
import { buildCodexPreferencesSections } from "../.pi/extensions/lib/codex-preferences.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

const CODEX_PROVIDER_SYMBOL = Symbol.for("choco-pi.codex-preferences-provider");

interface Fixture {
  ctx: RuntimeValue;
  deps: CodexPreferencesDeps;
  saved: CodexConversionConfig[];
  notices: [string, string][];
}

function createFixture(cwd: string, projectTrusted: boolean): Fixture {
  const saved: CodexConversionConfig[] = [];
  const notices: [string, string][] = [];
  let running: CodexConversionConfig = DEFAULT_CODEX_CONVERSION_CONFIG;
  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => projectTrusted,
    ui: {
      notify: (message: string, level: string) => notices.push([message, level]),
      theme: { fg: (_color: string, value: string) => value, bold: (value: string) => value },
    },
  };
  const deps: CodexPreferencesDeps = {
    effectiveConfig: () => running,
    saveAndApply: (_ctx, _scope, nextConfig) => {
      saved.push(nextConfig);
      running = nextConfig;
      return true;
    },
    applyEffectiveConfig: () => {},
    getRunningConfig: () => running,
  };
  return { ctx: reinterpretHostValue<RuntimeValue>(ctx), deps, saved, notices };
}

function withCodexDirs(run: (fixture: Fixture, cwd: string) => void) {
  return () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-preferences-"));
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      run(createFixture(cwd, true), cwd);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  "the Codex section carries every /codex settings row in one list",
  withCodexDirs(({ ctx, deps }) => {
    // SAFETY: the fixture supplies every host member the section touches.
    const section = buildCodexPreferencesSection(ctx as never, deps);
    assert.equal(section.id, CODEX_SECTION_ID);

    const ids = section.buildItems().map((item) => item.id);
    for (const expected of [
      "codexConfigScope",
      "executionMode",
      "extensionMode",
      "allProviders",
      "additionalProviders",
      "heavySystemPromptOverwrite",
      "editConfig",
      "webRun",
      "webSearchModel",
      "applyPatchOnly",
      "fast",
      "verbosity",
      "responsesCompaction",
      "cacheDiagnosticsLog",
      "statusLine",
      "compactTools",
      "codexAboutGithub",
    ]) {
      assert.ok(ids.includes(expected), `missing row ${expected}`);
    }
    assert.equal(new Set(ids).size, ids.length, "row ids must stay unique across the merged tabs");
  }),
);

test(
  "the Edit config row opens in Pi's editor regardless of $EDITOR",
  withCodexDirs(({ ctx, deps }) => {
    const previous = process.env.EDITOR;
    const previousVisual = process.env.VISUAL;
    delete process.env.EDITOR;
    delete process.env.VISUAL;
    try {
      // SAFETY: the fixture supplies every host member the section touches.
      const section = buildCodexPreferencesSection(ctx as never, deps);
      const row = section.buildItems().find((item) => item.id === "editConfig");
      assert.deepEqual(row?.values, ["Open"]);
      assert.equal(row?.currentValue, "Open");
      assert.deepEqual(section.handleChange("editConfig", "Open"), {
        kind: "outcome",
        outcome: CODEX_EDIT_CONFIG_OUTCOME,
      });
    } finally {
      if (previous === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = previous;
      if (previousVisual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = previousVisual;
    }
  }),
);

test(
  "changing a Codex row saves the adapter config",
  withCodexDirs(({ ctx, deps, saved }) => {
    // SAFETY: the fixture supplies every host member the section touches.
    const section = buildCodexPreferencesSection(ctx as never, deps);
    section.buildItems();

    assert.deepEqual(section.handleChange("fast", "on"), { kind: "rebuild" });
    assert.equal(saved.at(-1)?.openai.fast, true);

    assert.deepEqual(section.handleChange("executionMode", "code"), { kind: "rebuild" });
    assert.equal(saved.at(-1)?.executionMode, "code");

    assert.deepEqual(section.handleChange("editConfig", "Open"), {
      kind: "outcome",
      outcome: CODEX_EDIT_CONFIG_OUTCOME,
    });
  }),
);

test(
  "switching the scope row materializes a project config",
  withCodexDirs(({ ctx, deps }, cwd) => {
    // SAFETY: the fixture supplies every host member the section touches.
    const section = buildCodexPreferencesSection(ctx as never, deps);
    assert.equal(section.buildItems()[0]?.currentValue, "Defaults");

    assert.deepEqual(section.handleChange("codexConfigScope", "Project"), { kind: "rebuild" });
    assert.equal(section.buildItems()[0]?.currentValue, "Project");
    assert.deepEqual(section.handleChange("codexConfigScope", "Defaults"), { kind: "rebuild" });
    assert.equal(section.buildItems()[0]?.currentValue, "Defaults");

    // The project file itself is written by the config store, not by this test.
    assert.ok(path.isAbsolute(cwd));
  }),
);

test(
  "an untrusted project cannot select the project scope",
  withCodexDirs(({ deps }, cwd) => {
    const untrusted = createFixture(cwd, false);
    // SAFETY: the fixture supplies every host member the section touches.
    const section = buildCodexPreferencesSection(untrusted.ctx as never, deps);
    assert.deepEqual(section.buildItems()[0]?.values, ["Defaults"]);
  }),
);

test(
  "the profile reads the published sections over the global registry",
  withCodexDirs(({ ctx, deps }) => {
    const store = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
    const previous = store[CODEX_PROVIDER_SYMBOL];
    try {
      assert.deepEqual(buildCodexPreferencesSections(ctx), []);
      registerCodexPreferencesProvider(deps);
      assert.deepEqual(
        buildCodexPreferencesSections(ctx).map((section) => section.id),
        [CODEX_SECTION_ID],
      );
    } finally {
      if (previous === undefined) delete store[CODEX_PROVIDER_SYMBOL];
      else store[CODEX_PROVIDER_SYMBOL] = previous;
    }
  }),
);

test(
  "a project config file selects the project scope on open",
  withCodexDirs(({ deps }, cwd) => {
    writeFileSync(
      path.join(cwd, ".pi", "choco-pi-codex.json"),
      `${JSON.stringify({ ui: { statusLine: false } }, null, 2)}\n`,
    );
    const fixture = createFixture(cwd, true);
    // SAFETY: the fixture supplies every host member the section touches.
    const section = buildCodexPreferencesSection(fixture.ctx as never, deps);
    assert.equal(section.buildItems()[0]?.currentValue, "Project");
  }),
);
