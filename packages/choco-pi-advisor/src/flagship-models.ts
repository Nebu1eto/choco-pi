import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arr, compile, map, obj, opt, str } from "@earendil-works/pi-schema";
import type { ModelIdentity } from "./model-gate.ts";

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

export function defaultFallbacksPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "profile",
    "model-fallbacks.json",
  );
}

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

const hasVariants = compile(obj({ preferWhenAvailable: opt(map(str())) }, { open: true })).check;

export async function loadPreferredVariants(
  path: string = defaultFallbacksPath(),
): Promise<ReadonlyMap<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!hasVariants(parsed)) return new Map();
    return new Map(Object.entries(parsed.preferWhenAvailable ?? {}));
  } catch {
    return new Map();
  }
}
