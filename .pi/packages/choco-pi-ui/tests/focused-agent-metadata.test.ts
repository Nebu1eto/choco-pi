import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ZentuiConfig } from "../extensions/zentui/config.ts";

const FOCUSED_AGENT_RUNTIME_SYMBOL = Symbol.for("choco-pi.subagents.focused-agent-runtime");

type FocusedAgentRuntime = {
  modelId: string;
  modelName: string;
  provider: string;
  thinking: string;
  costTotal?: number | null;
  contextPercent?: number | null;
  contextWindow?: number | null;
};

type FocusedAgentRuntimeSource = {
  current: () => FocusedAgentRuntime | undefined;
};

interface FocusedAgentRuntimeRegistry {
  [FOCUSED_AGENT_RUNTIME_SYMBOL]?: FocusedAgentRuntimeSource;
}

type EditorFrameInput = {
  width: number;
  editorLines: string[];
  uiTheme: Theme;
  config: ZentuiConfig;
  modelMeta: {
    modelLabel: string;
    modelId: string;
    modelName: string;
    providerLabel: string;
    sessionName: string;
  };
  thinkingLevel: string;
};

type UiModule = {
  renderPolishedEditorFrame: (input: EditorFrameInput) => string[];
};

type ConfigModule = {
  defaultConfig: ZentuiConfig;
};

type ZentuiBuildModule = {
  loadZentuiModule: (file: string) => Promise<UiModule | ConfigModule>;
  SKIP_WITHOUT_ZENTUI: false | string;
};

async function loadZentuiBuild(): Promise<ZentuiBuildModule> {
  const buildModuleUrl = new URL("../../../../tests/zentui-build.ts", import.meta.url);
  // SAFETY: The repository helper exports the loader and skip marker declared above.
  return (await import(buildModuleUrl.href)) as ZentuiBuildModule;
}

function runtimeRegistry(): typeof globalThis & FocusedAgentRuntimeRegistry {
  // SAFETY: This test writes only the independently declared optional seam slot.
  return globalThis as typeof globalThis & FocusedAgentRuntimeRegistry;
}

test("focused runtime overrides editor metadata and an empty seam preserves the main runtime", async (t) => {
  const { loadZentuiModule, SKIP_WITHOUT_ZENTUI } = await loadZentuiBuild();
  if (SKIP_WITHOUT_ZENTUI) {
    t.skip(SKIP_WITHOUT_ZENTUI);
    return;
  }
  const uiModule = await loadZentuiModule("ui.js");
  const configModule = await loadZentuiModule("config.js");
  // SAFETY: The compiled modules export the two shapes declared above.
  const { renderPolishedEditorFrame } = uiModule as UiModule;
  // SAFETY: config.js exports the package's complete default ZentuiConfig.
  const { defaultConfig } = configModule as ConfigModule;
  const config = structuredClone(defaultConfig);
  config.components.editor.styles.opencode.metadataFormat = "$model  $provider  $thinking";
  const themeFixture = {
    fg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  };
  // SAFETY: The frame path exercised here calls only fg and bold on the theme.
  const uiTheme = themeFixture as Theme;
  const registry = runtimeRegistry();
  t.after(() => {
    delete registry[FOCUSED_AGENT_RUNTIME_SYMBOL];
  });

  const render = () =>
    renderPolishedEditorFrame({
      width: 80,
      editorLines: ["message"],
      uiTheme,
      config,
      modelMeta: {
        modelLabel: "claude-opus-5",
        modelId: "claude-opus-5",
        modelName: "Claude Opus 5",
        providerLabel: "Anthropic",
        sessionName: "Main",
      },
      thinkingLevel: "high",
    })
      .map(stripTerminalSequences)
      .join("\n");

  delete registry[FOCUSED_AGENT_RUNTIME_SYMBOL];
  const absent = render();
  assert.match(absent, /claude-opus-5  Anthropic  high/);

  registry[FOCUSED_AGENT_RUNTIME_SYMBOL] = { current: () => undefined };
  assert.equal(
    render(),
    absent,
    "an empty publisher leaves the main metadata byte-for-byte intact",
  );

  const child: FocusedAgentRuntime = {
    modelId: "gpt-5.6-terra",
    modelName: "GPT-5.6 Terra",
    provider: "openai-codex",
    thinking: "medium",
  };
  registry[FOCUSED_AGENT_RUNTIME_SYMBOL] = { current: () => child };
  const focused = render();
  assert.match(focused, /gpt-5\.6-terra  OpenAI  medium/);
  assert.doesNotMatch(focused, /claude-opus-5|Anthropic|high/);

  child.modelId = "claude-sonnet-5";
  child.modelName = "Claude Sonnet 5";
  child.provider = "anthropic";
  child.thinking = "low";
  assert.match(render(), /claude-sonnet-5  Anthropic  low/);

  delete registry[FOCUSED_AGENT_RUNTIME_SYMBOL];
  assert.equal(render(), absent, "removing the publisher immediately restores main metadata");
});
