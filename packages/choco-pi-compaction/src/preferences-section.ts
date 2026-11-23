import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AnthropicCompactionMode } from "./anthropic/mode.ts";
import type { XaiCompactionMode } from "./xai/mode.ts";

export const BACKGROUND_COMPACTION_PREFERENCES_PROVIDER_SYMBOL = Symbol.for(
  "choco-pi.background-compaction-preferences-provider",
);

const ROW_ID = "backgroundCompaction.enabled";
const ANTHROPIC_ROW_ID = "compactionAnthropic";
const ANTHROPIC_VALUES: readonly AnthropicCompactionMode[] = ["server-side", "choco-pi"];
const XAI_ROW_ID = "compactionXai";
const XAI_VALUES: readonly XaiCompactionMode[] = ["server-side", "choco-pi"];

export interface BackgroundCompactionPreferenceItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly currentValue: string;
  readonly values: string[];
}

export interface BackgroundCompactionPreferencesSection {
  readonly id: "backgroundCompaction";
  readonly label: "Background Compaction";
  readonly mergeInto: "agent";
  buildItems(): BackgroundCompactionPreferenceItem[];
  handleChange(id: string, newValue: string): { kind: "rebuild" };
}

export interface BackgroundCompactionPreferencesProvider {
  buildSections(ctx: ExtensionContext): BackgroundCompactionPreferencesSection[];
}

export interface AnthropicModeSwitch {
  mode(): AnthropicCompactionMode;
  set(mode: AnthropicCompactionMode, ctx: ExtensionContext): Promise<void>;
}

export interface XaiModeSwitch {
  mode(): XaiCompactionMode;
  set(mode: XaiCompactionMode, ctx: ExtensionContext): Promise<void>;
}

export interface BackgroundCompactionSwitch {
  enabled(): boolean;
  setEnabled(enabled: boolean, ctx: ExtensionContext): Promise<void>;
  readonly anthropic?: AnthropicModeSwitch | undefined;
  readonly xai?: XaiModeSwitch | undefined;
}

let changes: Promise<void> = Promise.resolve();

export async function waitForBackgroundCompactionPreferenceChanges(): Promise<void> {
  await changes;
}

function anthropicModeOf(value: string): AnthropicCompactionMode | undefined {
  return ANTHROPIC_VALUES.find((mode) => mode === value);
}

function xaiModeOf(value: string): XaiCompactionMode | undefined {
  return XAI_VALUES.find((mode) => mode === value);
}

function buildSection(
  feature: BackgroundCompactionSwitch,
  ctx: ExtensionContext,
): BackgroundCompactionPreferencesSection {
  let shown = feature.enabled();
  const anthropic = feature.anthropic;
  let shownMode = anthropic?.mode();
  const xai = feature.xai;
  let shownXaiMode = xai?.mode();
  const anthropicRows = (): BackgroundCompactionPreferenceItem[] =>
    shownMode === undefined
      ? []
      : [
          {
            id: ANTHROPIC_ROW_ID,
            label: "Anthropic compaction",
            description:
              "server-side uses Anthropic's on-demand compaction (OAuth, supported Claude models) and falls back to choco-pi's local summary on failure; choco-pi summarizes locally.",
            currentValue: shownMode,
            values: [...ANTHROPIC_VALUES],
          },
        ];
  const xaiRows = (): BackgroundCompactionPreferenceItem[] =>
    shownXaiMode === undefined
      ? []
      : [
          {
            id: XAI_ROW_ID,
            label: "xAI compaction",
            description:
              "server-side uses xAI's /responses/compact (Grok models on api.x.ai) and falls back to choco-pi's local summary on failure; choco-pi summarizes locally.",
            currentValue: shownXaiMode,
            values: [...XAI_VALUES],
          },
        ];
  return {
    id: "backgroundCompaction",
    label: "Background Compaction",
    mergeInto: "agent",
    buildItems: () => [
      {
        id: ROW_ID,
        label: "Background compaction",
        description:
          "Turns on background compaction. Text summaries always run; the native Codex and Anthropic lanes follow the OpenAI and Anthropic compaction rows. A trusted project's background-compaction.json takes precedence.",
        currentValue: shown ? "on" : "off",
        values: ["off", "on"],
      },
      ...anthropicRows(),
      ...xaiRows(),
    ],
    handleChange: (id, newValue) => {
      if (id === XAI_ROW_ID) {
        const mode = xaiModeOf(newValue);
        if (mode === undefined || xai === undefined) return { kind: "rebuild" };
        shownXaiMode = mode;
        changes = changes
          .then(() => xai.set(mode, ctx))
          .then(() => {
            shownXaiMode = xai.mode();
            shown = feature.enabled();
          });
        return { kind: "rebuild" };
      }
      if (id === ANTHROPIC_ROW_ID) {
        const mode = anthropicModeOf(newValue);
        if (mode === undefined || anthropic === undefined) return { kind: "rebuild" };
        shownMode = mode;
        changes = changes
          .then(() => anthropic.set(mode, ctx))
          .then(() => {
            shownMode = anthropic.mode();
            shown = feature.enabled();
          });
        return { kind: "rebuild" };
      }
      if (id !== ROW_ID || (newValue !== "on" && newValue !== "off")) return { kind: "rebuild" };
      const enabled = newValue === "on";
      shown = enabled;
      changes = changes
        .then(() => feature.setEnabled(enabled, ctx))
        .then(() => {
          shown = feature.enabled();
        });
      return { kind: "rebuild" };
    },
  };
}

export function publishBackgroundCompactionPreferences(
  feature: BackgroundCompactionSwitch,
): () => void {
  const provider: BackgroundCompactionPreferencesProvider = {
    buildSections: (ctx) => [buildSection(feature, ctx)],
  };
  Object.defineProperty(globalThis, BACKGROUND_COMPACTION_PREFERENCES_PROVIDER_SYMBOL, {
    value: provider,
    configurable: true,
  });
  return () => {
    const current: unknown = Object.getOwnPropertyDescriptor(
      globalThis,
      BACKGROUND_COMPACTION_PREFERENCES_PROVIDER_SYMBOL,
    )?.value;
    if (current === provider) {
      Reflect.deleteProperty(globalThis, BACKGROUND_COMPACTION_PREFERENCES_PROVIDER_SYMBOL);
    }
  };
}
