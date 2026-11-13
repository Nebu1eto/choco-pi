import type { PreferencesExtraSection } from "./agent-preferences.ts";
import { reinterpretHostValue, runtimeTypeOf, type RuntimeValue } from "./runtime-values.ts";

/** Published by choco-pi-compaction while a main session runs. */
export const BACKGROUND_COMPACTION_PREFERENCES_PROVIDER_SYMBOL = Symbol.for(
  "choco-pi.background-compaction-preferences-provider",
);

interface BackgroundCompactionPreferencesProvider {
  buildSections: (ctx: RuntimeValue) => PreferencesExtraSection[];
}

function isBackgroundCompactionPreferencesProvider(
  candidate: RuntimeValue,
): candidate is BackgroundCompactionPreferencesProvider {
  if (runtimeTypeOf(candidate) !== "object") return false;
  const record = reinterpretHostValue<Record<string, RuntimeValue>>(candidate);
  return runtimeTypeOf(record.buildSections) === "function";
}

/** The background-compaction row, merged into the agent section; none when the extension is absent. */
export function buildBackgroundCompactionPreferencesSections(
  ctx: RuntimeValue,
): PreferencesExtraSection[] {
  const candidate =
    reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis)[
      BACKGROUND_COMPACTION_PREFERENCES_PROVIDER_SYMBOL
    ];
  if (!isBackgroundCompactionPreferencesProvider(candidate)) return [];
  try {
    const sections = candidate.buildSections(ctx);
    return Array.isArray(sections) ? sections : [];
  } catch {
    return [];
  }
}
