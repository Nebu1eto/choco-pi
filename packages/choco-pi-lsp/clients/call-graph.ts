import * as fs from "node:fs";
import * as path from "node:path";
import {
  isBoolean,
  isFiniteNumber,
  isObjectRecord,
  isString,
  isStringArray,
} from "./runtime-guards.ts";
import { getProjectDataDir } from "./file-utils.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { parseSymbolKey as parseCanonicalSymbolKey } from "./review-graph/symbol-id.ts";
import { normalizeMapKey, toProjectRelativePath } from "./path-utils.ts";
import type { Symbol, SymbolRef, SymbolResolution } from "./symbol-types.ts";

export type SymbolKey = string;

export type CallGraphResolution = SymbolResolution;
export type CallGraphEvidenceKind = "calls" | "references" | "mixed";

export interface CallGraphEvidenceCoverage {
  totalEvidence: number;
  callsEvidence: number;
  referencesEvidence: number;
  eligibleEvidence: number;
  resolvedEvidence: number;
  unresolvedEvidence: number;
  typeOnlyEvidence: number;
  unsupportedEvidence: number;
  sameFileEvidence: number;
  duplicateEvidence: number;
  complete: boolean;
  languages?: Record<string, "complete" | "partial" | "unavailable">;
}

export interface ResolvedCallEdge {
  callerFile: string;
  callerSymbol?: string;
  callerKey: SymbolKey;
  callerKind?: string;
  callerLine?: number;
  callerColumn?: number;
  calleeFile: string;
  calleeSymbol: string;
  calleeKey: SymbolKey;
  calleeKind?: string;
  calleeLine?: number;
  calleeColumn?: number;
  evidenceKind?: CallGraphEvidenceKind;
  resolution?: CallGraphResolution;
  evidenceCount?: number;
  weight: number;
}

export interface FunctionCallGraph {
  callees: Map<SymbolKey, Set<SymbolKey>>;
  callers: Map<SymbolKey, Set<SymbolKey>>;
  edges: ResolvedCallEdge[];
  inDegree: Map<SymbolKey, number>;
  unresolvedRefs: number;
  totalRefs: number;
  coverage?: CallGraphEvidenceCoverage;
  builtAt: string;
}

export interface CallGraphCacheIdentity {
  reviewGraphVersion: string;
  reviewGraphSignature: string;
}

interface PersistedCallGraph {
  version: typeof CALL_GRAPH_CACHE_VERSION;
  builtAt: string;
  reviewGraphVersion?: string;
  reviewGraphSignature?: string;
  edges: ResolvedCallEdge[];
  callees: [SymbolKey, SymbolKey[]][];
  callers: [SymbolKey, SymbolKey[]][];
  inDegree: [SymbolKey, number][];
  totalRefs?: number;
  unresolvedRefs?: number;
  coverage?: CallGraphEvidenceCoverage;
}

export const CALL_GRAPH_CACHE_VERSION = 5;

export type ImpactSeverity = "WillBreak" | "MayBreak" | "Review";

export interface ImpactResult {
  symbolKey: SymbolKey;
  depth: number;
  severity: ImpactSeverity;
}

function severityForDepth(depth: number): ImpactSeverity {
  if (depth === 1) return "WillBreak";
  if (depth === 2) return "MayBreak";
  return "Review";
}

export function impact(
  graph: FunctionCallGraph,
  startKey: SymbolKey,
  maxDepth = 3,
  minWeight = 0.1,
): ImpactResult[] {
  const results: ImpactResult[] = [];
  const visited = new Set<SymbolKey>([startKey]);
  const queue: Array<{ key: SymbolKey; depth: number }> = [{ key: startKey, depth: 0 }];

  const edgeWeightMap = new Map<string, number>();
  for (const edge of graph.edges) {
    const edgeKey = `${edge.calleeKey}→${edge.callerKey}`;
    const existing = edgeWeightMap.get(edgeKey) ?? 0;
    edgeWeightMap.set(edgeKey, Math.max(existing, edge.weight));
  }

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.depth >= maxDepth) continue;

    const directCallers = graph.callers.get(item.key);
    if (!directCallers) continue;

    for (const callerKey of directCallers) {
      if (visited.has(callerKey)) continue;

      const edgeKey = `${item.key}→${callerKey}`;
      const weight = edgeWeightMap.get(edgeKey) ?? 1.0;
      if (weight < minWeight) continue;

      visited.add(callerKey);
      const depth = item.depth + 1;
      results.push({ symbolKey: callerKey, depth, severity: severityForDepth(depth) });
      queue.push({ key: callerKey, depth });
    }
  }

  return results.sort((a, b) => a.depth - b.depth || a.symbolKey.localeCompare(b.symbolKey));
}

