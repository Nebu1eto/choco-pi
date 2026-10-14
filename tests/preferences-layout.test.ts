import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  InteractiveMode,
  SettingsSelectorComponent,
  initTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities, type SettingItem } from "@earendil-works/pi-tui";
import { buildAgentPreferencesSection } from "../.pi/extensions/lib/agent-preferences-dialog.ts";
import type { PreferencesExtraSection } from "../.pi/extensions/lib/agent-preferences.ts";
import { buildBackgroundCompactionPreferencesSections } from "../.pi/extensions/lib/background-compaction-preferences.ts";
import {
  buildNativeSettingsSections,
  installNativeSettingsBridge,
  type NativeSettingsHost,
} from "../.pi/extensions/lib/native-settings.ts";
import {
  PREFERENCES_HIDDEN_ROWS,
  PREFERENCES_LAYOUT,
} from "../.pi/extensions/lib/preferences-layout.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import { buildContextCapSection, CONTEXT_CAP_ROW_ID } from "../.pi/extensions/model-context-cap.ts";
import { buildAdvisorPreferencesSection } from "../.pi/packages/choco-pi-advisor/src/preferences-section.ts";
import { DEFAULT_SETTINGS } from "../.pi/packages/choco-pi-advisor/src/settings.ts";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../.pi/packages/choco-pi-codex/src/adapter/activation/config.ts";
import { buildCodexPreferencesSections } from "../.pi/packages/choco-pi-codex/src/ui/settings/preferences-sections.ts";
import { publishBackgroundCompactionPreferences } from "../.pi/packages/choco-pi-compaction/src/preferences-section.ts";
import { SUBAGENT_SETTING_DEFINITIONS } from "../.pi/packages/choco-pi-subagents/src/preferences-section.ts";
import { loadZentuiModule, SKIP_WITHOUT_ZENTUI } from "./zentui-build.ts";

initTheme("dark", false);

const BRIDGE_SYMBOL = Symbol.for("choco-pi.native-settings-bridge");
const SECTION_PREFIX = "section:";

/** Built-in choco-ui rows the layout names explicitly; the panel test proves they render. */
const ZENTUI_EXPLICIT_ROWS = new Set([
  "iconMode",
  "selectorBordersEnabled",
  "selectorBordersStyle",
  "selectorBordersColorSource",
]);

type PrototypeRecord = Record<PropertyKey, RuntimeValue>;

/** Every explicit row id in the layout, once per occurrence. */
function explicitEntries(): string[] {
  return PREFERENCES_LAYOUT.flatMap((tab) =>
    tab.groups.flatMap((group) => group.rows.filter((row) => !row.startsWith(SECTION_PREFIX))),
  );
}

/**
 * Pi 1.0.4's own settings selector, built for real with image support on, so
 * every row it can show is present.
 */
function realPiSelector(): RuntimeValue {
  const callbacks = new Proxy({}, { get: () => () => {} });
  return new SettingsSelectorComponent(
    reinterpretHostValue<ConstructorParameters<typeof SettingsSelectorComponent>[0]>({
      autoCompact: true,
      showImages: true,
      imageWidthCells: 80,
      autoResizeImages: true,
      blockImages: false,
      enableSkillCommands: true,
      steeringMode: "all",
      followUpMode: "all",
      transport: "sse",
      cacheWarmingMode: "off",
      hideThinkingBlock: false,
      mermaidRenderingMode: "final",
      showCacheMissNotices: false,
      collapseChangelog: false,
      enableInstallTelemetry: false,
      doubleEscapeAction: "tree",
      treeFilterMode: "default",
      showHardwareCursor: false,
      editorPaddingX: 0,
      outputPad: 1,
      autocompleteMaxVisible: 5,
      quietStartup: false,
      clearOnShrink: false,
      showTerminalProgress: true,
      fullscreenExitOutput: "transcript",
      fullscreenScrollbar: "auto",
      fullscreenCopyOnSelect: true,
      tuiMode: "fullscreen",
      currentTheme: "dark",
      warnings: {},
      modelThinkingLevels: {},
      availableDefaultModels: [],
      availableThemes: ["dark"],
      defaultProjectTrust: "ask",
      httpIdleTimeoutMs: 300_000,
      fullscreenWheelScrollLines: "auto",
    }),
    reinterpretHostValue<ConstructorParameters<typeof SettingsSelectorComponent>[1]>(callbacks),
  );
}

