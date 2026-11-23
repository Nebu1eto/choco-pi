import { assignOptionalProperties } from "./optional-properties.ts";
import { isFiniteNumber } from "./runtime-guards.ts";

import * as path from "node:path";
import { normalizeMapKey, toProjectRelativePath } from "./path-utils.ts";
import { loadProjectSnapshotWithoutWordIndex } from "./project-snapshot.ts";
import type { ReviewGraph } from "./review-graph/types.ts";

type SuggestedNextResultContract = {
  tool: "module_report";
  path: string;
};
type ComputeEntryPointsResultContract = {
  entryPoints: ProjectReportEntryPoint[];
  entryPointFiles: Set<string>;
};
type ComputeDeadWeightResultContract = { files: DeadWeightFile[]; disclaimer: string };

export interface ProjectReportOptions {
  limit?: number;
  focus?: string;
  view?: "compact";
}

export interface ProjectReportTrust {
  graphBuiltAt: string;
  filesCovered: number;
  filesTotal: number;
  coverage: number;
  resolution: {
    exact: number;
    import: number;
    receiverType: number;
    nameOnly: number;
    sampleSize: number;
  };
  stale: boolean;
  lowCoverage: boolean;
  persistCoverage?: ReviewGraph["persistCoverage"];
  notes: string[];
}

export interface ProjectReportFileRef {
  suggestedNext: { tool: "module_report"; path: string };
}

export interface ProjectReportHub extends ProjectReportFileRef {
  file: string;
  fanIn: number;
  blastRadius: number;
  role?: string;
}

export interface ProjectReportEntryPoint extends ProjectReportFileRef {
  file: string;
  fanIn: number;
  fanOut: number;
}

export interface DirectoryEdge {
  from: string;
  to: string;
  count: number;
}

export interface DirectoryCycle {
  dirs: string[];
  edgeCount: number;
}

export interface LayeringViolation {
  from: string;
  to: string;
  count: number;
  dominantCount: number;
}

export interface SubsystemMap {
  directories: string[];
  edges: DirectoryEdge[];
  cycles: DirectoryCycle[];
  violations: LayeringViolation[];
}

export interface RiskHotspot extends ProjectReportFileRef {
  file: string;
  fanIn: number;
  maxComplexity: number;
  score: number;
}

export interface DeadWeightFile extends ProjectReportFileRef {
  file: string;
}

export interface ProjectReport {
  available: boolean;
  hint?: string;
  lastBuildAttempt?: {
    when: string;
    outcome: "running" | "succeeded" | "skipped" | "failed";
    reason?: string;
  };
  view?: "compact";
  trust?: ProjectReportTrust;
  hubs?: ProjectReportHub[];
  entryPoints?: ProjectReportEntryPoint[];
  subsystems?: SubsystemMap;
  riskHotspots?: RiskHotspot[];
  deadWeight?: {
    files: DeadWeightFile[];
    disclaimer: string;
  };
}

const DEFAULT_LIMIT = 10;
const STALE_THRESHOLD_MS = 15 * 60_000;
const LOW_COVERAGE_THRESHOLD = 0.8;
const DEAD_WEIGHT_DISCLAIMER =
  "Low confidence: dynamic imports, runtime registration, and test-only " +
  "reachability all produce false positives here — verify with a real " +
  "usage search (symbol_search/grep) before deleting anything listed.";

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));
}

function toDisplayPath(p: string, projectRoot: string): string {
  return toProjectRelativePath(p, projectRoot);
}

export function _toDisplayPathForTests(p: string, projectRoot: string): string {
  return toDisplayPath(p, projectRoot);
}

function suggestedNext(displayPath: string): SuggestedNextResultContract {
  return { tool: "module_report", path: displayPath };
}

function normalizeFocus(focus: string | undefined): string[] {
  return (focus ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_.]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
    .slice(0, 8);
}

function focusScore(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = text.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 6 : 0), 0);
}

interface FileDegrees {
  fanIn: Map<string, Set<string>>;
  fanOut: Map<string, Set<string>>;
}

