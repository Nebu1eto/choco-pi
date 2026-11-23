import type { FactProvider } from "./fact-provider-types.ts";

export function scheduleProviders(providers: FactProvider[]): FactProvider[] {
  if (providers.length <= 1) return providers.slice();

  const factToProvider = new Map<string, FactProvider>();
  for (const p of providers) {
    for (const key of p.provides) {
      factToProvider.set(key, p);
    }
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();

  for (const p of providers) {
    if (!inDegree.has(p.id)) inDegree.set(p.id, 0);
    if (!dependents.has(p.id)) dependents.set(p.id, new Set());
  }

  for (const p of providers) {
    const seenDeps = new Set<string>();
    for (const req of p.requires) {
      const dep = factToProvider.get(req);
      if (dep && dep.id !== p.id && !seenDeps.has(dep.id)) {
        seenDeps.add(dep.id);
        inDegree.set(p.id, (inDegree.get(p.id) ?? 0) + 1);
        dependents.get(dep.id)!.add(p.id);
      }
    }
  }

  const idToProvider = new Map<string, FactProvider>(providers.map((p) => [p.id, p]));

  let wave = providers
    .filter((p) => (inDegree.get(p.id) ?? 0) === 0)
    .sort((a, b) => a.id.localeCompare(b.id));

  const result: FactProvider[] = [];

  while (wave.length > 0) {
    const nextWave: FactProvider[] = [];
    for (const p of wave) {
      result.push(p);
      for (const depId of dependents.get(p.id) ?? []) {
        const newDegree = (inDegree.get(depId) ?? 0) - 1;
        inDegree.set(depId, newDegree);
        if (newDegree === 0) {
          nextWave.push(idToProvider.get(depId)!);
        }
      }
    }
    nextWave.sort((a, b) => a.id.localeCompare(b.id));
    wave = nextWave;
  }

  if (result.length < providers.length) {
    const cycleParticipants = providers
      .filter((p) => !result.includes(p))
      .map((p) => p.id)
      .sort((a, b) => a.localeCompare(b));
    throw new Error(`Cycle detected among FactProviders: ${cycleParticipants.join(", ")}`);
  }

  return result;
}
