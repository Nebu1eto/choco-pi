import type { PreferencesExtraSection, PreferencesOutcomeFocus } from "./agent-preferences.ts";
import { reinterpretHostValue, runtimeTypeOf, type RuntimeValue } from "./runtime-values.ts";

/** Outcome strings the Codex section emits use this prefix. */
export const CODEX_OUTCOME_PREFIX = "codex:";
export const CODEX_PREFERENCES_PROVIDER_SYMBOL = Symbol.for("choco-pi.codex-preferences-provider");

/**
 * Structural view of the Codex settings provider that choco-pi-codex publishes
 * on the global registry. The profile must not import the package, so both
 * sides type this boundary independently over `Symbol.for`.
 */
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

/**
 * Codex sections for the preferences panel, or an empty list when the
 * choco-pi-codex package is not loaded or its sections could not be built.
 */
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
