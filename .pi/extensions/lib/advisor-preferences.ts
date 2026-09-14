import type { PreferencesExtraSection } from "./agent-preferences.ts";
import { reinterpretHostValue, runtimeTypeOf, type RuntimeValue } from "./runtime-values.ts";

export const ADVISOR_PREFERENCES_PROVIDER_SYMBOL = Symbol.for(
  "choco-pi.advisor-preferences-provider",
);

interface AdvisorPreferencesProvider {
  buildSections: (ctx: RuntimeValue) => PreferencesExtraSection[];
}

function isAdvisorPreferencesProvider(
  candidate: RuntimeValue,
): candidate is AdvisorPreferencesProvider {
  if (runtimeTypeOf(candidate) !== "object") return false;
  const record = reinterpretHostValue<Record<string, RuntimeValue>>(candidate);
  return runtimeTypeOf(record.buildSections) === "function";
}

export function getAdvisorPreferencesProvider(): AdvisorPreferencesProvider | undefined {
  const candidate =
    reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis)[
      ADVISOR_PREFERENCES_PROVIDER_SYMBOL
    ];
  return isAdvisorPreferencesProvider(candidate) ? candidate : undefined;
}

export function buildAdvisorPreferencesSections(ctx: RuntimeValue): PreferencesExtraSection[] {
  const provider = getAdvisorPreferencesProvider();
  if (!provider) return [];
  try {
    const sections = provider.buildSections(ctx);
    return Array.isArray(sections) ? sections : [];
  } catch {
    return [];
  }
}