function buildFileDegrees(graph: ReviewGraph): FileDegrees {
  const fanIn = new Map<string, Set<string>>();
  const fanOut = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.kind !== "imports") continue;
    if (edge.from === edge.to) continue;
    const fromNode = graph.nodes.get(edge.from);
    const toNode = graph.nodes.get(edge.to);
    if (!fromNode || fromNode.kind !== "file") continue;
    if (!toNode || toNode.kind !== "file") continue;
    let outSet = fanOut.get(edge.from);
    if (!outSet) {
      outSet = new Set();
      fanOut.set(edge.from, outSet);
    }
    outSet.add(edge.to);
    let inSet = fanIn.get(edge.to);
    if (!inSet) {
      inSet = new Set();
      fanIn.set(edge.to, inSet);
    }
    inSet.add(edge.from);
  }
  return { fanIn, fanOut };
}

function computeTrust(graph: ReviewGraph, cwd: string): ProjectReportTrust {
  const filesCovered = graph.fileNodes.size;
  const snapshot = loadProjectSnapshotWithoutWordIndex(cwd);
  const snapshotFileCount = snapshot ? Object.keys(snapshot.files).length : 0;
  const persistedTotal = graph.persistCoverage?.totalFiles ?? 0;
  const filesTotal = Math.max(filesCovered, snapshotFileCount, persistedTotal);
  const coverage = filesTotal > 0 ? filesCovered / filesTotal : 1;

  let exact = 0;
  let imp = 0;
  let receiverType = 0;
  let nameOnly = 0;
  for (const edge of graph.edges) {
    if (edge.kind !== "calls" && edge.kind !== "references") continue;
    switch (edge.resolution) {
      case "exact":
        exact += 1;
        break;
      case "import":
        imp += 1;
        break;
      case "receiver-type":
        receiverType += 1;
        break;
      case "name-only":
        nameOnly += 1;
        break;
      default:
        break;
    }
  }
  const sampleSize = exact + imp + receiverType + nameOnly;
  const frac = (n: number) => (sampleSize > 0 ? n / sampleSize : 0);

  const ageMs = Date.now() - Date.parse(graph.builtAt);
  const stale = Number.isFinite(ageMs) && ageMs > STALE_THRESHOLD_MS;
  const lowCoverage = coverage < LOW_COVERAGE_THRESHOLD || graph.persistCoverage?.partial === true;

  const notes: string[] = [];
  if (stale) {
    const ageMin = Math.round(ageMs / 60_000);
    notes.push(
      `Graph is stale: built ${ageMin}m ago. Sections below may miss recent edits — run pilens_rebuild or re-analyze to refresh.`,
    );
  }
  if (lowCoverage) {
    if (graph.persistCoverage?.partial) {
      const p = graph.persistCoverage;
      const totalFiles = p.totalFiles ?? filesCovered;
      const persistedFiles = p.persistedFiles ?? filesCovered;
      if (p.sourceFilesTruncated) {
        notes.push(
          `Partial source walk: at least ${totalFiles} source files were represented before the visited-entry budget stopped enumeration; ${persistedFiles} files are in this graph.`,
        );
      } else {
        notes.push(
          `Partial persisted graph: ${p.persistedNodes}/${p.totalNodes} nodes, ${p.persistedEdges}/${p.totalEdges} edges, and ${persistedFiles}/${totalFiles} files were retained under the ${p.cap}-element cap — whole subsystems may be invisible below.`,
        );
      }
    } else {
      notes.push(
        `Low coverage: only ${filesCovered}/${filesTotal} project files (${Math.round(coverage * 100)}%) are in the graph — whole subsystems may be invisible below.`,
      );
    }
  }

  return {
    graphBuiltAt: graph.builtAt,
    filesCovered,
    filesTotal,
    coverage,
    resolution: {
      exact: frac(exact),
      import: frac(imp),
      receiverType: frac(receiverType),
      nameOnly: frac(nameOnly),
      sampleSize,
    },
    stale,
    lowCoverage,
    persistCoverage: graph.persistCoverage?.partial ? graph.persistCoverage : undefined,
    notes,
  };
}

