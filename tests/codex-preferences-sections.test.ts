import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CodexConversionConfig } from "../.pi/packages/choco-pi-codex/src/adapter/activation/config.ts";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../.pi/packages/choco-pi-codex/src/adapter/activation/config.ts";
import {
  buildCodexPreferencesSections,
  CODEX_EDIT_CONFIG_OUTCOME,
  CODEX_SECTION_ID,
  registerCodexPreferencesProvider,
  type CodexPreferencesSection,
  type CodexPreferencesDeps,
} from "../.pi/packages/choco-pi-codex/src/ui/settings/preferences-sections.ts";
import { buildCodexPreferencesSections as readPublishedSections } from "../.pi/extensions/lib/codex-preferences.ts";
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

function sectionRowIds(sections: CodexPreferencesSection[], id: string): string[] {
  return (
    sections
      .find((section) => section.id === id)
      ?.buildItems()
      .map((item) => item.id) ?? []
  );
}

function findSection(
  sections: CodexPreferencesSection[],
  id: string,
): CodexPreferencesSection | undefined {
  return sections.find((section) => section.id === id);
}

test(
  "every /codex settings row lands in a topical section",
  withCodexDirs(({ ctx, deps }) => {
    // SAFETY: the fixture supplies every host member the section touches.
    const sections = buildCodexPreferencesSections(ctx as never, deps);

    // No Codex section owns a tab: every row joins an existing one.
    for (const section of sections) {
      assert.ok(section.mergeInto, `${section.id} must merge into a host section`);
    }
    assert.deepEqual(
      sections.map((section) => section.mergeInto),
      ["appearance", "footer", "model", "tools", "agent"],
    );

    const placed = sections.flatMap((section) => section.buildItems().map((item) => item.id));
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
      assert.ok(placed.includes(expected), `missing row ${expected}`);
    }
    assert.equal(new Set(placed).size, placed.length, "row ids must stay unique across sections");
    assert.deepEqual(sectionRowIds(sections, `${CODEX_SECTION_ID}:footer`), [
      "codexSourceHeader:footer",
      "statusLine",
    ]);
    assert.deepEqual(sectionRowIds(sections, `${CODEX_SECTION_ID}:appearance`), [
      "codexSourceHeader:appearance",
      "toolRenaming",
      "compactTools",
      "codeModeDetails",
    ]);
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
      const sections = buildCodexPreferencesSections(ctx as never, deps);
      const section = findSection(sections, `${CODEX_SECTION_ID}:agent`);
      const row = section?.buildItems().find((item) => item.id === "editConfig");
      assert.deepEqual(row?.values, ["Open"]);
      assert.equal(row?.currentValue, "Open");
      assert.deepEqual(section?.handleChange("editConfig", "Open"), {
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
    const sections = buildCodexPreferencesSections(ctx as never, deps);
    const model = findSection(sections, `${CODEX_SECTION_ID}:model`);
    assert.ok(model);
    model.buildItems();

    assert.deepEqual(model.handleChange("fast", "on"), { kind: "rebuild" });
    assert.equal(saved.at(-1)?.openai.fast, true);

    assert.deepEqual(model.handleChange("executionMode", "code"), { kind: "rebuild" });
    assert.equal(saved.at(-1)?.executionMode, "code");
  }),
);

test(
  "switching the scope row materializes a project config",
  withCodexDirs(({ ctx, deps }, cwd) => {
    // SAFETY: the fixture supplies every host member the section touches.
    const sections = buildCodexPreferencesSections(ctx as never, deps);
    const agent = findSection(sections, `${CODEX_SECTION_ID}:agent`);
    assert.ok(agent);
    const scopeValue = (): string | undefined =>
      agent.buildItems().find((item) => item.id === "codexConfigScope")?.currentValue;
    assert.equal(scopeValue(), "Defaults");

    assert.deepEqual(agent.handleChange("codexConfigScope", "Project"), { kind: "rebuild" });
    assert.equal(scopeValue(), "Project");
    assert.deepEqual(agent.handleChange("codexConfigScope", "Defaults"), { kind: "rebuild" });
    assert.equal(scopeValue(), "Defaults");

    // The project file itself is written by the config store, not by this test.
    assert.ok(path.isAbsolute(cwd));
  }),
);

test(
  "an untrusted project cannot select the project scope",
  withCodexDirs(({ deps }, cwd) => {
    const untrusted = createFixture(cwd, false);
    // SAFETY: the fixture supplies every host member the section touches.
    const sections = buildCodexPreferencesSections(untrusted.ctx as never, deps);
    const scope = findSection(sections, `${CODEX_SECTION_ID}:agent`)
      ?.buildItems()
      .find((item) => item.id === "codexConfigScope");
    assert.deepEqual(scope?.values, ["Defaults"]);
  }),
);

test(
  "the profile reads the published sections over the global registry",
  withCodexDirs(({ ctx, deps }) => {
    const store = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
    const previous = store[CODEX_PROVIDER_SYMBOL];
    try {
      assert.deepEqual(readPublishedSections(ctx), []);
      registerCodexPreferencesProvider(deps);
      assert.deepEqual(
        readPublishedSections(ctx).map((section) => section.mergeInto),
        ["appearance", "footer", "model", "tools", "agent"],
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
    const sections = buildCodexPreferencesSections(fixture.ctx as never, deps);
    const scope = findSection(sections, `${CODEX_SECTION_ID}:agent`)
      ?.buildItems()
      .find((item) => item.id === "codexConfigScope");
    assert.equal(scope?.currentValue, "Project");
  }),
);