export function parseSymbolKey(
  key: SymbolKey,
  knownFilePath?: string,
): {
  filePath: string;
  symbolName?: string;
  kind?: string;
  line?: number;
} {
  return parseCanonicalSymbolKey(key, knownFilePath);
}

export function formatImpact(results: ImpactResult[], projectRoot: string): string {
  if (results.length === 0) return "";

  const willBreak = results.filter((r) => r.severity === "WillBreak");
  const mayBreak = results.filter((r) => r.severity === "MayBreak");
  const review = results.filter((r) => r.severity === "Review");

  const parts: string[] = [];

  const label = (r: ImpactResult) => {
    const parsed = parseSymbolKey(r.symbolKey);
    const name = parsed.symbolName ?? r.symbolKey;
    const file = toProjectRelativePath(parsed.filePath, projectRoot);
    return file ? `${name} (${file})` : name;
  };

  if (willBreak.length > 0) {
    parts.push(
      willBreak
        .slice(0, 3)
        .map((r) => `${label(r)} ⚠ WillBreak`)
        .join(", "),
    );
  }
  if (mayBreak.length > 0) {
    parts.push(
      mayBreak
        .slice(0, 2)
        .map((r) => `${label(r)} MayBreak`)
        .join(", "),
    );
  }
  if (review.length > 0) {
    parts.push(`${review.length} Review caller${review.length === 1 ? "" : "s"}`);
  }

  return parts.join(" → ");
}

const STDLIB_NAMES = new Set([
  "console",
  "Math",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Promise",
  "Error",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "JSON",
  "Date",
  "RegExp",
  "Symbol",
  "BigInt",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "fetch",
  "URL",
  "URLSearchParams",
  "Buffer",
  "process",
  "require",
  "print",
  "len",
  "range",
  "list",
  "dict",
  "str",
  "int",
  "float",
  "bool",
  "open",
  "isinstance",
  "issubclass",
  "type",
  "super",
  "hasattr",
  "getattr",
  "setattr",
  "enumerate",
  "zip",
  "map",
  "filter",
  "sorted",
  "reversed",
  "fmt",
  "log",
  "os",
  "io",
  "err",
  "make",
  "append",
  "cap",
  "copy",
  "close",
  "delete",
  "panic",
  "recover",
  "new",
  "eprintln",
  "eprint",
  "vec",
  "Some",
  "None",
  "Ok",
  "Err",
  "Box",
  "Rc",
  "Arc",
  "Vec",
  "HashMap",
  "HashSet",
  "format",
  "System",
  "toString",
  "equals",
  "hashCode",
  "Objects",
  "this",
  "self",
  "nil",
  "null",
  "undefined",
  "true",
  "false",
]);

function buildDefIndex(allSymbols: Map<string, Symbol[]>) {
  const byName = new Map<string, SymbolKey[]>();
  const byId = new Map<SymbolKey, Symbol>();
  for (const [, symbols] of allSymbols) {
    for (const sym of symbols) {
      if (!sym.name || !sym.id) continue;
      const key: SymbolKey = sym.id;
      byId.set(key, sym);
      const existing = byName.get(sym.name) ?? [];
      if (!existing.includes(key)) existing.push(key);
      byName.set(sym.name, existing);
    }
  }
  return { byName, byId };
}

function findEnclosingSymbol(symbols: Symbol[], refLine: number): Symbol | undefined {
  let best: Symbol | undefined;
  for (const sym of symbols) {
    if (
      sym.line <= refLine &&
      (sym.endLine === undefined || refLine <= sym.endLine) &&
      (sym.kind === "function" || sym.kind === "method")
    ) {
      if (!best || sym.line > best.line) best = sym;
    }
  }
  return best;
}