function roleFor(graph: ReviewGraph, filePath: string): string | undefined {
  const symbolIds = graph.symbolNodesByFile.get(filePath) ?? [];
  const scored: Array<{ name: string; refs: number }> = [];
  for (const symbolId of symbolIds) {
    const node = graph.nodes.get(symbolId);
    if (!node || !node.exported || !node.symbolName) continue;
    const refs = (graph.edgesByTo.get(symbolId) ?? []).filter(
      (e) => e.kind === "calls" || e.kind === "references",
    ).length;
    scored.push({ name: node.qualifiedName ?? node.symbolName, refs });
  }
  scored.sort((a, b) => b.refs - a.refs);
  const top = scored.slice(0, 3).filter((s) => s.refs > 0);
  return top.length > 0 ? top.map((s) => s.name).join(", ") : undefined;
}

async function computeHubs(
  graph: ReviewGraph,
  degrees: FileDegrees,
  cwd: string,
  limit: number,
  focusTerms: string[],
): Promise<ProjectReportHub[]> {
  const { computeTransitiveImpact } = await import("./review-graph/query.ts");
  const ranked = [...graph.fileNodes.entries()]
    .map(([filePath, fileNodeId]) => ({
      filePath,
      fileNodeId,
      fanIn: degrees.fanIn.get(fileNodeId)?.size ?? 0,
    }))
    .filter((f) => f.fanIn > 0)
    .sort((a, b) => {
      const focusDelta = focusScore(a.filePath, focusTerms) - focusScore(b.filePath, focusTerms);
      if (focusDelta !== 0) return -focusDelta;
      return b.fanIn - a.fanIn || a.filePath.localeCompare(b.filePath);
    })
    .slice(0, limit);

  return ranked.map((f) => {
    const impact = computeTransitiveImpact(graph, f.filePath, { maxDepth: 3 });
    const display = toDisplayPath(f.filePath, cwd);
    return {
      file: display,
      fanIn: f.fanIn,
      blastRadius: impact.hits.length,
      role: roleFor(graph, f.filePath),
      suggestedNext: suggestedNext(display),
    };
  });
}

function computeEntryPoints(
  graph: ReviewGraph,
  degrees: FileDegrees,
  cwd: string,
  limit: number,
  focusTerms: string[],
): ComputeEntryPointsResultContract {
  const candidates = [...graph.fileNodes.entries()]
    .map(([filePath, fileNodeId]) => ({
      filePath,
      fanIn: degrees.fanIn.get(fileNodeId)?.size ?? 0,
      fanOut: degrees.fanOut.get(fileNodeId)?.size ?? 0,
    }))
    .filter((f) => f.fanIn === 0 && f.fanOut > 0)
    .sort((a, b) => {
      const focusDelta = focusScore(a.filePath, focusTerms) - focusScore(b.filePath, focusTerms);
      if (focusDelta !== 0) return -focusDelta;
      return b.fanOut - a.fanOut || a.filePath.localeCompare(b.filePath);
    });

  const entryPointFiles = new Set(candidates.map((c) => c.filePath));
  const entryPoints = candidates.slice(0, limit).map((f) => {
    const display = toDisplayPath(f.filePath, cwd);
    return {
      file: display,
      fanIn: f.fanIn,
      fanOut: f.fanOut,
      suggestedNext: suggestedNext(display),
    };
  });

  return { entryPoints, entryPointFiles };
}

const DOMINANCE_THRESHOLD = 0.4;

function directoryClusters(filePaths: string[], cwd: string): Map<string, string> {
  const segmentsOf = (filePath: string) => toDisplayPath(filePath, cwd).split("/").filter(Boolean);
  const topCounts = new Map<string, number>();
  const perFileSegments = new Map<string, string[]>();
  for (const filePath of filePaths) {
    const segments = segmentsOf(filePath);
    perFileSegments.set(filePath, segments);
    const top = segments.length > 1 ? segments[0] : "(root)";
    topCounts.set(top, (topCounts.get(top) ?? 0) + 1);
  }
  const total = filePaths.length || 1;
  const dominant = new Set(
    [...topCounts.entries()]
      .filter(([, count]) => count / total >= DOMINANCE_THRESHOLD)
      .map(([seg]) => seg),
  );
  const clusterOf = new Map<string, string>();
  for (const filePath of filePaths) {
    const segments = perFileSegments.get(filePath) ?? [];
    if (segments.length <= 1) {
      clusterOf.set(filePath, "(root)");
      continue;
    }
    const top = segments[0];
    if (dominant.has(top) && segments.length > 2) {
      clusterOf.set(filePath, `${segments[0]}/${segments[1]}`);
    } else {
      clusterOf.set(filePath, top);
    }
  }
  return clusterOf;
}

