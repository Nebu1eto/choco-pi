const KNOWN_PREFIXES: [prefix: string, provider: string][] = [
  ["claude-", "anthropic"],
  ["gpt-", "openai"],
  ["o1-", "openai"],
  ["o3-", "openai"],
  ["gemini-", "google"],
  ["llama-", "meta"],
  ["mistral-", "mistral"],
  ["mixtral-", "mistral"],
  ["command-", "cohere"],
];

export function deriveProviderFromModelId(modelId: string | undefined): string {
  const id = modelId?.trim().toLowerCase();
  if (!id) return "";

  const separators = [...id].filter((c) => c === "/" || c === ":").length;
  if (separators === 1) {
    const sep = id.includes("/") ? "/" : ":";
    const [providerPart, ...rest] = id.split(sep);
    if (providerPart && rest.join(sep).length > 0) return providerPart;
    return "";
  }
  if (separators > 1) return "";

  for (const [prefix, provider] of KNOWN_PREFIXES) {
    if (id.startsWith(prefix)) return provider;
  }
  return "";
}
