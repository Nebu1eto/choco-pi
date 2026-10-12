/**
 * Preferences row for the background-compaction master switch.
 *
 * The running main session publishes a provider under a process-global symbol
 * so the profile's Preferences panel can show the row without importing this
 * package. A change saves the switch to the global sidecar and applies it to
 * the running session; changes are applied one at a time, in order.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const BACKGROUND_COMPACTION_PREFERENCES_PROVIDER_SYMBOL = Symbol.for(
  "choco-pi.background-compaction-preferences-provider",
);

const ROW_ID = "backgroundCompaction.enabled";

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

/** The running extension's switch. `setEnabled` reports its own failures and never rejects. */
export interface BackgroundCompactionSwitch {
  enabled(): boolean;
  setEnabled(enabled: boolean, ctx: ExtensionContext): Promise<void>;
}

let changes: Promise<void> = Promise.resolve();

/** Resolves once every change made so far has been saved and applied. */
export async function waitForBackgroundCompactionPreferenceChanges(): Promise<void> {
  await changes;
}

function buildSection(
  feature: BackgroundCompactionSwitch,
  ctx: ExtensionContext,
): BackgroundCompactionPreferencesSection {
  let shown = feature.enabled();
  return {
    id: "backgroundCompaction",
    label: "Background Compaction",
    mergeInto: "agent",
    buildItems: () => [
      {
        id: ROW_ID,
        label: "Background compaction (Experimental)",
        description:
          "Turns on text background compaction; native Codex/Anthropic lanes are switched in background-compaction.json. A trusted project's file takes precedence.",
        currentValue: shown ? "on" : "off",
        values: ["off", "on"],
      },
    ],
    handleChange: (id, newValue) => {
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
