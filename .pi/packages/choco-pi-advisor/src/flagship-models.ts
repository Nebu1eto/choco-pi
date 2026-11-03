import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ModelIdentity } from "./model-gate.ts";

const fallbacksSchema = Type.Object({
  tiers: Type.Object({
    flagship: Type.Object({ primary: Type.Array(Type.String()) }),
  }),
});

function parseIdentity(entry: string): ModelIdentity | undefined {
  const slash = entry.indexOf("/");
  if (slash <= 0 || slash === entry.length - 1) return undefined;
  return { provider: entry.slice(0, slash), id: entry.slice(slash + 1) };
}

/** Flagship-tier primaries from <cwd>/.pi/model-fallbacks.json; fails open to an empty list. */
export async function loadFlagshipPrimaries(cwd: string): Promise<ModelIdentity[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(cwd, ".pi", "model-fallbacks.json"), "utf8"),
    );
    if (!Value.Check(fallbacksSchema, parsed)) return [];
    const models: ModelIdentity[] = [];
    for (const entry of parsed.tiers.flagship.primary) {
      const identity = parseIdentity(entry);
      if (identity) models.push(identity);
    }
    return models;
  } catch {
    return [];
  }
}