export function buildCallGraph(
  allSymbols: Map<string, Symbol[]>,
  allRefs: Map<string, SymbolRef[]>,
  inputCoverage?: CallGraphEvidenceCoverage,
): FunctionCallGraph {
  const canonicalSymbols = new Map<string, Symbol[]>();
  for (const [filePath, symbols] of allSymbols)
    canonicalSymbols.set(normalizeMapKey(filePath), symbols);
  const defIndex = buildDefIndex(canonicalSymbols);
  const callees = new Map<SymbolKey, Set<SymbolKey>>();
  const callers = new Map<SymbolKey, Set<SymbolKey>>();
  const inDegree = new Map<SymbolKey, number>();
  const edgeByPair = new Map<string, ResolvedCallEdge>();
  let unresolvedRefs = 0;
  let totalRefs = 0;
  const hasInputCoverage = inputCoverage !== undefined;
  const coverage: CallGraphEvidenceCoverage = inputCoverage
    ? { ...inputCoverage }
    : {
        totalEvidence: 0,
        callsEvidence: 0,
        referencesEvidence: 0,
        eligibleEvidence: 0,
        resolvedEvidence: 0,
        unresolvedEvidence: 0,
        typeOnlyEvidence: 0,
        unsupportedEvidence: 0,
        sameFileEvidence: 0,
        duplicateEvidence: 0,
        complete: false,
      };

  for (const [callerFile, refs] of allRefs) {
    const callerFileKey = normalizeMapKey(callerFile);
    const callerSymbols = canonicalSymbols.get(callerFileKey) ?? [];
    for (const ref of refs) {
      totalRefs++;
      if (!hasInputCoverage) {
        coverage.totalEvidence++;
        if (ref.evidenceKind === "references" || ref.referenceKind === "type")
          coverage.referencesEvidence++;
        else coverage.callsEvidence++;
      }
      if (ref.referenceKind === "type") {
        if (!hasInputCoverage) coverage.typeOnlyEvidence++;
        continue;
      }
      if (ref.evidenceKind && ref.referenceKind !== "call") {
        if (!hasInputCoverage) coverage.unsupportedEvidence++;
        continue;
      }

      const candidates: Array<{
        callee: Symbol;
        resolution: SymbolResolution;
        candidateCount: number;
      }> = [];
      if (ref.targetId) {
        const callee = defIndex.byId.get(ref.targetId);
        if (!callee || ref.resolution === "name-only" || ref.resolution === "unresolved") {
          if (!hasInputCoverage) {
            unresolvedRefs++;
            coverage.unresolvedEvidence++;
          }
          continue;
        }
        candidates.push({
          callee,
          resolution: ref.resolution ?? "exact",
          candidateCount: 1,
        });
      } else {
        const refName = ref.symbolName ?? parseSymbolKey(ref.symbolId, callerFile).symbolName ?? "";
        if (STDLIB_NAMES.has(refName) || !refName) {
          if (!hasInputCoverage) coverage.unsupportedEvidence++;
          continue;
        }
        const defs = defIndex.byName.get(refName);
        if (!defs || defs.length === 0) {
          if (!hasInputCoverage) {
            unresolvedRefs++;
            coverage.unresolvedEvidence++;
          }
          continue;
        }
        const crossFileDefs = defs
          .map((id) => defIndex.byId.get(id))
          .filter(
            (candidate): candidate is Symbol =>
              candidate !== undefined && normalizeMapKey(candidate.filePath) !== callerFileKey,
          );
        if (crossFileDefs.length === 0) {
          if (!hasInputCoverage) coverage.unsupportedEvidence++;
          continue;
        }
        const resolution: SymbolResolution = crossFileDefs.length === 1 ? "exact" : "name-only";
        for (const callee of crossFileDefs) {
          candidates.push({ callee, resolution, candidateCount: crossFileDefs.length });
        }
      }

      if (ref.evidenceKind && candidates.some(({ resolution }) => resolution === "name-only")) {
        if (!hasInputCoverage) {
          unresolvedRefs++;
          coverage.unresolvedEvidence++;
        }
        continue;
      }
      const caller = ref.callerSymbolId ? defIndex.byId.get(ref.callerSymbolId) : undefined;
      const enclosing = caller ?? findEnclosingSymbol(callerSymbols, ref.line);
      const callerKey: SymbolKey = enclosing?.id ?? `file:${callerFile}`;
      let producedEdge = false;
      let duplicateRef = false;
      for (const { callee, resolution, candidateCount } of candidates) {
        if (normalizeMapKey(callee.filePath) === callerFileKey) {
          coverage.sameFileEvidence++;
          if (hasInputCoverage) {
            coverage.eligibleEvidence--;
            coverage.resolvedEvidence--;
          }
          continue;
        }
        producedEdge = true;
        const pairKey = `${callerKey}\u0000${callee.id}`;
        const existing = edgeByPair.get(pairKey);
        if (existing) {
          existing.evidenceCount = (existing.evidenceCount ?? 1) + 1;
          existing.evidenceKind =
            existing.evidenceKind === ref.evidenceKind ? existing.evidenceKind : "mixed";
          duplicateRef = true;
          continue;
        }

        const weight = ref.evidenceKind ? 1 : 1 / Math.max(1, candidateCount);
        const edge: ResolvedCallEdge = {
          callerFile,
          callerSymbol: enclosing?.name,
          callerKey,
          callerKind: enclosing?.kind,
          callerLine: enclosing?.line,
          callerColumn: enclosing?.column,
          calleeFile: callee.filePath,
          calleeSymbol: callee.name,
          calleeKey: callee.id,
          calleeKind: callee.kind,
          calleeLine: callee.line,
          calleeColumn: callee.column,
          evidenceKind: ref.evidenceKind,
          resolution,
          evidenceCount: 1,
          weight,
        };
        edgeByPair.set(pairKey, edge);

        const callerCallees = callees.get(callerKey) ?? new Set<SymbolKey>();
        callerCallees.add(callee.id);
        callees.set(callerKey, callerCallees);
        const calleeCallers = callers.get(callee.id) ?? new Set<SymbolKey>();
        calleeCallers.add(callerKey);
        callers.set(callee.id, calleeCallers);
        inDegree.set(callee.id, (inDegree.get(callee.id) ?? 0) + weight);
      }
      if (!hasInputCoverage && producedEdge) {
        coverage.eligibleEvidence++;
        coverage.resolvedEvidence++;
        if (duplicateRef) coverage.duplicateEvidence++;
      }
      if (hasInputCoverage && producedEdge && duplicateRef) coverage.duplicateEvidence++;
    }
  }

  if (hasInputCoverage) totalRefs = coverage.totalEvidence;
  const languagesKnownComplete = Object.values(coverage.languages ?? {}).every(
    (status) => status === "complete",
  );
  coverage.complete =
    coverage.complete &&
    hasInputCoverage &&
    coverage.unsupportedEvidence === 0 &&
    languagesKnownComplete &&
    (allSymbols.size > 0 || coverage.totalEvidence > 0);

  return {
    callees,
    callers,
    inDegree,
    edges: [...edgeByPair.values()],
    unresolvedRefs: hasInputCoverage ? coverage.unresolvedEvidence : unresolvedRefs,
    totalRefs,
    coverage,
    builtAt: new Date().toISOString(),
  };
}