interface Providers {
  ctx: ExtensionCommandContext;
  sections: PreferencesExtraSection[];
  /** Ids of every row each provider builds, keyed by provider. */
  rows: Map<string, string[]>;
}

/**
 * Builds every provider the profile hosts, with real row builders, inside a
 * throwaway agent directory and with Pi's real selector behind the bridge.
 */
async function withProviders(run: (providers: Providers) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "preferences-layout-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const prototype = reinterpretHostValue<PrototypeRecord>(InteractiveMode.prototype);
  const store = reinterpretHostValue<PrototypeRecord>(globalThis);
  const originalShow = prototype["showSettingsSelector"];
  const originalSetup = prototype["setupAutocompleteProvider"];
  const originalModelCommand = prototype["handleModelCommand"];
  const originalBridge = store[BRIDGE_SYMBOL];
  const originalCapabilities = getCapabilities();
  setCapabilities({ ...originalCapabilities, images: "kitty" });
  delete store[BRIDGE_SYMBOL];
  prototype["showSettingsSelector"] = function showRealSelector(this: NativeSettingsHost): void {
    this.showSelector(() => ({ component: realPiSelector(), focus: undefined }));
  };
  const unpublish = publishBackgroundCompactionPreferences({
    enabled: () => false,
    setEnabled: async () => {},
  });
  try {
    installNativeSettingsBridge(() => {});
    reinterpretHostValue<(this: NativeSettingsHost) => void>(
      prototype["showSettingsSelector"],
    ).call(reinterpretHostValue<NativeSettingsHost>({}));

    const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
    const ctx = reinterpretHostValue<ExtensionCommandContext>({
      cwd,
      hasUI: true,
      mode: "tui",
      model: undefined,
      isProjectTrusted: () => true,
      modelRegistry: { getAvailable: () => [], getAll: () => [] },
      scopedModels: [],
      ui: { notify: () => {}, theme },
    });
    let running = DEFAULT_CODEX_CONVERSION_CONFIG;
    const codex = buildCodexPreferencesSections(ctx, {
      effectiveConfig: () => running,
      saveAndApply: (_ctx, _scope, next) => {
        running = next;
        return true;
      },
      applyEffectiveConfig: () => {},
      getRunningConfig: () => running,
    });
    const advisor = buildAdvisorPreferencesSection({
      agentDir,
      settings: { ...DEFAULT_SETTINGS },
      models: [],
    });
    const subagents: PreferencesExtraSection = {
      id: "subagents",
      label: "Subagents",
      buildItems: () =>
        SUBAGENT_SETTING_DEFINITIONS.map((definition) => ({
          id: definition.id,
          label: definition.label,
          currentValue: "on",
          values: ["on", "off"],
        })),
      handleChange: () => ({ kind: "update" }),
    };
    const sections: PreferencesExtraSection[] = [
      ...buildNativeSettingsSections(),
      buildContextCapSection(ctx),
      ...codex,
      subagents,
      advisor,
      ...buildBackgroundCompactionPreferencesSections(ctx),
      buildAgentPreferencesSection(ctx),
    ];
    const rows = new Map(
      sections.map((section) => [section.id, section.buildItems().map((item) => item.id)]),
    );
    await run({ ctx, sections, rows });
  } finally {
    unpublish();
    setCapabilities(originalCapabilities);
    prototype["showSettingsSelector"] = originalShow;
    prototype["setupAutocompleteProvider"] = originalSetup;
    prototype["handleModelCommand"] = originalModelCommand;
    if (originalBridge === undefined) delete store[BRIDGE_SYMBOL];
    else store[BRIDGE_SYMBOL] = originalBridge;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

test("the layout names each row once and never both places and hides it", () => {
  const entries = explicitEntries();
  const duplicates = entries.filter((id, index) => entries.indexOf(id) !== index);
  assert.deepEqual(duplicates, [], "a row id is placed in more than one group");
  const hidden = new Set(PREFERENCES_HIDDEN_ROWS);
  assert.equal(hidden.size, PREFERENCES_HIDDEN_ROWS.length, "a hidden row is listed twice");
  assert.deepEqual(
    entries.filter((id) => hidden.has(id)),
    [],
    "a row is both placed and hidden",
  );
  assert.deepEqual(
    PREFERENCES_LAYOUT.map((tab) => tab.label),
    [
      "Agent",
      "Model",
      "Session",
      "Appearance",
      "Editor",
      "Statusline",
      "Terminal",
      "Tools",
      "Advanced",
    ],
  );
});

test("every provider row is placed in exactly one group or explicitly hidden", async () => {
  await withProviders(async ({ rows }) => {
    const entries = explicitEntries();
    const hidden = new Set(PREFERENCES_HIDDEN_ROWS);
    const providerIds = [...rows.values()].flat();
    assert.equal(new Set(providerIds).size, providerIds.length, "two providers build one row id");
    for (const [provider, ids] of rows) {
      for (const id of ids) {
        const placed = entries.filter((entry) => entry === id).length;
        assert.equal(
          placed + (hidden.has(id) ? 1 : 0),
          1,
          `${provider} row ${id} must be placed once or hidden`,
        );
      }
    }
    // Every explicit entry names a row someone builds, so the layout holds no
    // stale ids that would silently stop matching.
    const known = new Set([...providerIds, ...ZENTUI_EXPLICIT_ROWS]);
    assert.deepEqual(
      [...entries, ...PREFERENCES_HIDDEN_ROWS].filter((id) => !known.has(id)),
      [],
    );
    // The context cap and background compaction rows use their own ids.
    assert.ok(rows.get("contextCapPolicy")?.includes(CONTEXT_CAP_ROW_ID));
    assert.deepEqual(rows.get("backgroundCompaction"), ["backgroundCompaction.enabled"]);
  });
});

test("with Pi 1.0.4's rows nothing falls back to the Pi tab", async () => {
  await withProviders(async ({ rows }) => {
    const pi = rows.get("pi") ?? [];
    // The real selector, not a fixture: these are the ids Pi 1.0.4 builds.
    for (const id of [
      "cache-warming-mode",
      "fullscreen-copy-on-select",
      "fullscreen-wheel-scroll-lines",
      "show-images",
      "theme",
    ]) {
      assert.ok(pi.includes(id), `Pi 1.0.4 builds ${id}`);
    }
    const claimed = new Set([...explicitEntries(), ...PREFERENCES_HIDDEN_ROWS]);
    assert.deepEqual(
      pi.filter((id) => !claimed.has(id)),
      [],
      "an unclaimed Pi row would open a stray Pi tab",
    );
  });
});

type PanelHandle = {
  render: (width: number) => string[];
  handleInput: (data: string) => void;
  dispose: () => void;
  getActiveSection: () => string;
  hasActiveSearch: () => boolean;
};

type SettingsCommandModule = {
  createZentuiPreferencesComponent: (deps: RuntimeValue, options: RuntimeValue) => PanelHandle;
  resolveZentuiPreferencesArgs: (
    args: string,
    deps: RuntimeValue,
    ctx: RuntimeValue,
  ) => { open: boolean; section?: string } | undefined;
};

const noopTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  fgRgb: (text: string) => text,
  bg: (_color: string, text: string) => text,
};

async function zentui(): Promise<{ module: SettingsCommandModule; config: RuntimeValue }> {
  const module = reinterpretHostValue<SettingsCommandModule>(
    await loadZentuiModule("settings-command.js"),
  );
  const config = reinterpretHostValue<{ defaultConfig: RuntimeValue }>(
    await loadZentuiModule("config.js"),
  ).defaultConfig;
  return { module, config };
}

function panelDeps(config: RuntimeValue, footerChanges: string[] = []) {
  return {
    sessionLifecycle: { defer: () => () => {} },
    getConfig: () => config,
    setEditorComponent: () => ({ applied: true }),
    setMinimalist: () => {},
    setUserMessagesComponent: () => {},
    setWorkingLineComponent: () => ({ applied: true }),
    setSelectorBordersComponent: () => {},
    setFooterComponent: (patch: { style?: string }) => footerChanges.push(patch.style ?? ""),
    setFooterSegments: () => {},
    setFooterFormat: () => {},
    setResponsiveFooter: () => {},
    setIconMode: () => {},
    setContextStyle: () => {},
    setSeparator: () => {},
    setPathDisplay: () => {},
    setGitBranch: () => {},
    setGitCommit: () => {},
    setGitMetrics: () => {},
    getActiveExtensionStatuses: () => new Map<string, string>(),
    setExtensionStatusDefaultPlacement: () => {},
    setExtensionStatusPlacement: () => {},
    clearExtensionStatusPlacement: () => {},
    setExtensionStatusColorMode: () => {},
    requestRender: () => {},
    settingsListTheme: {
      label: (text: string) => text,
      value: (text: string) => text,
      description: (text: string) => text,
      cursor: "> ",
      hint: (text: string) => text,
    },
  };
}

function openPanel(
  module: SettingsCommandModule,
  config: RuntimeValue,
  sections: PreferencesExtraSection[],
  extra: Record<string, RuntimeValue> = {},
): PanelHandle {
  return module.createZentuiPreferencesComponent(panelDeps(config), {
    ctx: { hasUI: true, ui: { notify: () => {}, theme: noopTheme } },
    tui: { requestRender: () => {} },
    theme: noopTheme,
    extraSections: sections,
    layout: PREFERENCES_LAYOUT,
    hiddenRows: PREFERENCES_HIDDEN_ROWS,
    onOutcome: () => {},
    ...extra,
  });
}

const WIDTH = 160;

/** The focused row's text, without the cursor marker. */
function cursorRow(panel: PanelHandle): string {
  const row = panel.render(WIDTH).find((line) => line.startsWith("> "));
  assert.ok(row, "a row holds the cursor");
  return row.slice(2).trim();
}

function type(panel: PanelHandle, text: string): void {
  for (const char of text) panel.handleInput(char);
}

test(
  "the panel renders the approved tabs with headed, unfocusable groups",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const { module, config } = await zentui();
    await withProviders(async ({ sections }) => {
      const panel = openPanel(module, config, sections);
      try {
        const tabs = panel.render(400)[1] ?? "";
        assert.equal(
          tabs.trim(),
          "Agent / Model / Session / Appearance / Editor / Statusline / Terminal / Tools / Advanced",
          "no stray Pi, Codex, or source tab",
        );
        assert.equal(panel.getActiveSection(), "agent");
        const body = panel.render(WIDTH).join("\n");
        assert.match(body, /^ {2}Behavior/m, "groups open with a heading row");
        // The heading is never focused: the cursor starts on the first row
        // and moving past a group boundary skips its heading.
        assert.match(cursorRow(panel), /^Agent language/);
        panel.handleInput("\x1b[B");
        panel.handleInput("\x1b[B");
        assert.match(cursorRow(panel), /^Agent persona/);
        panel.handleInput("\x1b[B");
        assert.match(cursorRow(panel), /^On usage limit/);
        panel.handleInput("\x1b[A");
        assert.match(cursorRow(panel), /^Agent persona/);
        // Up from the first row wraps to the last row, not to a heading.
        panel.handleInput("\x1b[A");
        panel.handleInput("\x1b[A");
        panel.handleInput("\x1b[A");
        assert.match(cursorRow(panel), /^Remember agents/);

        // Statusline gathers the former Footer, Segments, Git, Working line,
        // and Extensions tabs, and the extension statuses left Appearance.
        for (let step = 0; step < 5; step += 1) panel.handleInput("\x1b[C");
        assert.equal(panel.getActiveSection(), "statusline");
        const statusline = panel.render(WIDTH).join("\n");
        assert.match(statusline, /Footer style/);
        assert.match(cursorRow(panel), /^Footer style/);
        panel.handleInput("\x1b[D");
        panel.handleInput("\x1b[D");
        assert.equal(panel.getActiveSection(), "appearance");
        assert.match(cursorRow(panel), /^Theme/);
      } finally {
        panel.dispose();
      }
    });
  },
);

