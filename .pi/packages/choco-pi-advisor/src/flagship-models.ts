import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/** .pi/packages/choco-pi-advisor/src -> .pi/model-fallbacks.json (package-relative, like choco-pi-subagents/src/model-tiers.ts). */
export function defaultFallbacksPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "model-fallbacks.json");
}

/** Flagship-tier primaries from the package-relative model-fallbacks.json; fails open to an empty list. */
export async function loadFlagshipPrimaries(
  path: string = defaultFallbacksPath(),
): Promise<ModelIdentity[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
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