function cacheFilePath(cwd: string): string {
  return path.join(getProjectDataDir(cwd), "cache", "call-graph.json");
}

function metaFilePath(cwd: string): string {
  return path.join(getProjectDataDir(cwd), "cache", "call-graph.meta.json");
}

export function saveCallGraph(
  cwd: string,
  graph: FunctionCallGraph,
  identity: CallGraphCacheIdentity,
): void {
  const cacheFile = cacheFilePath(cwd);
  const metaFile = metaFilePath(cwd);
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const persisted: PersistedCallGraph = {
      version: CALL_GRAPH_CACHE_VERSION,
      builtAt: graph.builtAt,
      reviewGraphVersion: identity.reviewGraphVersion,
      reviewGraphSignature: identity.reviewGraphSignature,
      edges: graph.edges,
      callees: [...graph.callees.entries()].map(([k, v]) => [k, [...v]]),
      callers: [...graph.callers.entries()].map(([k, v]) => [k, [...v]]),
      inDegree: [...graph.inDegree.entries()],
      totalRefs: graph.totalRefs,
      unresolvedRefs: graph.unresolvedRefs,
      coverage: graph.coverage,
    };
    writeFileAtomic(cacheFile, JSON.stringify(persisted));
    writeFileAtomic(
      metaFile,
      JSON.stringify({ savedAt: new Date().toISOString(), edgeCount: graph.edges.length }),
    );
  } catch {}
}

