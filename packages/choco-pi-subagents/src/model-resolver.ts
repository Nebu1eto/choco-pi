export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): any;
  getAll(): any[];
  getAvailable?(): any[];
}

export type ModelResolution = { tag: "resolved"; model: any } | { tag: "error"; message: string };

export function resolveModel(input: string, registry: ModelRegistry): ModelResolution {
  const all: ModelEntry[] = registry.getAvailable?.() ?? registry.getAll();
  const availableSet = new Set(all.map((m) => `${m.provider}/${m.id}`.toLowerCase()));

  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const provider = input.slice(0, slashIdx);
    const modelId = input.slice(slashIdx + 1);
    if (availableSet.has(input.toLowerCase())) {
      const found = registry.find(provider, modelId);
      if (found) return { tag: "resolved", model: found };
    }
  }

  const normalize = (s: string) => s.toLowerCase().replace(/\./g, "-");
  const query = normalize(input);

  let bestMatch: ModelEntry | undefined;
  let bestScore = 0;

  for (const m of all) {
    const id = normalize(m.id);
    const name = normalize(m.name);
    const full = normalize(`${m.provider}/${m.id}`);

    let score = 0;
    if (id === query || full === query) {
      score = 100;
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30;
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (
      query
        .split(/[\s\-/]+/)
        .every(
          (part) =>
            /^\d{8}$/.test(part) ||
            id.includes(part) ||
            name.includes(part) ||
            m.provider.toLowerCase().includes(part),
        )
    ) {
      score = 20;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  if (bestMatch && bestScore >= 20) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return { tag: "resolved", model: found };
  }

  if (slashIdx !== -1) {
    const bare = resolveModel(input.slice(slashIdx + 1), registry);
    switch (bare.tag) {
      case "resolved":
        return bare;
      case "error":
        break;
    }
  }

  const modelList = all
    .map((m) => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return {
    tag: "error",
    message: `Model not found: "${input}".\n\nAvailable models:\n${modelList}`,
  };
}
