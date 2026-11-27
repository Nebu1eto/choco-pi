import type { PreferencesExtraSection } from "./agent-preferences.ts";
import { reinterpretHostValue, runtimeTypeOf, type RuntimeValue } from "./runtime-values.ts";

export const WEB_SEARCH_PREFERENCES_PROVIDER_SYMBOL = Symbol.for(
  "choco-pi.web-search-preferences-provider",
);

interface WebSearchPreferencesProvider {
  buildSections: (ctx: RuntimeValue) => PreferencesExtraSection[];
}

function isWebSearchPreferencesProvider(
  candidate: RuntimeValue,
): candidate is WebSearchPreferencesProvider {
  if (runtimeTypeOf(candidate) !== "object") return false;
  const record = reinterpretHostValue<Record<string, RuntimeValue>>(candidate);
  return runtimeTypeOf(record.buildSections) === "function";
}

export function getWebSearchPreferencesProvider(): WebSearchPreferencesProvider | undefined {
  const candidate =
    reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis)[
      WEB_SEARCH_PREFERENCES_PROVIDER_SYMBOL
    ];
  return isWebSearchPreferencesProvider(candidate) ? candidate : undefined;
}

export function buildWebSearchPreferencesSections(ctx: RuntimeValue): PreferencesExtraSection[] {
  const provider = getWebSearchPreferencesProvider();
  if (!provider) return [];
  try {
    const sections = provider.buildSections(ctx);
    return Array.isArray(sections) ? sections : [];
  } catch {
    return [];
  }
}