function inferLegacyCoverage(edges: ResolvedCallEdge[]): CallGraphEvidenceCoverage {
  let weightedTotalEvidence = 0;
  let weightedReferencesEvidence = 0;
  let weightedDuplicateEvidence = 0;
  for (const edge of edges) {
    const evidenceCount = edge.evidenceCount;
    const count =
      isFiniteNumber(evidenceCount) && Number.isFinite(evidenceCount) && evidenceCount > 0
        ? Math.floor(evidenceCount)
        : 1;
    const weight = Number.isFinite(edge.weight) && edge.weight >= 0 ? edge.weight : 1;
    weightedTotalEvidence += count * weight;
    weightedDuplicateEvidence += Math.max(0, count - 1) * weight;
    if (edge.evidenceKind === "references") weightedReferencesEvidence += count * weight;
  }
  const totalEvidence = Math.max(0, Math.round(weightedTotalEvidence));
  const referencesEvidence = Math.max(0, Math.round(weightedReferencesEvidence));
  const duplicateEvidence = Math.max(0, Math.round(weightedDuplicateEvidence));
  return {
    totalEvidence,
    callsEvidence: totalEvidence - referencesEvidence,
    referencesEvidence,
    eligibleEvidence: totalEvidence,
    resolvedEvidence: totalEvidence,
    unresolvedEvidence: 0,
    typeOnlyEvidence: 0,
    unsupportedEvidence: 0,
    sameFileEvidence: 0,
    duplicateEvidence,
    complete: false,
  };
}

function loadCoverage(
  rawCoverage: Partial<CallGraphEvidenceCoverage> | undefined,
  edges: ResolvedCallEdge[],
): CallGraphEvidenceCoverage {
  const inferred = inferLegacyCoverage(edges);
  return rawCoverage
    ? {
        ...inferred,
        ...rawCoverage,
      }
    : inferred;
}