function tarjanSCCs(nodes: string[], adjacency: Map<string, Set<string>>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  function strongConnect(v: string) {
    indices.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }
    if (lowlink.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (const v of nodes) {
    if (!indices.has(v)) strongConnect(v);
  }
  return sccs;
}

function computeSubsystems(graph: ReviewGraph, cwd: string, limit: number): SubsystemMap {
  const filePaths = [...graph.fileNodes.keys()];
  const clusterOf = directoryClusters(filePaths, cwd);
  const fileNodeIdToCluster = new Map<string, string>();
  for (const [filePath, nodeId] of graph.fileNodes) {
    const cluster = clusterOf.get(filePath);
    if (cluster) fileNodeIdToCluster.set(nodeId, cluster);
  }

  const edgeCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.kind !== "imports") continue;
    const fromCluster = fileNodeIdToCluster.get(edge.from);
    const toCluster = fileNodeIdToCluster.get(edge.to);
    if (!fromCluster || !toCluster || fromCluster === toCluster) continue;
    const key = `${fromCluster}|${toCluster}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  }

  const directories = [...new Set(clusterOf.values())].sort((a, b) => a.localeCompare(b));
  const edges: DirectoryEdge[] = [...edgeCounts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split("|");
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));

  const seenPairs = new Set<string>();
  const violations: LayeringViolation[] = [];
  for (const edge of edges) {
    const pairKey = [edge.from, edge.to].sort((a, b) => a.localeCompare(b)).join("|");
    if (seenPairs.has(pairKey)) continue;
    const reverseKey = `${edge.to}|${edge.from}`;
    const reverseCount = edgeCounts.get(reverseKey);
    if (reverseCount === undefined || reverseCount === edge.count) continue;
    seenPairs.add(pairKey);
    if (edge.count < reverseCount) {
      violations.push({
        from: edge.from,
        to: edge.to,
        count: edge.count,
        dominantCount: reverseCount,
      });
    } else {
      violations.push({
        from: edge.to,
        to: edge.from,
        count: reverseCount,
        dominantCount: edge.count,
      });
    }
  }
  violations.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));

  const adjacency = new Map<string, Set<string>>();
  for (const dir of directories) adjacency.set(dir, new Set());
  for (const edge of edges) {
    adjacency.get(edge.from)?.add(edge.to);
  }
  const sccs = tarjanSCCs(directories, adjacency).filter((scc) => scc.length > 1);
  const cycles: DirectoryCycle[] = sccs
    .map((scc) => {
      const members = new Set(scc);
      let edgeCount = 0;
      for (const edge of edges) {
        if (members.has(edge.from) && members.has(edge.to)) edgeCount += edge.count;
      }
      return { dirs: [...scc].sort((a, b) => a.localeCompare(b)), edgeCount };
    })
    .sort((a, b) => b.edgeCount - a.edgeCount);

  return {
    directories,
    edges: edges.slice(0, limit),
    cycles: cycles.slice(0, limit),
    violations: violations.slice(0, limit),
  };
}

function computeRiskHotspots(
  graph: ReviewGraph,
  degrees: FileDegrees,
  cwd: string,
  limit: number,
  focusTerms: string[],
): RiskHotspot[] {
  const ranked = [...graph.fileNodes.entries()]
    .map(([filePath, fileNodeId]) => {
      const symbolIds = graph.symbolNodesByFile.get(filePath) ?? [];
      let maxComplexity = 0;
      for (const symbolId of symbolIds) {
        const complexity = graph.nodes.get(symbolId)?.metadata?.cyclomaticComplexity;

        if (isFiniteNumber(complexity) && complexity > maxComplexity) {
          maxComplexity = complexity;
        }
      }
      const fanIn = degrees.fanIn.get(fileNodeId)?.size ?? 0;
      return { filePath, fanIn, maxComplexity, score: fanIn * maxComplexity };
    })
    .filter((f) => f.score > 0)
    .sort((a, b) => {
      const focusDelta = focusScore(a.filePath, focusTerms) - focusScore(b.filePath, focusTerms);
      if (focusDelta !== 0) return -focusDelta;
      return b.score - a.score || a.filePath.localeCompare(b.filePath);
    })
    .slice(0, limit);

  return ranked.map((f) => {
    const display = toDisplayPath(f.filePath, cwd);
    return {
      file: display,
      fanIn: f.fanIn,
      maxComplexity: f.maxComplexity,
      score: f.score,
      suggestedNext: suggestedNext(display),
    };
  });
}

function computeDeadWeight(
  graph: ReviewGraph,
  degrees: FileDegrees,
  entryPointFiles: Set<string>,
  cwd: string,
  limit: number,
): ComputeDeadWeightResultContract {
  const candidates = [...graph.fileNodes.entries()]
    .filter(([filePath, nodeId]) => {
      if (entryPointFiles.has(filePath)) return false;
      const fanIn = degrees.fanIn.get(nodeId)?.size ?? 0;
      return fanIn === 0;
    })
    .map(([filePath, fileNodeId]) => ({
      filePath,
      fanOut: degrees.fanOut.get(fileNodeId)?.size ?? 0,
    }))
    .sort((a, b) => a.fanOut - b.fanOut || a.filePath.localeCompare(b.filePath))
    .slice(0, limit);

  return {
    files: candidates.map((f) => {
      const display = toDisplayPath(f.filePath, cwd);
      return { file: display, suggestedNext: suggestedNext(display) };
    }),
    disclaimer: DEAD_WEIGHT_DISCLAIMER,
  };
}

const inFlightGraphBuilds = new Set<string>();

export function _resetProjectReportBuildGuardForTests(): void {
  inFlightGraphBuilds.clear();
}

function triggerBackgroundGraphBuild(cwd: string): boolean {
  const key = normalizeMapKey(path.resolve(cwd));
  if (inFlightGraphBuilds.has(key)) return false;
  inFlightGraphBuilds.add(key);
  void (async () => {
    try {
      const { buildOrUpdateGraph } = await import("./review-graph/builder.ts");
      const { FactStore } = await import("./dispatch/fact-store.ts");
      await buildOrUpdateGraph(key, [], new FactStore());
    } catch {
    } finally {
      inFlightGraphBuilds.delete(key);
    }
  })();
  return true;
}

export async function projectReport(
  cwd: string,
  options?: ProjectReportOptions,
): Promise<ProjectReport> {
  const limit = clampLimit(options?.limit);
  const focusTerms = normalizeFocus(options?.focus);
  const view = options?.view;

  const { getCachedReviewGraph, getReviewGraphSizeSkipVerdict, getLastReviewGraphBuildAttempt } =
    await import("./review-graph/builder.ts");
  let graph: ReviewGraph | undefined;
  try {
    graph = getCachedReviewGraph(cwd);
  } catch {
    graph = undefined;
  }

  if (!graph) {
    let sizeSkip: ReturnType<typeof getReviewGraphSizeSkipVerdict>;
    try {
      sizeSkip = getReviewGraphSizeSkipVerdict(cwd);
    } catch {
      sizeSkip = undefined;
    }
    if (sizeSkip) {
      const lastBuildAttempt = getLastReviewGraphBuildAttempt(cwd);
      return assignOptionalProperties(
        assignOptionalProperties(
          {
            available: false,
            hint:
              `review graph disabled: project has more than ${sizeSkip.maxFileCount} files ` +
              `(cap ${sizeSkip.maxFileCount}) — raise maxProjectFiles in .choco-pi-lsp.json ` +
              "or set CHOCO_PI_LSP_REVIEW_GRAPH_MAX_FILES; for CI/cron, run " +
              "npx choco-pi-lsp build-graph after configuring the cap",
          },
          lastBuildAttempt,
          () => ({ lastBuildAttempt }),
        ),
        view,
        () => ({ view }),
      );
    }
    const previousAttempt = getLastReviewGraphBuildAttempt(cwd);
    const kickedOff = triggerBackgroundGraphBuild(cwd);
    const lastBuildAttempt = previousAttempt ?? getLastReviewGraphBuildAttempt(cwd);
    return assignOptionalProperties(
      assignOptionalProperties(
        {
          available: false,
          hint:
            lastBuildAttempt?.outcome === "failed" || lastBuildAttempt?.outcome === "skipped"
              ? `Review graph unavailable: ${lastBuildAttempt.reason ?? lastBuildAttempt.outcome}. A retry was ${kickedOff ? "started" : "not started"}.`
              : kickedOff
                ? "No review graph cached for this workspace yet — a build was kicked off in the background; retry this call shortly."
                : "No review graph cached for this workspace yet — the background build is still running; retry this call shortly.",
        },
        lastBuildAttempt,
        () => ({ lastBuildAttempt }),
      ),
      view,
      () => ({ view }),
    );
  }

  const degrees = buildFileDegrees(graph);
  const trust = computeTrust(graph, cwd);
  const hubs = await computeHubs(graph, degrees, cwd, limit, focusTerms);
  const { entryPoints, entryPointFiles } = computeEntryPoints(
    graph,
    degrees,
    cwd,
    limit,
    focusTerms,
  );
  const subsystems = computeSubsystems(graph, cwd, limit);
  const riskHotspots = computeRiskHotspots(graph, degrees, cwd, limit, focusTerms);
  const deadWeight = computeDeadWeight(graph, degrees, entryPointFiles, cwd, limit);
  const lastBuildAttempt = getLastReviewGraphBuildAttempt(cwd);

  return Object.assign(
    assignOptionalProperties(
      assignOptionalProperties({ available: true }, lastBuildAttempt, () => ({
        lastBuildAttempt,
      })),
      view,
      () => ({ view }),
    ),
    { trust, hubs, entryPoints, subsystems, riskHotspots, deadWeight },
  );
}

function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function renderCompactProjectReport(report: ProjectReport): string {
  if (!report.available) {
    return `project_report — unavailable${report.hint ? `: ${report.hint}` : ""}`;
  }
  const lines: string[] = [];
  if (report.lastBuildAttempt?.reason) {
    lines.push(`! build: ${report.lastBuildAttempt.reason}`);
  }
  const t = report.trust;
  if (t) {
    lines.push(
      `TRUST: built ${t.graphBuiltAt} — ${t.filesCovered}/${t.filesTotal} files (${fmtPct(t.coverage)} coverage)` +
        (t.resolution.sampleSize > 0
          ? ` — resolution: exact ${fmtPct(t.resolution.exact)}, import ${fmtPct(t.resolution.import)}, receiver-type ${fmtPct(t.resolution.receiverType)}, name-only ${fmtPct(t.resolution.nameOnly)}`
          : " — no resolution-tagged edges yet"),
    );
    for (const note of t.notes) lines.push(`  ! ${note}`);
  }
  if (report.hubs?.length) {
    lines.push("HUBS:");
    for (const h of report.hubs) {
      const role = h.role ? ` — ${h.role}` : "";
      lines.push(`  ${h.file}${role}; ${h.fanIn} importer(s), blast_radius ${h.blastRadius}`);
    }
  }
  if (report.entryPoints?.length) {
    lines.push("ENTRY POINTS:");
    for (const e of report.entryPoints) {
      lines.push(`  ${e.file}; fan-out ${e.fanOut}`);
    }
  }
  if (report.subsystems) {
    const s = report.subsystems;
    lines.push(
      `SUBSYSTEMS: ${s.directories.length} directories, ${s.edges.length} cross-dir edge group(s)`,
    );
    if (s.cycles.length > 0) {
      lines.push("  CYCLES:");
      for (const c of s.cycles) {
        lines.push(`    ${c.dirs.join(" <-> ")} (${c.edgeCount} edges)`);
      }
    }
    if (s.violations.length > 0) {
      lines.push("  LAYERING VIOLATIONS:");
      for (const v of s.violations) {
        lines.push(
          `    ${v.from} -> ${v.to} (${v.count} edge(s), against the dominant ${v.to} -> ${v.from} direction, ${v.dominantCount} edge(s))`,
        );
      }
    }
  }
  if (report.riskHotspots?.length) {
    lines.push("RISK HOTSPOTS:");
    for (const r of report.riskHotspots) {
      lines.push(`  ${r.file}; fan-in ${r.fanIn} × max complexity ${r.maxComplexity} = ${r.score}`);
    }
  }
  if (report.deadWeight) {
    lines.push(`DEAD WEIGHT (${report.deadWeight.disclaimer}):`);
    for (const d of report.deadWeight.files) {
      lines.push(`  ${d.file}`);
    }
    if (report.deadWeight.files.length === 0) lines.push("  (none found)");
  }
  return lines.join("\n");
}
