import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { FooterState } from "../extensions/zentui/state.ts";

const FOCUSED_AGENT_RUNTIME_SYMBOL = Symbol.for("choco-pi.subagents.focused-agent-runtime");

type FocusedRuntime = {
  modelId: string;
  modelName: string;
  provider: string;
  thinking: string;
  costTotal?: number | null;
  contextPercent?: number | null;
  contextWindow?: number | null;
};

type RuntimeRegistry = {
  [FOCUSED_AGENT_RUNTIME_SYMBOL]?: { current: () => FocusedRuntime | undefined };
};

type FooterFactory = (
  tui: { requestRender: () => void },
  theme: Theme,
  footerData: {
    onBranchChange: (callback: () => void) => () => void;
    getExtensionStatuses: () => ReadonlyMap<string, string>;
  },
) => { render: (width: number) => string[] };

type FooterContextFixture = {
  cwd: string;
  model: { contextWindow: number };
  getContextUsage: () => { percent: number; contextWindow: number };
  sessionManager: { getSessionName: () => string };
  ui: { setFooter: (factory: FooterFactory) => void };
};
type FooterModule = {
  installFooter: (
    ctx: FooterContextFixture,
    state: FooterState,
    getConfig: () => ConfigModule["defaultConfig"],
    hooks: {
      setRequestRender: (fn: (() => void) | undefined) => void;
      scheduleProjectRefresh: (ctx: FooterContextFixture) => void;
      getLiveContext: () => { tokens: number };
    },
  ) => void;
};
type ConfigModule = Pick<typeof import("../extensions/zentui/config.ts"), "defaultConfig">;
type MinimalBaseEditor = {
  render: (width: number) => string[];
  getText: () => string;
  setText: (text: string) => void;
  handleInput: (data: string) => void;
};
type UiModule = {
  WrappedPolishedEditor: new (
    base: MinimalBaseEditor,
    theme: Theme,
    getConfig: () => ConfigModule["defaultConfig"],
    getModelMeta: () => { modelLabel: string; providerLabel: string },
    getThinkingLevel: () => string,
    getMinimalistMetadata: () => {
      cwd: string;
      costLabel: string;
      contextPercent: number;
      contextWindow: number;
    },
  ) => { render: (width: number) => string[] };
};
type StateModule = Pick<typeof import("../extensions/zentui/state.ts"), "createInitialState">;
type GitModule = Pick<typeof import("../extensions/zentui/git.ts"), "emptyGitStatus">;
type ZentuiTestModule = FooterModule | ConfigModule | UiModule | StateModule | GitModule;
type BuildModule = {
  loadZentuiModule: (file: string) => Promise<ZentuiTestModule>;
  SKIP_WITHOUT_ZENTUI: false | string;
};

async function loadBuild(): Promise<BuildModule> {
  const url = new URL("../../../../tests/zentui-build.ts", import.meta.url);
  // SAFETY: The repository helper exports the loader and skip marker declared above.
  return (await import(url.href)) as BuildModule;
}

function registry(): typeof globalThis & RuntimeRegistry {
  // SAFETY: This test mutates only the optional cross-extension symbol seam.
  return globalThis as typeof globalThis & RuntimeRegistry;
}

