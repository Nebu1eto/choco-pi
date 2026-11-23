import type { PreferencesExtraSection, PreferencesOutcomeFocus } from "./agent-preferences.ts";
import { reinterpretHostValue, runtimeTypeOf, type RuntimeValue } from "./runtime-values.ts";

export const CODEX_OUTCOME_PREFIX = "codex:";
export const CODEX_PREFERENCES_PROVIDER_SYMBOL = Symbol.for("choco-pi.codex-preferences-provider");

export interface CodexPreferencesProvider {
  buildSections: (ctx: RuntimeValue) => PreferencesExtraSection[];
  runOutcome: (outcome: string, ctx: RuntimeValue) => Promise<PreferencesOutcomeFocus | undefined>;
}

function isCodexPreferencesProvider(
  candidate: RuntimeValue,
): candidate is CodexPreferencesProvider {
  if (runtimeTypeOf(candidate) !== "object") return false;
  const record = reinterpretHostValue<Record<string, RuntimeValue>>(candidate);
  return (
    runtimeTypeOf(record.buildSections) === "function" &&
    runtimeTypeOf(record.runOutcome) === "function"
  );
}

export function getCodexPreferencesProvider(): CodexPreferencesProvider | undefined {
  const candidate =
    reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis)[
      CODEX_PREFERENCES_PROVIDER_SYMBOL
    ];
  return isCodexPreferencesProvider(candidate) ? candidate : undefined;
}

export function buildCodexPreferencesSections(ctx: RuntimeValue): PreferencesExtraSection[] {
  const provider = getCodexPreferencesProvider();
  if (!provider) return [];
  try {
    const sections = provider.buildSections(ctx);
    return Array.isArray(sections) ? sections : [];
  } catch {
    return [];
  }
}
