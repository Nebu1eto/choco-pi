import { GateError } from "./preflight.ts";
import type { Tier } from "./isolation.ts";
import { scenarios, type ScenarioId } from "./scenarios/index.ts";

/** Parse a comma-separated flag value into unique, non-empty entries. */
export function list(flag: string, value: string): string[] {
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !entry) || new Set(entries).size !== entries.length)
    throw new GateError("ARGUMENT", `${flag} requires a comma-separated list of unique ids`);
  return entries;
}

/**
 * Keep the configured models (original id and resolved id pairs) that a filter names, in the
 * configured order. A filter entry may name either the original id or its substitute.
 */
export function selectModels(
  pairs: readonly { original: string; resolved: string }[],
  filter: readonly string[] | undefined,
): string[] {
  if (!filter) return pairs.map((pair) => pair.resolved);
  for (const id of filter)
    if (!pairs.some((pair) => pair.original === id || pair.resolved === id))
      throw new GateError("ARGUMENT", `--models: unknown model ${id}`);
  return pairs
    .filter((pair) => filter.includes(pair.original) || filter.includes(pair.resolved))
    .map((pair) => pair.resolved);
}

/**
 * Scenarios for the tier, narrowed by the filter in canonical order. Only S1 proves isolation,
 * so a filter must include S1; the scored S1 run then gates the others exactly as in a full run.
 */
export function selectScenarios(tier: Tier, filter: readonly string[] | undefined): ScenarioId[] {
  const available = scenarios.filter((row) => row.tier === "both" || tier === "a");
  if (!filter) return available.map((row) => row.id);
  for (const id of filter)
    if (!available.some((row) => row.id === id))
      throw new GateError("ARGUMENT", `--scenarios: unknown scenario ${id} for tier ${tier}`);
  if (!filter.includes("S1"))
    throw new GateError("ARGUMENT", "--scenarios must include S1 (isolation checks)");
  return available.filter((row) => filter.includes(row.id)).map((row) => row.id);
}
