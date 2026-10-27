import { formatProviderLabel } from "../../../packages/choco-pi-ui/extensions/zentui/model-display.ts";

/**
 * Friendly names for the rows of the Statistics tab.
 *
 * The model registry knows a display name for every model it lists; models
 * that only appear in old logs (renamed, removed, or from another profile)
 * fall back to a formatter that title-cases the id. Provider labels come from
 * the shared zentui helper so every surface agrees on them.
 */

/** A registry-style lookup of a model's display name. */
export type ModelNameLookup = (provider: string, modelId: string) => string | undefined;

/** Provider ids whose label the shared helper does not know in the form the vendor uses. */
const PROVIDER_LABELS = new Map<string, string>([
  ["openai-codex", "OpenAI Codex"],
  ["xai", "xAI"],
  ["synthetic", "Synthetic"],
]);

export function providerDisplayName(provider: string): string {
  return PROVIDER_LABELS.get(provider) ?? formatProviderLabel(provider);
}

/** Words that stay upper-case in a title-cased model id. */
const ACRONYMS: ReadonlySet<string> = new Set(["gpt", "o1", "o3", "o4", "llm", "ai"]);

/**
 * Title-case a model id: `claude-opus-5-5` → `Claude Opus 5.5`, `gpt-6-astra`
 * → `GPT-6 Astra`, `grok-4.7` → `Grok 4.7`. Dashes between digits become a
 * dot; a dash after an acronym before a digit stays, as vendors write it.
 */
export function formatModelId(id: string): string {
  const parts = id.split("-");
  const out: string[] = [];
  for (const part of parts) {
    const previous = out[out.length - 1];
    if (/^\d+$/.test(part) && previous !== undefined && /\d$/.test(previous)) {
      out[out.length - 1] = `${previous}.${part}`;
      continue;
    }
    if (/^\d/.test(part) && previous !== undefined && ACRONYMS.has(previous.toLowerCase())) {
      out[out.length - 1] = `${previous}-${part}`;
      continue;
    }
    out.push(
      ACRONYMS.has(part.toLowerCase())
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1),
    );
  }
  return out.join(" ");
}

/** The model's friendly name without its provider. */
export function modelDisplayName(
  provider: string,
  modelId: string,
  lookup?: ModelNameLookup,
): string {
  return lookup?.(provider, modelId) ?? formatModelId(modelId);
}

/**
 * The full row label, `Claude Opus 5.5 (Anthropic)`. Callers that must shorten
 * it drop the parenthesised provider first; see `fitLabel`.
 */
export function modelRowLabel(provider: string, modelId: string, lookup?: ModelNameLookup): string {
  return `${modelDisplayName(provider, modelId, lookup)} (${providerDisplayName(provider)})`;
}