test(
  "search finds Advanced rows but never hidden ones",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const { module, config } = await zentui();
    await withProviders(async ({ sections }) => {
      const panel = openPanel(module, config, sections);
      try {
        panel.handleInput("/");
        type(panel, "Proxy Responses");
        assert.match(panel.render(WIDTH).join("\n"), /Advanced: Proxy Responses Lite/);
        panel.handleInput("\x1b");

        // The filter is fuzzy, so other rows may match; the hidden row itself
        // must never be a result.
        for (const label of [
          "TUI mode",
          "Fullscreen exit output",
          "Install telemetry",
          "Collapse changelog",
          "Transport",
          "HTTP idle timeout",
          "Cache warming",
          "Execution mode",
          "For compatibility with custom Rust binaries",
        ]) {
          panel.handleInput("/");
          type(panel, label);
          const results = panel.render(WIDTH).slice(4);
          assert.ok(
            results.every((line) => !line.includes(`: ${label}  `)),
            `${label} must stay hidden`,
          );
          panel.handleInput("\x1b");
        }
        // Hidden rows are absent from every tab as well.
        for (let step = 0; step < 9; step += 1) {
          const shown = panel.render(400).join("\n");
          assert.doesNotMatch(shown, /TUI mode|Execution mode|Transport\s{2}/);
          panel.handleInput("\x1b[C");
        }
      } finally {
        panel.dispose();
      }
    });
  },
);

