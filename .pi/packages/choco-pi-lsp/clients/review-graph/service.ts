import type { FactStore } from "../dispatch/fact-store.ts";
import {
  computeImpactCascade as computeImpactCascadeImpl,
  computeTransitiveImpact as computeTransitiveImpactImpl,
  type TransitiveImpactResult,
} from "./query.ts";
import { buildOrUpdateGraph as buildOrUpdateGraphImpl, type GraphSeqHint } from "./builder.ts";
import { formatImpactCascade as formatImpactCascadeImpl } from "./format.ts";
import { buildModuleGraph } from "./workspace-modules.ts";
import type { ImpactCascadeResult, ReviewGraph } from "./types.ts";

const CHANGED_SYMBOLS_PREFIX = "session.reviewGraph.changedSymbols:";
const ENTITY_SNAPSHOT_PREFIX = "session.reviewGraph.entitySnapshot:";

export async function buildOrUpdateGraph(
  cwd: string,
  changedFiles: string[],
  facts: FactStore,
  seqHint?: GraphSeqHint,
): Promise<ReviewGraph> {
  return buildOrUpdateGraphImpl(cwd, changedFiles, facts, seqHint);
}

export function computeImpactCascade(
  graph: ReviewGraph,
  changedFile: string,
  cwd?: string,
): ImpactCascadeResult {
  const moduleGraph = cwd ? buildModuleGraph(cwd) : null;
  return computeImpactCascadeImpl(graph, changedFile, moduleGraph);
}

export function formatImpactCascade(
  result: ImpactCascadeResult,
  maxFiles?: number,
): string | undefined {
  return formatImpactCascadeImpl(result, maxFiles);
}

/** Transitive (depth-bounded) dependents of a file — see query.computeTransitiveImpact. */
export function computeTransitiveImpact(
  graph: ReviewGraph,
  seedFile: string,
  options?: Parameters<typeof computeTransitiveImpactImpl>[2],
): TransitiveImpactResult {
  return computeTransitiveImpactImpl(graph, seedFile, options);
}

export function recordEntitySnapshotDiff(
  facts: FactStore,
  filePath: string,
  nextSnapshot: Map<string, string>,
) {
  const prev =
    facts.getSessionFact<Map<string, string>>(`${ENTITY_SNAPSHOT_PREFIX}${filePath}`) ??
    new Map<string, string>();
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  for (const [key, value] of nextSnapshot.entries()) {
    if (!prev.has(key)) added.push(key);
    else if (prev.get(key) !== value) modified.push(key);
  }
  for (const key of prev.keys()) {
    if (!nextSnapshot.has(key)) removed.push(key);
  }

  const changedSymbols = [
    ...new Set([...added, ...modified, ...removed].map((key) => key.split(":")[1]).filter(Boolean)),
  ];
  facts.setSessionFact(`${ENTITY_SNAPSHOT_PREFIX}${filePath}`, new Map(nextSnapshot));
  facts.setSessionFact(`${CHANGED_SYMBOLS_PREFIX}${filePath}`, changedSymbols);
  return { added, removed, modified };
}
