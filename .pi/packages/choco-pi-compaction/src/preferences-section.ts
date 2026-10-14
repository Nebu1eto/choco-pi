/**
 * Preferences rows for the background-compaction master switch and the
 * Anthropic compaction mode.
 *
 * The running main session publishes a provider under a process-global symbol
 * so the profile's Preferences panel can show the rows without importing this
 * package. A change saves the setting and applies it to the running session;
 * changes of either row are applied one at a time, in order.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AnthropicCompactionMode } from "./anthropic/mode.ts";

export const BACKGROUND_COMPACTION_PREFERENCES_PROVIDER_SYMBOL = Symbol.for(
  "choco-pi.background-compaction-preferences-provider",
);

const ROW_ID = "backgroundCompaction.enabled";
const ANTHROPIC_ROW_ID = "compactionAnthropic";
const ANTHROPIC_VALUES: readonly AnthropicCompactionMode[] = ["server-side", "choco-pi"];

/** One Preferences row, shaped like the panel's setting item. */
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

/**
 * The Anthropic compaction mode. `set` reports its own failures and never
 * rejects.
 */
export interface AnthropicModeSwitch {
  /** The mode cached at session start (or by the last applied change). */
  mode(): AnthropicCompactionMode;
  set(mode: AnthropicCompactionMode, ctx: ExtensionContext): Promise<void>;
}

/**
 * The running extension's settings. `setEnabled` reports its own failures and
 * never rejects. The Anthropic row is offered only with `anthropic`.
 */
export interface BackgroundCompactionSwitch {
  enabled(): boolean;
  setEnabled(enabled: boolean, ctx: ExtensionContext): Promise<void>;
  readonly anthropic?: AnthropicModeSwitch | undefined;
}

let changes: Promise<void> = Promise.resolve();

/** Resolves once every change made so far to either row has been saved and applied. */
export async function waitForBackgroundCompactionPreferenceChanges(): Promise<void> {
  await changes;
}

function anthropicModeOf(value: string): AnthropicCompactionMode | undefined {
  return ANTHROPIC_VALUES.find((mode) => mode === value);
}

function buildSection(
  feature: BackgroundCompactionSwitch,
  ctx: ExtensionContext,
): BackgroundCompactionPreferencesSection {
  let shown = feature.enabled();
  const anthropic = feature.anthropic;
  let shownMode = anthropic?.mode();
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
  return {
    id: "backgroundCompaction",
    label: "Background Compaction",
    mergeInto: "agent",
    buildItems: () => [
      {
        id: ROW_ID,
        label: "Background compaction (Experimental)",
        description:
          "Turns on background compaction. Text summaries always run; the native Codex and Anthropic lanes follow the OpenAI and Anthropic compaction rows. A trusted project's background-compaction.json takes precedence.",
        currentValue: shown ? "on" : "off",
        values: ["off", "on"],
      },
      ...anthropicRows(),
    ],
    handleChange: (id, newValue) => {
      if (id === ANTHROPIC_ROW_ID) {
        const mode = anthropicModeOf(newValue);
        if (mode === undefined || anthropic === undefined) return { kind: "rebuild" };
        shownMode = mode;
        // Once applied, the row shows the effective mode: a refused write keeps it unchanged.
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
      // Once applied, the row shows the effective switch: a refused write or a
      // project sidecar keeps it unchanged.
      changes = changes
        .then(() => feature.setEnabled(enabled, ctx))
        .then(() => {
          shown = feature.enabled();
        });
      return { kind: "rebuild" };
    },
  };
}

/** Publish the row for this main session; the returned function removes only this provider. */
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