test(
  "a requested section or row opens the tab that now holds it",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const { module, config } = await zentui();
    await withProviders(async ({ sections }) => {
      for (const [initial, expected] of [
        [{ initialSection: "footer" }, "statusline"],
        [{ initialSection: "workingLine" }, "statusline"],
        [{ initialSection: "userMessages" }, "appearance"],
        [{ initialSection: "codex", initialFocusId: "editConfig" }, "tools"],
        [{ initialSection: "model", initialFocusId: "piModel" }, "model"],
        [{ initialSection: "advanced" }, "advanced"],
      ] as const) {
        const panel = openPanel(module, config, sections, initial);
        try {
          assert.equal(panel.getActiveSection(), expected, JSON.stringify(initial));
        } finally {
          panel.dispose();
        }
      }
      const focused = openPanel(module, config, sections, {
        initialSection: "codex",
        initialFocusId: "editConfig",
      });
      try {
        assert.match(cursorRow(focused), /^Edit config/);
      } finally {
        focused.dispose();
      }
    });
  },
);

test(
  "a row the layout does not know falls back to its source's tab",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const { module, config } = await zentui();
    const row = (id: string, label: string): SettingItem => ({
      id,
      label,
      currentValue: "off",
      values: ["off", "on"],
    });
    const section = (
      id: string,
      label: string,
      items: SettingItem[],
      mergeInto?: string,
    ): PreferencesExtraSection => {
      const built: PreferencesExtraSection = {
        id,
        label,
        buildItems: () => items,
        handleChange: () => ({ kind: "update" }),
      };
      if (mergeInto !== undefined) built.mergeInto = mergeInto;
      return built;
    };
    const panel = openPanel(module, config, [
      section("pi", "Pi", [row("theme", "Theme"), row("future-pi-row", "Future Pi row")]),
      section("agent", "Agent", [row("agentLanguage", "Agent language")]),
      section("helper", "Helper", [row("helperRow", "Helper row")], "agent"),
    ]);
    try {
      const tabs = panel.render(400)[1] ?? "";
      assert.match(tabs, /Statusline \/ Pi$/, "an unplaced Pi row keeps a Pi tab after the rest");
      assert.doesNotMatch(tabs, /Model|Session|Terminal|Tools/, "empty tabs are left out");
      const agent = panel.render(WIDTH).join("\n");
      assert.match(agent, /^ {2}Helper\s*\n {2}Helper row/m, "merged leftovers get a heading");
    } finally {
      panel.dispose();
    }
  },
);

test(
  "bare statusline opens the Statusline tab and the toggle form still applies",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const { module, config } = await zentui();
    const footerChanges: string[] = [];
    const deps = panelDeps(config, footerChanges);
    const ctx = { hasUI: true, ui: { notify: () => {}, theme: noopTheme } };
    assert.deepEqual(module.resolveZentuiPreferencesArgs("statusline", deps, ctx), {
      open: true,
      section: "footer",
    });
    assert.deepEqual(module.resolveZentuiPreferencesArgs("statusline toggle", deps, ctx), {
      open: false,
    });
    assert.equal(footerChanges.length, 1, "the toggle applies without opening the dialog");
    const panel = openPanel(module, config, [], { initialSection: "footer" });
    try {
      assert.equal(panel.getActiveSection(), "statusline");
    } finally {
      panel.dispose();
    }
  },
);
