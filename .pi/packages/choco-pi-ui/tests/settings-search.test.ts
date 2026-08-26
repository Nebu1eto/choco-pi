import assert from "node:assert/strict";
import test from "node:test";
// zentui ships TypeScript parameter properties that Node's strip-only mode
// cannot parse, so tests load it through the repository's shared compile
// helper rather than importing the source file directly.
import { loadZentuiModule, SKIP_WITHOUT_ZENTUI } from "../../../../tests/zentui-build.ts";
import {
  reinterpretHostValue,
  type RuntimeValue,
} from "../../../../.pi/extensions/lib/runtime-values.ts";

type PreferencesSectionChange =
  | { kind: "update" }
  | { kind: "rebuild" }
  | { kind: "outcome"; outcome: string };

type SettingItem = {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];
  submenu?: unknown;
};

type ExtraSection = {
  id: string;
  label: string;
  mergeInto?: string;
  buildItems: () => SettingItem[];
  handleChange: (id: string, newValue: string) => PreferencesSectionChange;
};

type PanelHandle = {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
  dispose: () => void;
  getActiveSection: () => string;
  hasOpenSubmenu: () => boolean;
  hasActiveSearch: () => boolean;
};

type SettingsCommandModule = {
  createZentuiPreferencesComponent: (deps: RuntimeValue, options: RuntimeValue) => PanelHandle;
};

async function settingsModule(): Promise<SettingsCommandModule> {
  return reinterpretHostValue<SettingsCommandModule>(await loadZentuiModule("settings-command.js"));
}

async function zentuiConfig(): Promise<RuntimeValue> {
  const config = reinterpretHostValue<{ defaultConfig: RuntimeValue }>(
    await loadZentuiModule("config.js"),
  );
  return config.defaultConfig;
}

const noopTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  fgRgb: (text: string) => text,
  bg: (_color: string, text: string) => text,
};

function makeDeps(config: RuntimeValue) {
  const deps = {
    sessionLifecycle: { defer: () => () => {} },
    getConfig: () => config,
    setEditorComponent: () => ({ applied: true }),
    setMinimalist: () => {},
    setUserMessagesComponent: () => {},
    setWorkingLineComponent: () => ({ applied: true }),
    setSelectorBordersComponent: () => {},
    setFooterComponent: () => {},
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
  return { deps };
}

function makePanel(
  module: SettingsCommandModule,
  config: RuntimeValue,
  extraSections: ExtraSection[],
) {
  const { deps } = makeDeps(config);
  const notified: string[] = [];
  const outcomes: string[] = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => notified.push(message), theme: noopTheme },
  };
  const panel = module.createZentuiPreferencesComponent(deps, {
    ctx,
    tui: { requestRender: () => {} },
    theme: noopTheme,
    extraSections,
    onOutcome: (outcome: string) => outcomes.push(outcome),
  });
  return { ctx, notified, outcomes, panel };
}

const TEXT_WIDTH = 90;

function type(panel: PanelHandle, text: string): void {
  for (const char of text) panel.handleInput(char);
}

test(
  "search finds rows from every section and changes them in place",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const module = await settingsModule();
    const config = await zentuiConfig();

    const changes: [string, string][] = [];
    const sessionSection: ExtraSection = {
      id: "session",
      label: "Session",
      buildItems: () => [
        {
          id: "cache-miss-notices",
          label: "Cache miss notices",
          currentValue: "false",
          values: ["true", "false"],
        },
      ],
      handleChange: (id, newValue) => {
        changes.push([id, newValue]);
        return { kind: "update" };
      },
    };
    const otherSection: ExtraSection = {
      id: "custom",
      label: "Custom",
      buildItems: () => [
        {
          id: "customThing",
          label: "Custom thing",
          currentValue: "on",
          values: ["on", "off"],
        },
      ],
      handleChange: () => ({ kind: "update" }),
    };

    const { panel } = makePanel(module, config, [sessionSection, otherSection]);
    try {
      assert.equal(panel.hasActiveSearch(), false);
      const before = panel.render(TEXT_WIDTH).join("\n");
      assert.match(before, /\/ to search/, "the section hint advertises the search key");
      assert.doesNotMatch(before, /Cache miss notices/);

      panel.handleInput("/");
      assert.equal(panel.hasActiveSearch(), true);

      type(panel, "cache");
      const results = panel.render(TEXT_WIDTH).join("\n");
      // A row from the Session tab is found while the Appearance tab is active.
      assert.match(results, /Session: Cache miss notices/);
      // Rows outside the query stay hidden, from any tab.
      assert.doesNotMatch(results, /Custom: Custom thing/);
      assert.match(results, /Type to filter/, "the search footer replaces the section hint");

      // The selected hit changes in place; its owner sees the new value.
      panel.handleInput("\r");
      assert.deepEqual(changes, [["cache-miss-notices", "true"]]);
      assert.match(panel.render(TEXT_WIDTH).join("\n"), /Cache miss notices\s+true/);

      // Esc leaves the search and returns to the section view without closing.
      panel.handleInput("\x1b");
      assert.equal(panel.hasActiveSearch(), false);
      assert.match(panel.render(TEXT_WIDTH).join("\n"), /\/ to search/);
    } finally {
      panel.dispose();
    }
  },
);

test("Esc while searching never closes the panel", { skip: SKIP_WITHOUT_ZENTUI }, async () => {
  const module = await settingsModule();
  const config = await zentuiConfig();
  const { outcomes, panel } = makePanel(module, config, []);
  try {
    panel.handleInput("/");
    type(panel, "gone");
    panel.handleInput("\x1b");
    assert.deepEqual(outcomes, []);
    assert.equal(panel.hasActiveSearch(), false);
  } finally {
    panel.dispose();
  }
});
