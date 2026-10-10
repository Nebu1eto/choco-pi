/**
 * Dependency-free model display helpers shared by every user-facing surface.
 *
 * Keep this module free of imports: other packages (choco-pi-subagents and
 * root extensions) import it by relative path.
 */

/** Display names keyed by Pi provider id. */
interface ProviderLabels {
  readonly [provider: string]: string;
}

const KNOWN_PROVIDER_LABELS: ProviderLabels = {
  anthropic: "Anthropic",
  gemini: "Google",
  google: "Google",
  ollama: "Ollama",
  openai: "OpenAI",
  "openai-codex": "OpenAI",
};

/** Human-readable provider name for prose, e.g. `openai-codex` → `OpenAI`. */
export function formatProviderLabel(provider: string | undefined): string {
  if (!provider) return "Unknown";
  return (
    KNOWN_PROVIDER_LABELS[provider] ??
    provider.replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
  );
}

/** Identifier form of a model reference, e.g. `anthropic/claude-opus`. */
export function formatModelRef(provider: string, id: string): string {
  return `${provider}/${id}`;
}
