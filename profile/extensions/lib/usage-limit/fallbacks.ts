import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { arr, compile, map, obj, opt, str, type Static } from "@earendil-works/pi-schema";
import type { RuntimeValue } from "../runtime-values.ts";
import type { FallbackCandidateContext } from "../usage-limit-contract.ts";

const FallbackTierSchema = obj({
  primary: arr(str()),
  secondary: opt(arr(str())),
  next: opt(str()),
});

export const ModelFallbacksSchema = obj({
  tiers: map(FallbackTierSchema),
  preferWhenAvailable: opt(map(str())),
  lastResort: arr(str()),
});

export const ModelFallbacksOverrideSchema = obj({
  tiers: opt(map(FallbackTierSchema)),
  preferWhenAvailable: opt(map(str())),
  lastResort: opt(arr(str())),
});

export type ModelFallbacks = Static<typeof ModelFallbacksSchema>;
export type ModelFallbacksOverride = Static<typeof ModelFallbacksOverrideSchema>;
const isModelFallbacks = compile(ModelFallbacksSchema).check;
const isModelFallbacksOverride = compile(ModelFallbacksOverrideSchema).check;

export const MODEL_FALLBACKS_FILE = "model-fallbacks.json";
export const DEFAULT_MODEL_FALLBACKS_PATH = fileURLToPath(
  new URL(`../../../${MODEL_FALLBACKS_FILE}`, import.meta.url),
);

async function readJson(path: string): Promise<{ found: boolean; value: RuntimeValue }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { found: false, value: undefined };
    }
    throw error;
  }
  try {
    const value: RuntimeValue = JSON.parse(text);
    return { found: true, value };
  } catch {
    throw new Error(`Malformed JSON in ${path}`);
  }
}

export function mergeModelFallbacks(
  base: ModelFallbacks,
  override: ModelFallbacksOverride,
): ModelFallbacks {
  const merged: ModelFallbacks = {
    tiers: { ...base.tiers, ...override.tiers },
    lastResort: override.lastResort ?? base.lastResort,
  };
  if (base.preferWhenAvailable !== undefined || override.preferWhenAvailable !== undefined) {
    merged.preferWhenAvailable = { ...base.preferWhenAvailable, ...override.preferWhenAvailable };
  }
  return merged;
}

export async function loadModelFallbacks(
  agentDir: string = getAgentDir(),
  basePath: string = DEFAULT_MODEL_FALLBACKS_PATH,
): Promise<ModelFallbacks> {
  const base = await readJson(basePath);
  if (!base.found) throw new Error(`Model fallback table not found: ${basePath}`);
  if (!isModelFallbacks(base.value)) {
    throw new Error(`Invalid model fallback table: ${basePath}`);
  }
  const table = base.value;
  const overridePath = join(agentDir, MODEL_FALLBACKS_FILE);
  const override = await readJson(overridePath);
  if (!override.found) return table;
  if (!isModelFallbacksOverride(override.value)) {
    throw new Error(`Invalid model fallback override: ${overridePath}`);
  }
  return mergeModelFallbacks(table, override.value);
}

type ModelRef = { provider: string; id: string };

export function parseModelRef(ref: string): ModelRef | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function refKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.id}`;
}

function parseRefs(refs: readonly string[] | undefined): ModelRef[] {
  return (refs ?? []).flatMap((ref) => {
    const parsed = parseModelRef(ref);
    return parsed ? [parsed] : [];
  });
}

export function fallbackCandidates(table: ModelFallbacks, current: ModelRef): ModelRef[] {
  const currentKey = refKey(current);
  const tierKey =
    current.provider === "openai"
      ? refKey({ provider: "openai-codex", id: current.id })
      : currentKey;
  const tier = Object.values(table.tiers).find((entry) =>
    [...entry.primary, ...(entry.secondary ?? [])].some(
      (ref) => ref === currentKey || ref === tierKey,
    ),
  );
  const primary = parseRefs(tier?.primary).filter((ref) => ref.provider !== current.provider);
  const secondary = parseRefs(tier?.secondary);
  const next = tier?.next === undefined ? undefined : table.tiers[tier.next];
  const lower = [...parseRefs(next?.primary), ...parseRefs(next?.secondary)];
  const ordered = [
    ...primary,
    ...secondary.filter((ref) => ref.provider !== current.provider),
    ...secondary.filter((ref) => ref.provider === current.provider),
    ...lower,
    ...parseRefs(table.lastResort),
  ];
  const preferred = table.preferWhenAvailable ?? {};
  const expanded = ordered.flatMap((ref) => {
    const variant = parseModelRef(preferred[refKey(ref)] ?? "");
    return variant ? [variant, ref] : [ref];
  });
  const seen = new Set<string>([currentKey]);
  return expanded.filter((ref) => {
    const key = refKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type AccountIdResolver = (provider: string) => string;

export const defaultAccountId: AccountIdResolver = () => "default";

export function pickFallback(
  table: ModelFallbacks,
  current: ModelRef,
  context: FallbackCandidateContext,
  resolveAccountId: AccountIdResolver = defaultAccountId,
): ModelRef | undefined {
  const available = new Set(context.available.map(refKey));
  const scoped = new Set(context.scoped);
  for (const candidate of fallbackCandidates(table, current)) {
    const key = refKey(candidate);
    if (!available.has(key)) continue;
    if (scoped.size > 0 && !scoped.has(key)) continue;
    if (context.isClosed(candidate.provider, resolveAccountId(candidate.provider), candidate.id)) {
      continue;
    }
    return { provider: candidate.provider, id: candidate.id };
  }
  return undefined;
}