function finiteCount<T>(value: T): value is T & number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function countsMatch(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function validatePersistedCallGraph(
  raw: PersistedCallGraph,
  coverage: CallGraphEvidenceCoverage,
): boolean {
  const nonEmptyString = <T>(value: T): value is T & string =>
    isString(value) && value.trim().length > 0;
  const enumValue = <T, U extends string>(value: T, values: readonly U[]): value is T & U =>
    isString(value) && values.some((candidate) => String(candidate) === value);
  const edgeKinds = ["calls", "references", "mixed"] as const;
  const resolutions = ["exact", "import", "receiver-type", "name-only", "unresolved"] as const;
  if (!raw || raw.version !== CALL_GRAPH_CACHE_VERSION || !nonEmptyString(raw.builtAt))
    return false;
  if (!nonEmptyString(raw.reviewGraphVersion) || !nonEmptyString(raw.reviewGraphSignature))
    return false;
  if (
    raw.coverage !== undefined &&
    (!raw.coverage || !isObjectRecord(raw.coverage) || Array.isArray(raw.coverage))
  )
    return false;
  if (
    !Array.isArray(raw.edges) ||
    !Array.isArray(raw.callees) ||
    !Array.isArray(raw.callers) ||
    !Array.isArray(raw.inDegree)
  )
    return false;
  const coverageValues = [
    coverage.totalEvidence,
    coverage.callsEvidence,
    coverage.referencesEvidence,
    coverage.eligibleEvidence,
    coverage.resolvedEvidence,
    coverage.unresolvedEvidence,
    coverage.typeOnlyEvidence,
    coverage.unsupportedEvidence,
    coverage.sameFileEvidence,
    coverage.duplicateEvidence,
  ];
  if (!isBoolean(coverage.complete) || coverageValues.some((value) => !finiteCount(value)))
    return false;
  if (
    coverage.languages !== undefined &&
    (!coverage.languages ||
      !isObjectRecord(coverage.languages) ||
      Array.isArray(coverage.languages) ||
      Object.entries(coverage.languages).some(
        ([language, status]) =>
          !nonEmptyString(language) ||
          !enumValue(status, ["complete", "partial", "unavailable"] as const),
      ))
  )
    return false;
  if (coverage.callsEvidence + coverage.referencesEvidence !== coverage.totalEvidence) return false;
  if (coverage.resolvedEvidence > coverage.eligibleEvidence) return false;
  if (coverage.eligibleEvidence !== coverage.resolvedEvidence) return false;
  if (
    coverage.resolvedEvidence +
      coverage.unresolvedEvidence +
      coverage.typeOnlyEvidence +
      coverage.unsupportedEvidence +
      coverage.sameFileEvidence !==
    coverage.totalEvidence
  )
    return false;
  if (coverage.complete && coverage.unsupportedEvidence > 0) return false;
  if (
    coverage.complete &&
    Object.values(coverage.languages ?? {}).some((status) => status !== "complete")
  )
    return false;

  const expectedCallees = new Map<string, Set<string>>();
  const expectedCallers = new Map<string, Set<string>>();
  const expectedInDegree = new Map<string, number>();
  const pairKeys = new Set<string>();
  let weightedEdgeEvidence = 0;
  let weightedDuplicateEvidence = 0;
  for (const edge of raw.edges) {
    if (
      !edge ||
      !isObjectRecord(edge) ||
      !nonEmptyString(edge.callerKey) ||
      !nonEmptyString(edge.calleeKey) ||
      !nonEmptyString(edge.callerFile) ||
      !nonEmptyString(edge.calleeFile) ||
      !nonEmptyString(edge.calleeSymbol) ||
      !isFiniteNumber(edge.weight) ||
      !Number.isFinite(edge.weight) ||
      edge.weight <= 0 ||
      edge.weight > 1
    )
      return false;
    if (edge.callerSymbol !== undefined && !nonEmptyString(edge.callerSymbol)) return false;
    if (edge.callerKind !== undefined && !nonEmptyString(edge.callerKind)) return false;
    if (edge.calleeKind !== undefined && !nonEmptyString(edge.calleeKind)) return false;
    if (edge.evidenceKind !== undefined && !enumValue(edge.evidenceKind, edgeKinds)) return false;
    if (edge.resolution !== undefined && !enumValue(edge.resolution, resolutions)) return false;
    if (
      edge.evidenceCount !== undefined &&
      (!finiteCount(edge.evidenceCount) || edge.evidenceCount < 1)
    )
      return false;
    const evidenceCount = edge.evidenceCount ?? 1;
    const callerIdentity = parseCanonicalSymbolKey(edge.callerKey, edge.callerFile);
    const calleeIdentity = parseCanonicalSymbolKey(edge.calleeKey, edge.calleeFile);
    if (
      normalizeMapKey(callerIdentity.filePath) !== normalizeMapKey(edge.callerFile) ||
      normalizeMapKey(calleeIdentity.filePath) !== normalizeMapKey(edge.calleeFile) ||
      (calleeIdentity.symbolName !== undefined &&
        calleeIdentity.symbolName !== edge.calleeSymbol) ||
      (callerIdentity.symbolName !== undefined &&
        edge.callerSymbol !== undefined &&
        callerIdentity.symbolName !== edge.callerSymbol)
    )
      return false;
    const pair = `${edge.callerKey}\u0000${edge.calleeKey}`;
    if (pairKeys.has(pair)) return false;
    pairKeys.add(pair);
    weightedEdgeEvidence += evidenceCount * edge.weight;
    weightedDuplicateEvidence += (evidenceCount - 1) * edge.weight;
    const callees = expectedCallees.get(edge.callerKey) ?? new Set<string>();
    callees.add(edge.calleeKey);
    expectedCallees.set(edge.callerKey, callees);
    const callers = expectedCallers.get(edge.calleeKey) ?? new Set<string>();
    callers.add(edge.callerKey);
    expectedCallers.set(edge.calleeKey, callers);
    expectedInDegree.set(edge.calleeKey, (expectedInDegree.get(edge.calleeKey) ?? 0) + edge.weight);
  }
  if (!countsMatch(weightedEdgeEvidence, coverage.resolvedEvidence)) return false;
  if (!countsMatch(weightedDuplicateEvidence, coverage.duplicateEvidence)) return false;
  if (
    !countsMatch(
      coverage.totalEvidence,
      weightedEdgeEvidence +
        coverage.unresolvedEvidence +
        coverage.typeOnlyEvidence +
        coverage.unsupportedEvidence +
        coverage.sameFileEvidence,
    )
  )
    return false;
  if (raw.totalRefs !== undefined && !finiteCount(raw.totalRefs)) return false;
  if (raw.unresolvedRefs !== undefined && !finiteCount(raw.unresolvedRefs)) return false;
  if (raw.totalRefs !== undefined && raw.totalRefs !== coverage.totalEvidence) return false;
  if (raw.unresolvedRefs !== undefined && raw.unresolvedRefs !== coverage.unresolvedEvidence)
    return false;

  const readAdjacency = <T>(entries: T): Map<string, Set<string>> | undefined => {
    const result = new Map<string, Set<string>>();
    if (!Array.isArray(entries)) return undefined;
    for (const entry of entries) {
      if (
        !Array.isArray(entry) ||
        !nonEmptyString(entry[0]) ||
        !isStringArray(entry[1]) ||
        entry[1].some((key: string) => !nonEmptyString(key))
      )
        return undefined;
      const keys = entry[1];
      if (new Set(keys).size !== keys.length || result.has(entry[0])) return undefined;
      result.set(entry[0], new Set(keys));
    }
    return result;
  };
  const actualCallees = readAdjacency(raw.callees);
  const actualCallers = readAdjacency(raw.callers);
  if (
    !actualCallees ||
    !actualCallers ||
    actualCallees.size !== expectedCallees.size ||
    actualCallers.size !== expectedCallers.size
  )
    return false;
  const sameSets = (
    actual: Map<string, Set<string>>,
    expected: Map<string, Set<string>>,
  ): boolean => {
    for (const [key, values] of expected) {
      const got = actual.get(key);
      if (!got || got.size !== values.size || [...values].some((value) => !got.has(value)))
        return false;
    }
    return true;
  };
  if (!sameSets(actualCallees, expectedCallees) || !sameSets(actualCallers, expectedCallers))
    return false;
  const actualInDegree = new Map<string, number>();
  for (const entry of raw.inDegree) {
    if (
      !Array.isArray(entry) ||
      !nonEmptyString(entry[0]) ||
      !isFiniteNumber(entry[1]) ||
      !Number.isFinite(entry[1]) ||
      entry[1] < 0 ||
      actualInDegree.has(entry[0])
    )
      return false;
    actualInDegree.set(entry[0], entry[1]);
  }
  if (actualInDegree.size !== expectedInDegree.size) return false;
  for (const [key, value] of expectedInDegree) {
    if (actualInDegree.get(key) !== value) return false;
  }
  return true;
}

export function loadCallGraph(
  cwd: string,
  expectedIdentity?: CallGraphCacheIdentity,
):
  | {
      graph: FunctionCallGraph;
      identity: CallGraphCacheIdentity;
    }
  | undefined {
  const cacheFile = cacheFilePath(cwd);
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    if (raw.version !== CALL_GRAPH_CACHE_VERSION) return undefined;
    if (!isString(raw.reviewGraphVersion) || !isString(raw.reviewGraphSignature)) return undefined;
    const identity: CallGraphCacheIdentity = {
      reviewGraphVersion: raw.reviewGraphVersion,
      reviewGraphSignature: raw.reviewGraphSignature,
    };
    if (
      expectedIdentity &&
      (identity.reviewGraphVersion !== expectedIdentity.reviewGraphVersion ||
        identity.reviewGraphSignature !== expectedIdentity.reviewGraphSignature)
    )
      return undefined;

    const coverage = loadCoverage(raw.coverage, raw.edges);
    if (!validatePersistedCallGraph(raw, coverage)) return undefined;
    return {
      graph: {
        callees: new Map(raw.callees.map(([k, v]: [string, string[]]) => [k, new Set(v)])),
        callers: new Map(raw.callers.map(([k, v]: [string, string[]]) => [k, new Set(v)])),
        inDegree: new Map(raw.inDegree),
        edges: raw.edges,
        unresolvedRefs: raw.unresolvedRefs ?? coverage.unresolvedEvidence,
        totalRefs: raw.totalRefs ?? coverage.totalEvidence,
        coverage,
        builtAt: raw.builtAt,
      },
      identity,
    };
  } catch {
    return undefined;
  }
}
