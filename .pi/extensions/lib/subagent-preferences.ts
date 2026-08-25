import type { PreferencesExtraSection } from "./agent-preferences.ts";
import { reinterpretHostValue, runtimeTypeOf, type RuntimeValue } from "./runtime-values.ts";

export const SUBAGENTS_PREFERENCES_PROVIDER_SYMBOL = Symbol.for(
  "choco-pi.subagents-preferences-provider",
);

interface SubagentPreferencesProvider {
  buildSections: (ctx: RuntimeValue) => PreferencesExtraSection[];
}

function isSubagentPreferencesProvider(
  candidate: RuntimeValue,
): candidate is SubagentPreferencesProvider {
  if (runtimeTypeOf(candidate) !== "object") return false;
  const record = reinterpretHostValue<Record<string, RuntimeValue>>(candidate);
  return runtimeTypeOf(record.buildSections) === "function";
}

export function getSubagentPreferencesProvider(): SubagentPreferencesProvider | undefined {
  const candidate =
    reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis)[
      SUBAGENTS_PREFERENCES_PROVIDER_SYMBOL
    ];
  return isSubagentPreferencesProvider(candidate) ? candidate : undefined;
}

export function buildSubagentPreferencesSections(ctx: RuntimeValue): PreferencesExtraSection[] {
  const provider = getSubagentPreferencesProvider();
  if (!provider) return [];
  try {
    const sections = provider.buildSections(ctx);
    return Array.isArray(sections) ? sections : [];
  } catch {
    return [];
  }
}
