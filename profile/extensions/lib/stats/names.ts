import { formatProviderLabel } from "../../../../packages/choco-pi-ui/extensions/zentui/model-display.ts";

export type ModelNameLookup = (provider: string, modelId: string) => string | undefined;

const PROVIDER_LABELS = new Map<string, string>([
  ["openai-codex", "OpenAI Codex"],
  ["xai", "xAI"],
  ["synthetic", "Synthetic"],
]);

export function providerDisplayName(provider: string): string {
  return PROVIDER_LABELS.get(provider) ?? formatProviderLabel(provider);
}

const ACRONYMS: ReadonlySet<string> = new Set(["gpt", "o1", "o3", "o4", "llm", "ai"]);

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

export function modelDisplayName(
  provider: string,
  modelId: string,
  lookup?: ModelNameLookup,
): string {
  return lookup?.(provider, modelId) ?? formatModelId(modelId);
}

export function modelRowLabel(provider: string, modelId: string, lookup?: ModelNameLookup): string {
  return `${modelDisplayName(provider, modelId, lookup)} (${providerDisplayName(provider)})`;
}
