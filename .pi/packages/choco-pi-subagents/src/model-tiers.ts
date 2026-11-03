/**
 * model-tiers.ts — Flagship-tier model list read from .pi/model-fallbacks.json.
 *
 * The JSON mirrors .pi/model-guidance.md. A missing or malformed file yields an
 * empty set so the tier guard fails open instead of blocking every spawn.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";

const fallbacksSchema = Type.Object({
  tiers: Type.Object({
    flagship: Type.Object({
      primary: Type.Array(Type.String()),
      secondary: Type.Optional(Type.Array(Type.String())),
    }),
  }),
});

/** .pi/packages/choco-pi-subagents/src -> .pi/model-fallbacks.json */
function defaultFallbacksPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "model-fallbacks.json");
}

/** `openai/<id>` belongs to the tier of `openai-codex/<id>`. */
export function normalizeTierModel(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith("openai/")
    ? `openai-codex/${trimmed.slice("openai/".length)}`
    : trimmed;
}

const cache = new Map<string, Promise<ReadonlySet<string>>>();

async function readFlagship(path: string): Promise<ReadonlySet<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
    if (!Value.Check(fallbacksSchema, parsed)) return new Set();
    const { primary, secondary } = parsed.tiers.flagship;
    return new Set([...primary, ...(secondary ?? [])].map(normalizeTierModel));
  } catch {
    return new Set();
  }
}

/** Flagship model ids (normalized), cached per path for the process. */
export function loadFlagshipModels(
  path: string = defaultFallbacksPath(),
): Promise<ReadonlySet<string>> {
  let entry = cache.get(path);
  if (!entry) {
    entry = readFlagship(path);
    cache.set(path, entry);
  }
  return entry;
}