test("footer cost and context follow focus on every render without main fallback", async (t) => {
  const { loadZentuiModule, SKIP_WITHOUT_ZENTUI } = await loadBuild();
  if (SKIP_WITHOUT_ZENTUI) {
    t.skip(SKIP_WITHOUT_ZENTUI);
    return;
  }
  const [footerRaw, configRaw, stateRaw, gitRaw] = await Promise.all([
    loadZentuiModule("footer.js"),
    loadZentuiModule("config.js"),
    loadZentuiModule("state.js"),
    loadZentuiModule("git.js"),
  ]);
  // SAFETY: footer.js is requested explicitly and exports installFooter.
  const { installFooter } = footerRaw as FooterModule;
  // SAFETY: config.js is requested explicitly and exports defaultConfig.
  const { defaultConfig } = configRaw as ConfigModule;
  // SAFETY: state.js is requested explicitly and exports createInitialState.
  const { createInitialState } = stateRaw as StateModule;
  // SAFETY: git.js is requested explicitly and exports emptyGitStatus.
  const { emptyGitStatus } = gitRaw as GitModule;

  const config = structuredClone(defaultConfig);
  const starship = config.components.footer.styles.starship;
  starship.responsive = false;
  starship.contextStyle = "text+gauge";
  config.colors.contextNormal = "success";
  config.colors.contextWarning = "warning";
  config.colors.contextError = "error";
  starship.segments = {
    cwd: false,
    sessionName: false,
    gitBranch: false,
    gitStatus: false,
    gitCounts: false,
    gitCommit: false,
    gitMetrics: false,
    runtime: false,
    modelInfo: false,
    context: true,
    tokens: false,
    cost: true,
    sessionDuration: false,
    username: false,
    time: false,
    os: false,
    packageVersion: false,
  };

  const state: FooterState = createInitialState(emptyGitStatus());
  state.costLabel = "$9.999";
  state.subscription = true;
  let footerFactory: FooterFactory | undefined;
  const context = {
    cwd: "/repo",
    model: { contextWindow: 1_000 },
    getContextUsage: () => ({ percent: 25, contextWindow: 1_000 }),
    sessionManager: { getSessionName: () => "Main" },
    ui: {
      setFooter: (factory: FooterFactory) => {
        footerFactory = factory;
      },
    },
  };
  installFooter(context, state, () => config, {
    setRequestRender: () => {},
    scheduleProjectRefresh: () => {},
    getLiveContext: () => ({ tokens: 800 }),
  });
  assert.ok(footerFactory);
  const themeFixture = {
    fg: (role: string, text: string) => `${role}[${text}]`,
    bold: (text: string) => text,
  };
  // SAFETY: Footer rendering exercises only fg/bold in this identity theme fixture.
  const theme = themeFixture as Theme;
  const component = footerFactory({ requestRender: () => {} }, theme, {
    onBranchChange: () => () => {},
    getExtensionStatuses: () => new Map(),
  });
  const render = () => component.render(100).map(stripTerminalSequences).join("\n");
  const seam = registry();
  t.after(() => {
    delete seam[FOCUSED_AGENT_RUNTIME_SYMBOL];
  });

  delete seam[FOCUSED_AGENT_RUNTIME_SYMBOL];
  const main = render();
  assert.match(main, /warning\[.*80\.0%\/1\.0k.*\]/);
  assert.match(main, /\$9\.999/);
  assert.match(main, /\(sub\)/);

  const child: FocusedRuntime = {
    modelId: "child",
    modelName: "Child",
    provider: "openai",
    thinking: "medium",
    costTotal: 1.25,
    contextPercent: 40,
    contextWindow: 2_000,
  };
  seam[FOCUSED_AGENT_RUNTIME_SYMBOL] = { current: () => child };
  const focused = render();
  assert.match(focused, /success\[.*40\.0%\/2\.0k.*\]/);
  assert.match(focused, /\$1\.250/);
  assert.doesNotMatch(focused, /80\.0%|\$9\.999|\(sub\)/);

  child.costTotal = Number.NaN;
  child.contextPercent = null;
  child.contextWindow = 3_000;
  const mutated = render();
  assert.match(mutated, /\?\/3\.0k/);
  assert.doesNotMatch(mutated, /\$1\.250|\$9\.999|80\.0%/);

  starship.format = "$context :: $cost";
  const custom = render();
  assert.match(custom, /\?\/3\.0k/);
  assert.doesNotMatch(custom, /\$9\.999/);

  delete seam[FOCUSED_AGENT_RUNTIME_SYMBOL];
  const restored = render();
  assert.match(restored, /80\.0%\/1\.0k/);
  assert.match(restored, /\$9\.999/);
  assert.doesNotMatch(restored, /\?\/3\.0k|\$1\.250/);
});

test("wrapped minimalist editor selects focused usage on each render", async (t) => {
  const { loadZentuiModule, SKIP_WITHOUT_ZENTUI } = await loadBuild();
  if (SKIP_WITHOUT_ZENTUI) {
    t.skip(SKIP_WITHOUT_ZENTUI);
    return;
  }
  const [uiRaw, configRaw] = await Promise.all([
    loadZentuiModule("ui.js"),
    loadZentuiModule("config.js"),
  ]);
  // SAFETY: ui.js is requested explicitly and exports WrappedPolishedEditor.
  const { WrappedPolishedEditor } = uiRaw as UiModule;
  // SAFETY: config.js is requested explicitly and exports defaultConfig.
  const { defaultConfig } = configRaw as ConfigModule;
  const config = structuredClone(defaultConfig);
  config.components.editor.style = "minimalist";
  config.components.editor.styles.minimalist.contextFormat = "percent-total";
  const themeFixture = {
    fg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  };
  // SAFETY: Minimalist rendering exercises only fg/bold in this identity theme fixture.
  const theme = themeFixture as Theme;
  let text = "message";
  const base: MinimalBaseEditor = {
    render: (width) => ["─".repeat(width), text, "─".repeat(width)],
    getText: () => text,
    setText: (value) => {
      text = value;
    },
    handleInput: () => {},
  };
  const editor = new WrappedPolishedEditor(
    base,
    theme,
    () => config,
    () => ({ modelLabel: "main", providerLabel: "Main" }),
    () => "high",
    () => ({
      cwd: "/repo",
      costLabel: "$9.999",
      contextPercent: 80,
      contextWindow: 1_000,
    }),
  );
  const render = () => editor.render(100).map(stripTerminalSequences).join("\n");
  const seam = registry();
  t.after(() => {
    delete seam[FOCUSED_AGENT_RUNTIME_SYMBOL];
  });

  delete seam[FOCUSED_AGENT_RUNTIME_SYMBOL];
  assert.match(render(), /\$9\.999.*80%\/1\.0k/);

  const child: FocusedRuntime = {
    modelId: "child",
    modelName: "Child",
    provider: "openai",
    thinking: "low",
    costTotal: 0.5,
    contextPercent: 30,
    contextWindow: 2_000,
  };
  seam[FOCUSED_AGENT_RUNTIME_SYMBOL] = { current: () => child };
  assert.match(render(), /\$0\.500.*30%\/2\.0k/);

  child.costTotal = null;
  child.contextPercent = null;
  assert.doesNotMatch(render(), /\$9\.999|80%\/1\.0k|\$0\.500/);

  delete seam[FOCUSED_AGENT_RUNTIME_SYMBOL];
  assert.match(render(), /\$9\.999.*80%\/1\.0k/);
});
