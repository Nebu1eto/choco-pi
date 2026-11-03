import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { arr, compile, obj, str } from "@earendil-works/pi-schema";
import type { ModelIdentity } from "./model-gate.ts";

// Open objects, as TypeBox's were: unrelated tiers/keys are tolerated.
const isFallbacks = compile(
  obj(
    { tiers: obj({ flagship: obj({ primary: arr(str()) }, { open: true }) }, { open: true }) },
    { open: true },
  ),
).check;

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
    if (!isFallbacks(parsed)) return [];
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
