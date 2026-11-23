import * as fs from "node:fs";
import * as path from "node:path";
import { FactStore } from "./dispatch/fact-store.ts";
import { getProjectDataDir } from "./file-utils.ts";
import { collectUntrackedIgnoredIds } from "./git-tracked-ignore.ts";
import { normalizeMapKey, toProjectRelativePath } from "./path-utils.ts";
import { canonicalSourceTwin } from "./source-filter.ts";
import { buildOrUpdateGraph } from "./review-graph/service.ts";
import type { ReviewGraph } from "./review-graph/types.ts";
import { detectFileRole } from "./file-role.ts";

type DegreesForResultContract = {
  inNeighbors: Map<string, Set<string>>;
  outNeighbors: Map<string, Set<string>>;
};
type SeededPositionResultContract = { x: number; y: number };

export interface FileMapNode {
  id: string;
  path: string;
  language: string;
  symbolCount: number;
  outDegree: number;
  inDegree: number;
  dependents: number;
}

export interface FileMapEdge {
  from: string;
  to: string;
  weight: number;
}

export interface AggregatedFileGraph {
  nodes: FileMapNode[];
  edges: FileMapEdge[];
  externalCount: number;
  testFileCount: number;
  compiledTwinCount: number;
  ignoredFileCount: number;
  truncated: boolean;
}

export interface AggregateOptions {
  maxNodes?: number;
  excludeIds?: ReadonlySet<string>;
}

export const DEFAULT_MAX_MAP_NODES = 500;

interface MutableFileEntry {
  id: string;
  path: string;
  language: string;
  symbolCount: number;
}

export function aggregateGraphToFiles(
  graph: ReviewGraph,
  options?: AggregateOptions,
): AggregatedFileGraph {
  const maxNodes = Math.max(1, options?.maxNodes ?? DEFAULT_MAX_MAP_NODES);

  const files = new Map<string, MutableFileEntry>();
  let externalCount = 0;
  const testFileIds = new Set<string>();

  const nodeToFile = new Map<string, string>();

  const isTestById = new Map<string, boolean>();
  function isTestFile(id: string, filePath: string): boolean {
    let isTest = isTestById.get(id);
    if (isTest === undefined) {
      isTest = detectFileRole(filePath) === "test";
      isTestById.set(id, isTest);
    }
    return isTest;
  }

  const allFileIds = new Set<string>();
  for (const node of graph.nodes.values()) {
    if (node.kind === "external") {
      externalCount += 1;
      continue;
    }
    if ((node.kind !== "file" && node.kind !== "symbol") || !node.filePath) {
      continue;
    }
    const id = normalizeMapKey(node.filePath);
    if (isTestFile(id, node.filePath)) {
      testFileIds.add(id);
      continue;
    }
    allFileIds.add(id);
  }

  const compiledExtensions = new Set([".js", ".jsx", ".mjs", ".cjs"]);
  const excludeIds = options?.excludeIds;
  const canonicalOf = new Map<string, string>();
  for (const id of allFileIds) {
    if (!compiledExtensions.has(path.extname(id).toLowerCase())) continue;
    const canonical = canonicalSourceTwin(id, allFileIds, excludeIds);
    if (canonical !== id) canonicalOf.set(id, canonical);
  }
  const compiledTwinCount = canonicalOf.size;

  const droppedIgnoredIds = new Set<string>();
  if (excludeIds) {
    for (const id of allFileIds) {
      if (excludeIds.has(id) && !canonicalOf.has(id)) {
        droppedIgnoredIds.add(id);
      }
    }
  }
  const ignoredFileCount = droppedIgnoredIds.size;

  const logicalSymbolByNode = new Map<string, string>();
  const sourceSymbolsByFile = new Map<string, Map<string, string[]>>();
  const sourceSymbolsByName = new Map<string, Map<string, string[]>>();
  for (const node of graph.nodes.values()) {
    if (node.kind !== "symbol" || !node.filePath || !node.symbolName) continue;
    const raw = normalizeMapKey(node.filePath);
    const canonical = canonicalOf.get(raw) ?? raw;
    if (raw !== canonical) continue;
    const key = `${node.symbolName}\u0000${node.symbolKind ?? ""}`;
    const byName = sourceSymbolsByFile.get(canonical) ?? new Map<string, string[]>();
    const ids = byName.get(key) ?? [];
    ids.push(node.id);
    byName.set(key, ids);
    sourceSymbolsByFile.set(canonical, byName);
    const bySymbolName = sourceSymbolsByName.get(canonical) ?? new Map<string, string[]>();
    const nameIds = bySymbolName.get(node.symbolName) ?? [];
    nameIds.push(node.id);
    bySymbolName.set(node.symbolName, nameIds);
    sourceSymbolsByName.set(canonical, bySymbolName);
    logicalSymbolByNode.set(node.id, node.id);
  }
  const twinOccurrencesByFile = new Map<string, Map<string, number>>();
  for (const node of graph.nodes.values()) {
    if (node.kind !== "symbol" || !node.filePath || !node.symbolName) continue;
    const raw = normalizeMapKey(node.filePath);
    const canonical = canonicalOf.get(raw) ?? raw;
    if (raw === canonical) continue;
    const key = `${node.symbolName}\u0000${node.symbolKind ?? ""}`;
    const exactSourceIds = sourceSymbolsByFile.get(canonical)?.get(key) ?? [];
    const nameSourceIds = sourceSymbolsByName.get(canonical)?.get(node.symbolName) ?? [];
    const sourceIds =
      exactSourceIds.length > 0 ? exactSourceIds : nameSourceIds.length === 1 ? nameSourceIds : [];
    const occurrenceKey = exactSourceIds.length > 0 ? key : node.symbolName;
    const occurrences = twinOccurrencesByFile.get(raw) ?? new Map<string, number>();
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    twinOccurrencesByFile.set(raw, occurrences);
    const logical = sourceIds[occurrence];
    if (logical) {
      logicalSymbolByNode.set(node.id, logical);
    } else {
      logicalSymbolByNode.set(node.id, node.id);
    }
  }
  const countedLogicalSymbols = new Set<string>();

  for (const node of graph.nodes.values()) {
    if (node.kind === "external") continue;
    if (node.kind === "file" && node.filePath) {
      const raw = normalizeMapKey(node.filePath);
      if (isTestById.get(raw)) continue;
      if (droppedIgnoredIds.has(raw)) continue;
      const id = canonicalOf.get(raw) ?? raw;
      nodeToFile.set(node.id, id);
      const existing = files.get(id);
      if (existing) {
        if (raw === id) {
          existing.language = node.language || existing.language;
        } else if (!existing.language) {
          existing.language = node.language || "";
        }
      } else {
        files.set(id, { id, path: id, language: node.language || "", symbolCount: 0 });
      }
      continue;
    }
    if (node.kind === "symbol" && node.filePath) {
      const raw = normalizeMapKey(node.filePath);
      if (isTestById.get(raw)) continue;
      if (droppedIgnoredIds.has(raw)) continue;
      const id = canonicalOf.get(raw) ?? raw;
      nodeToFile.set(node.id, id);
      const logicalId = logicalSymbolByNode.get(node.id) ?? node.id;
      const existing = files.get(id);
      if (existing) {
        if (!countedLogicalSymbols.has(logicalId)) {
          existing.symbolCount += 1;
          countedLogicalSymbols.add(logicalId);
        }
      } else {
        files.set(id, {
          id,
          path: id,
          language: node.language || "",
          symbolCount: 1,
        });
        countedLogicalSymbols.add(logicalId);
      }
      continue;
    }
  }

  const edgeWeights = new Map<string, number>();
  const seenLogicalEdges = new Set<string>();
  for (const edge of graph.edges) {
    const fromFile = nodeToFile.get(edge.from);
    const toFile = nodeToFile.get(edge.to);
    if (!fromFile || !toFile || fromFile === toFile) continue;
    const logicalFrom = logicalSymbolByNode.get(edge.from) ?? fromFile;
    const logicalTo = logicalSymbolByNode.get(edge.to) ?? toFile;
    const logicalEdgeKey = `${logicalFrom}\u0000${logicalTo}\u0000${edge.kind}`;
    if (seenLogicalEdges.has(logicalEdgeKey)) continue;
    seenLogicalEdges.add(logicalEdgeKey);
    const key = `${fromFile}\u0000${toFile}`;
    edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
  }

  function buildEdgeList(keepIds: Set<string> | undefined): FileMapEdge[] {
    const out: FileMapEdge[] = [];
    for (const [key, weight] of edgeWeights) {
      const sep = key.indexOf("\u0000");
      const from = key.slice(0, sep);
      const to = key.slice(sep + 1);
      if (keepIds && (!keepIds.has(from) || !keepIds.has(to))) continue;
      out.push({ from, to, weight });
    }
    return out;
  }

  function degreesFor(edges: FileMapEdge[]): DegreesForResultContract {
    const inNeighbors = new Map<string, Set<string>>();
    const outNeighbors = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!outNeighbors.has(edge.from)) outNeighbors.set(edge.from, new Set());
      outNeighbors.get(edge.from)?.add(edge.to);
      if (!inNeighbors.has(edge.to)) inNeighbors.set(edge.to, new Set());
      inNeighbors.get(edge.to)?.add(edge.from);
    }

    return { inNeighbors, outNeighbors };
  }

  let keepIds: Set<string> | undefined;
  let truncated = false;
  if (files.size > maxNodes) {
    const fullEdges = buildEdgeList(undefined);
    const { inNeighbors, outNeighbors } = degreesFor(fullEdges);
    const ranked = [...files.keys()].sort((a, b) => {
      const degA = (inNeighbors.get(a)?.size ?? 0) + (outNeighbors.get(a)?.size ?? 0);
      const degB = (inNeighbors.get(b)?.size ?? 0) + (outNeighbors.get(b)?.size ?? 0);
      if (degA !== degB) return degB - degA;
      return a.localeCompare(b);
    });
    keepIds = new Set(ranked.slice(0, maxNodes));
    truncated = true;
  }

  const finalEdges = buildEdgeList(keepIds);
  const { inNeighbors, outNeighbors } = degreesFor(finalEdges);

  function transitiveDependents(seed: string): number {
    const visited = new Set<string>([seed]);
    let frontier = [seed];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const dependent of inNeighbors.get(id) ?? []) {
          if (visited.has(dependent)) continue;
          visited.add(dependent);
          next.push(dependent);
        }
      }
      frontier = next;
    }
    visited.delete(seed);
    return visited.size;
  }

  const keptEntries = [...files.values()].filter((entry) => !keepIds || keepIds.has(entry.id));
  const nodes: FileMapNode[] = keptEntries
    .map((entry) => ({
      id: entry.id,
      path: entry.path,
      language: entry.language,
      symbolCount: entry.symbolCount,
      outDegree: outNeighbors.get(entry.id)?.size ?? 0,
      inDegree: inNeighbors.get(entry.id)?.size ?? 0,
      dependents: transitiveDependents(entry.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    nodes,
    edges: finalEdges,
    externalCount,
    testFileCount: testFileIds.size,
    compiledTwinCount,
    ignoredFileCount,
    truncated,
  };
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  iterations?: number;
}

export interface LayoutPoint {
  id: string;
  x: number;
  y: number;
}

const DEFAULT_LAYOUT_WIDTH = 1600;
const DEFAULT_LAYOUT_HEIGHT = 1200;
const DEFAULT_ITERATIONS = 200;
const LAYOUT_MARGIN = 40;
const GRAVITY_STRENGTH = 0.02;
const ATTRACTION_SCALE = 0.02;

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function seededPosition(id: string, width: number, height: number): SeededPositionResultContract {
  const hx = fnv1a(id);
  const hy = fnv1a(`${id}\u0000y`);

  return {
    x: ((hx % 10000) / 10000) * width,
    y: ((hy % 10000) / 10000) * height,
  };
}

export function computeLayout(
  nodes: readonly { id: string }[],
  edges: readonly { from: string; to: string; weight: number }[],
  options?: LayoutOptions,
): LayoutPoint[] {
  const width = Math.max(1, options?.width ?? DEFAULT_LAYOUT_WIDTH);
  const height = Math.max(1, options?.height ?? DEFAULT_LAYOUT_HEIGHT);
  const iterations = Math.max(1, options?.iterations ?? DEFAULT_ITERATIONS);
  if (nodes.length === 0) return [];

  const ids = nodes.map((n) => n.id);
  const pos = new Map<string, { x: number; y: number; dx: number; dy: number }>();
  for (const id of ids) {
    const seed = seededPosition(id, width, height);
    pos.set(id, { x: seed.x, y: seed.y, dx: 0, dy: 0 });
  }
  if (ids.length === 1) {
    const only = pos.get(ids[0]);
    if (only) {
      only.x = width / 2;
      only.y = height / 2;
    }
  }

  const relevantEdges = edges.filter((e) => pos.has(e.from) && pos.has(e.to) && e.from !== e.to);
  const area = width * height;
  const k = Math.sqrt(area / Math.max(1, ids.length));
  const center = { x: width / 2, y: height / 2 };

  for (let iter = 0; iter < iterations; iter += 1) {
    for (const id of ids) {
      const p = pos.get(id);
      if (p) {
        p.dx = 0;
        p.dy = 0;
      }
    }

    for (let i = 0; i < ids.length; i += 1) {
      const a = pos.get(ids[i]);
      if (!a) continue;
      for (let j = i + 1; j < ids.length; j += 1) {
        const b = pos.get(ids[j]);
        if (!b) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 0.0001) {
          dx = 0.1;
          dy = 0.1;
          distSq = 0.02;
        }
        const dist = Math.sqrt(distSq);
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.dx += fx;
        a.dy += fy;
        b.dx -= fx;
        b.dy -= fy;
      }
    }

    for (const edge of relevantEdges) {
      const a = pos.get(edge.from);
      const b = pos.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
      const weightFactor = Math.min(4, 1 + Math.log2(edge.weight + 1));
      const force = ((dist * dist) / k) * weightFactor * ATTRACTION_SCALE;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.dx += fx;
      a.dy += fy;
      b.dx -= fx;
      b.dy -= fy;
    }

    for (const id of ids) {
      const p = pos.get(id);
      if (!p) continue;
      p.dx += (center.x - p.x) * GRAVITY_STRENGTH;
      p.dy += (center.y - p.y) * GRAVITY_STRENGTH;
    }

    const temperature = Math.max(0.5, width * 0.05 * (1 - iter / iterations));
    for (const id of ids) {
      const p = pos.get(id);
      if (!p) continue;
      const dispLen = Math.max(0.0001, Math.sqrt(p.dx * p.dx + p.dy * p.dy));
      const capped = Math.min(dispLen, temperature);
      p.x += (p.dx / dispLen) * capped;
      p.y += (p.dy / dispLen) * capped;
      p.x = Math.min(width - LAYOUT_MARGIN, Math.max(LAYOUT_MARGIN, p.x));
      p.y = Math.min(height - LAYOUT_MARGIN, Math.max(LAYOUT_MARGIN, p.y));
    }
  }

  return nodes.map((n) => {
    const p = pos.get(n.id);
    const x = p && Number.isFinite(p.x) ? p.x : width / 2;
    const y = p && Number.isFinite(p.y) ? p.y : height / 2;
    return { id: n.id, x, y };
  });
}

export interface LensMapPayloadNode extends FileMapNode {
  x: number;
  y: number;
}

export interface LensMapPayload {
  generatedAt: string;
  projectLabel: string;
  fileCount: number;
  edgeCount: number;
  externalCount: number;
  testFileCount: number;
  compiledTwinCount: number;
  ignoredFileCount: number;
  truncated: boolean;
  maxNodes: number;
  width: number;
  height: number;
  nodes: LensMapPayloadNode[];
  edges: FileMapEdge[];
}

function escapeJsonForScriptTag(json: string): string {
  return json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function renderMapHtml(payload: LensMapPayload): string {
  const json = escapeJsonForScriptTag(JSON.stringify(payload));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'" />
<title>choco-pi-lsp project map</title>
<style>
  :root {
    color-scheme: light;
    --font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Inter", "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
    --bg: #ffffff;
    --panel: #ffffff;
    --panel-recessed: #f4f5f7;
    --fg: #0f172a;
    --muted: #64748b;
    --line: #e2e8f0;
    --line-strong: #cbd5e1;
    --accent: #2563eb;
    --accent-soft: #dbeafe;
    --warn: #d97706;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #0a0a0b; --panel: #16161a; --panel-recessed: #1f1f25;
      --fg: #f1f5f9; --muted: #94a3b8; --line: #26262c; --line-strong: #36363d;
      --accent: #60a5fa; --accent-soft: rgba(96, 165, 250, 0.16); --warn: #fbbf24;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg); font-family: var(--font-body); }
  header { padding: 16px 20px; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: baseline; }
  header h1 { margin: 0; font-size: 1.15rem; letter-spacing: -0.01em; }
  .stats { display: flex; flex-wrap: wrap; gap: 14px; color: var(--muted); font-size: 0.85rem; }
  .stats strong { color: var(--fg); font-family: var(--font-mono); }
  #truncation-note { width: 100%; margin-top: 4px; color: var(--warn); font-size: 0.82rem; }
  #truncation-note[hidden] { display: none; }
  #stage { position: relative; height: calc(100vh - 76px); overflow: hidden; }
  #graph-svg { width: 100%; height: 100%; display: block; cursor: grab; background: var(--panel-recessed); }
  #graph-svg:active { cursor: grabbing; }
  .node-circle { stroke: var(--panel); stroke-width: 1.5px; cursor: pointer; transition: opacity 120ms ease; }
  .node text { font-family: var(--font-mono); font-size: 9px; fill: var(--muted); pointer-events: none; }
  .edge { stroke: var(--line-strong); stroke-opacity: 0.55; transition: opacity 120ms ease, stroke 120ms ease; }
  .edge.active { stroke: var(--accent); stroke-opacity: 0.9; }
  .dimmed { opacity: 0.12; }
  .faded { opacity: 0.15; }
  .edge.edge-hidden { display: none; }
  .node.no-label text { display: none; }
  .node.search-hit .node-circle { stroke: var(--accent); stroke-width: 2.5px; }
  .node.selected .node-circle { stroke: var(--warn); stroke-width: 2.5px; }
  .node.trace-hit .node-circle { stroke: var(--accent); stroke-width: 3px; }
  #controls { position: absolute; top: 12px; left: 12px; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; max-width: min(560px, calc(100% - 24px)); padding: 8px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); box-shadow: 0 6px 18px rgba(0,0,0,0.12); font-size: 0.8rem; color: var(--muted); }
  #search-input { width: 170px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel-recessed); color: var(--fg); font-family: var(--font-mono); font-size: 0.8rem; }
  #weight-label { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  #weight-slider { width: 100px; }
  #trace-toggle { border: 1px solid var(--line); border-radius: 6px; background: var(--panel-recessed); color: var(--fg); padding: 4px 10px; cursor: pointer; font-size: 0.78rem; }
  #trace-toggle[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); }
  #help-note { flex-basis: 100%; font-size: 0.72rem; line-height: 1.4; }
  #trace-status { margin: 0 0 8px; color: var(--warn); }
  #trace-status[hidden] { display: none; }
  #detail-panel { position: fixed; right: 16px; bottom: 16px; width: 300px; max-width: calc(100% - 32px); border: 1px solid var(--line); border-radius: 12px; background: var(--panel); box-shadow: 0 12px 34px rgba(0,0,0,0.18); padding: 14px 16px; font-size: 0.85rem; }
  #detail-panel[hidden] { display: none; }
  #detail-panel h2 { margin: 0 0 8px; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  #detail-path { display: block; word-break: break-word; font-family: var(--font-mono); color: var(--fg); margin-bottom: 10px; }
  #detail-panel dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; }
  #detail-panel dt { color: var(--muted); }
  #detail-panel dd { margin: 0; font-family: var(--font-mono); text-align: right; }
  #detail-close { position: absolute; top: 8px; right: 10px; border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 0.95rem; }
  #detail-close:hover { color: var(--fg); }
  #empty-note { padding: 40px 20px; color: var(--muted); }
  noscript { display: block; padding: 20px; color: var(--muted); }
</style>
</head>
<body>
<noscript>This project map needs JavaScript to render the interactive graph.</noscript>
<header>
  <h1>choco-pi-lsp project map</h1>
  <div class="stats">
    <span><strong id="stat-files">-</strong> files</span>
    <span><strong id="stat-edges">-</strong> edges</span>
    <span><strong id="stat-external">-</strong> external deps (excluded)</span>
    <span id="stat-testfiles-wrap" hidden><strong id="stat-testfiles">-</strong> test files (excluded)</span>
    <span id="stat-twins-wrap" hidden><strong id="stat-twins">-</strong> compiled twins (merged into sources)</span>
    <span id="stat-ignored-wrap" hidden><strong id="stat-ignored">-</strong> gitignored files (excluded)</span>
    <span>generated <strong id="stat-generated">-</strong></span>
    <span id="stat-project"></span>
  </div>
  <p id="truncation-note" hidden></p>
</header>
<div id="stage">
  <div id="controls">
    <input id="search-input" type="search" placeholder="search files" autocomplete="off" spellcheck="false" aria-label="Search files" />
    <label id="weight-label">min edge weight
      <input id="weight-slider" type="range" min="1" max="1" step="1" value="1" />
      <span id="weight-value">1</span> (<span id="visible-edges">0</span> edges)
    </label>
    <button id="trace-toggle" type="button" aria-pressed="false">trace path</button>
    <span id="help-note">hover: neighbors &middot; click: select + details &middot; shift+click a 2nd node (or arm &quot;trace path&quot;, then click another node): trace their connection &middot; Esc or background click: clear</span>
  </div>
  <svg id="graph-svg" xmlns="http://www.w3.org/2000/svg"></svg>
  <div id="detail-panel" hidden>
    <button id="detail-close" type="button" aria-label="Close">&times;</button>
    <h2>File</h2>
    <p id="trace-status" hidden></p>
    <span id="detail-path"></span>
    <dl>
      <dt>Symbols</dt><dd id="detail-symbols"></dd>
      <dt>In-degree</dt><dd id="detail-in"></dd>
      <dt>Out-degree</dt><dd id="detail-out"></dd>
      <dt>Dependents</dt><dd id="detail-dependents"></dd>
    </dl>
  </div>
</div>
<script type="application/json" id="lens-map-payload">${json}</script>
<script>
(function () {
  "use strict";
  var payloadEl = document.getElementById("lens-map-payload");
  var payload = JSON.parse(payloadEl.textContent || "{}");
  var nodes = payload.nodes || [];
  var edges = payload.edges || [];

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  setText("stat-files", String(payload.fileCount || 0));
  setText("stat-edges", String(payload.edgeCount || 0));
  setText("stat-external", String(payload.externalCount || 0));
  // The review graph itself excludes test files by role since #260, so this
  // count is normally 0 — only show the stat when the exclusion actually did
  // something (belt-and-braces against a future graph-scope change).
  if (payload.testFileCount > 0) {
    setText("stat-testfiles", String(payload.testFileCount));
    var tfWrap = document.getElementById("stat-testfiles-wrap");
    if (tfWrap) tfWrap.hidden = false;
  }
  // Compiled twins (X.js merged into its X.ts source) only occur in
  // compile-in-place projects — hide the stat when nothing was merged.
  if (payload.compiledTwinCount > 0) {
    setText("stat-twins", String(payload.compiledTwinCount));
    var twWrap = document.getElementById("stat-twins-wrap");
    if (twWrap) twWrap.hidden = false;
  }
  // Untracked-gitignored files dropped from the map (0 when the project is
  // not a git repo — the filter degrades to a no-op there): hide when zero.
  if (payload.ignoredFileCount > 0) {
    setText("stat-ignored", String(payload.ignoredFileCount));
    var igWrap = document.getElementById("stat-ignored-wrap");
    if (igWrap) igWrap.hidden = false;
  }
  setText("stat-generated", payload.generatedAt || "");
  setText("stat-project", payload.projectLabel || "");

  var truncationNote = document.getElementById("truncation-note");
  if (payload.truncated) {
    truncationNote.textContent =
      "Showing the " + payload.fileCount + " highest-degree files " +
      "(project exceeds the " + payload.maxNodes + "-file map cap).";
    truncationNote.hidden = false;
  }

  var svg = document.getElementById("graph-svg");
  if (nodes.length === 0) {
    var stage = document.getElementById("stage");
    var empty = document.createElement("div");
    empty.id = "empty-note";
    empty.textContent = "No files to map yet.";
    stage.replaceChild(empty, svg);
    return;
  }

  var svgNS = "http://www.w3.org/2000/svg";
  var width = payload.width || 1600;
  var height = payload.height || 1200;
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);

  var world = document.createElementNS(svgNS, "g");
  world.setAttribute("id", "world");
  svg.appendChild(world);
  var edgeGroup = document.createElementNS(svgNS, "g");
  world.appendChild(edgeGroup);
  var nodeGroup = document.createElementNS(svgNS, "g");
  world.appendChild(nodeGroup);

  var nodeById = {};
  nodes.forEach(function (n) { nodeById[n.id] = n; });

  var neighbors = {};
  nodes.forEach(function (n) { neighbors[n.id] = {}; });
  edges.forEach(function (e) {
    if (neighbors[e.from]) neighbors[e.from][e.to] = true;
    if (neighbors[e.to]) neighbors[e.to][e.from] = true;
  });

  // Edge records keep from/to/weight alongside the element so the single
  // visibility pass below can filter without re-reading DOM attributes.
  var edgeEls = [];
  edges.forEach(function (e) {
    var a = nodeById[e.from];
    var b = nodeById[e.to];
    if (!a || !b) return;
    var line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", String(a.x));
    line.setAttribute("y1", String(a.y));
    line.setAttribute("x2", String(b.x));
    line.setAttribute("y2", String(b.y));
    line.setAttribute("class", "edge");
    line.setAttribute("stroke-width", String(Math.min(4, 0.6 + Math.log2(e.weight + 1))));
    edgeGroup.appendChild(line);
    edgeEls.push({ el: line, from: e.from, to: e.to, weight: e.weight || 1 });
  });

  // Node fill: neutral brand-blue intensity scale by transitive dependents
  // ONLY (light #2563eb family / dark #60a5fa family) — NOT complexity-based.
  // Calibrated complexity-aware coloring is deferred to #306; wiring a second
  // color dimension here would guess at a scale nobody has validated yet.
  var isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  var loStop = isDark ? [30, 41, 59] : [219, 234, 254];
  var hiStop = isDark ? [96, 165, 250] : [37, 99, 235];
  function blueForRatio(ratio) {
    var t = Math.max(0, Math.min(1, ratio));
    var r = Math.round(loStop[0] + (hiStop[0] - loStop[0]) * t);
    var g = Math.round(loStop[1] + (hiStop[1] - loStop[1]) * t);
    var b = Math.round(loStop[2] + (hiStop[2] - loStop[2]) * t);
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  var maxDependents = nodes.reduce(function (m, n) { return Math.max(m, n.dependents || 0); }, 0) || 1;
  var minRadius = 5, maxRadius = 22;

  // Label culling: a label renders only when (zoomed in past LABEL_ZOOM) OR
  // (the node is in the top-25 by transitive dependents — the structurally
  // load-bearing files a viewer wants named at any zoom). Safe on tiny
  // graphs: slice(0, 25) of a 3-node list is just those 3.
  var LABEL_ZOOM = 1.5;
  var labelAlways = {};
  nodes.slice()
    .sort(function (a, b) { return (b.dependents || 0) - (a.dependents || 0); })
    .slice(0, 25)
    .forEach(function (n) { labelAlways[n.id] = true; });

  var nodeEls = {};
  nodes.forEach(function (n) {
    var g = document.createElementNS(svgNS, "g");
    g.setAttribute("class", "node");
    g.setAttribute("transform", "translate(" + n.x + "," + n.y + ")");
    g.dataset.id = n.id;

    var ratio = (n.dependents || 0) / maxDependents;
    var radius = minRadius + (maxRadius - minRadius) * Math.sqrt(ratio);

    var circle = document.createElementNS(svgNS, "circle");
    circle.setAttribute("r", String(radius));
    circle.setAttribute("fill", blueForRatio(ratio));
    circle.setAttribute("class", "node-circle");
    g.appendChild(circle);

    var title = document.createElementNS(svgNS, "title");
    title.textContent = n.path + " — " + n.symbolCount + " symbols, " + n.dependents + " dependents";
    g.appendChild(title);

    // Repo-derived string → textContent only, never markup (the #504-spike
    // discipline): the label is the path's last segment.
    var label = document.createElementNS(svgNS, "text");
    label.setAttribute("y", String(radius + 10));
    label.setAttribute("text-anchor", "middle");
    label.textContent = (n.path || "").split("/").pop() || n.path;
    g.appendChild(label);

    g.addEventListener("mouseenter", function () { hoverId = n.id; recomputeVisibility(); });
    g.addEventListener("mouseleave", function () { hoverId = null; recomputeVisibility(); });
    g.addEventListener("click", function (ev) { ev.stopPropagation(); onNodeClick(n, ev); });

    nodeGroup.appendChild(g);
    nodeEls[n.id] = g;
  });

  // ── Interaction state — composed by ONE visibility pass ───────────────────
  var hoverId = null;
  var searchTerm = "";
  var weightThreshold = 1;
  var selectedId = null;
  var traceArmed = false;
  var trace = null; // { found, nodeSet, edgeKeys } while a trace is displayed

  // Undirected edge identity (order-independent): NUL can never appear in a
  // file path, same idiom as the aggregation layer.
  function edgeKey(a, b) { return a < b ? a + "\\u0000" + b : b + "\\u0000" + a; }

  // The four interactions (search, weight filter, trace, label culling) all
  // funnel through this single pass instead of four fighting inline style
  // writers. Precedence for node/edge OPACITY: trace active > search filter
  // > weight-isolation fade (hover only narrows within what the winning
  // filter allows). The weight filter is a DISPLAY axis — edges below the
  // threshold hide entirely — with one exception: a traced-path edge always
  // shows, or the trace visual would have holes. Label culling only ever
  // affects labels, never circles or edges.
  function recomputeVisibility() {
    var searching = searchTerm.length > 0;
    var matches = {};
    if (searching) {
      nodes.forEach(function (n) {
        if ((n.path || "").toLowerCase().indexOf(searchTerm) !== -1) matches[n.id] = true;
      });
    }

    var tracing = trace !== null && trace.found;
    var visibleEdgeCount = 0;
    var touchedByVisibleEdge = {};
    edgeEls.forEach(function (e) {
      var passesWeight = e.weight >= weightThreshold;
      if (passesWeight) {
        visibleEdgeCount += 1;
        touchedByVisibleEdge[e.from] = true;
        touchedByVisibleEdge[e.to] = true;
      }
      var onTracePath = tracing && trace.edgeKeys[edgeKey(e.from, e.to)];
      var dimmed, active;
      if (trace !== null) {
        active = !!onTracePath;
        dimmed = !onTracePath;
      } else {
        active = hoverId !== null && (e.from === hoverId || e.to === hoverId);
        if (searching) {
          dimmed = !(matches[e.from] && matches[e.to]);
          if (!dimmed && hoverId !== null) dimmed = !active;
        } else {
          dimmed = hoverId !== null ? !active : false;
        }
      }
      e.el.classList.toggle("edge-hidden", !passesWeight && !onTracePath);
      e.el.classList.toggle("active", !!active);
      e.el.classList.toggle("dimmed", dimmed);
    });
    setText("weight-value", String(weightThreshold));
    setText("visible-edges", String(visibleEdgeCount));

    nodes.forEach(function (n) {
      var el = nodeEls[n.id];
      if (!el) return;
      var dimmed;
      var faded = false;
      if (trace !== null) {
        dimmed = !(tracing && trace.nodeSet[n.id]);
      } else if (searching) {
        dimmed = !matches[n.id];
        if (!dimmed && hoverId !== null) {
          dimmed = !(n.id === hoverId || (neighbors[hoverId] || {})[n.id]);
        }
      } else {
        dimmed = hoverId !== null
          ? !(n.id === hoverId || (neighbors[hoverId] || {})[n.id])
          : false;
        // Weight-isolation fade — lowest precedence, and a fade rather than
        // a removal: layout position stability matters more than reclaiming
        // the pixels.
        if (!dimmed && weightThreshold > 1 && !touchedByVisibleEdge[n.id]) faded = true;
      }
      el.classList.toggle("dimmed", dimmed);
      el.classList.toggle("faded", faded);
      el.classList.toggle("search-hit", searching && trace === null && !!matches[n.id]);
      el.classList.toggle("selected", n.id === selectedId);
      el.classList.toggle("trace-hit", tracing && !!trace.nodeSet[n.id]);
      var labelOn = !dimmed && !faded && (view.scale > LABEL_ZOOM || !!labelAlways[n.id]);
      el.classList.toggle("no-label", !labelOn);
    });
  }

  // Path tracing: BFS treating edges as UNDIRECTED — for "how are these two
  // files related", connectivity matters more than dependency direction
  // (whether A imports B or B imports A, a human tracing the map wants the
  // chain shown either way).
  function runTrace(fromId, toId) {
    var parent = {};
    parent[fromId] = fromId;
    var queue = [fromId];
    var found = false;
    while (queue.length > 0 && !found) {
      var next = [];
      for (var i = 0; i < queue.length && !found; i += 1) {
        var adj = neighbors[queue[i]] || {};
        for (var nid in adj) {
          if (parent[nid] !== undefined) continue;
          parent[nid] = queue[i];
          if (nid === toId) { found = true; break; }
          next.push(nid);
        }
      }
      queue = next;
    }
    var nodeSet = {};
    var edgeKeys = {};
    var hops = 0;
    if (found) {
      var cur = toId;
      nodeSet[cur] = true;
      while (cur !== fromId) {
        var p = parent[cur];
        edgeKeys[edgeKey(p, cur)] = true;
        nodeSet[p] = true;
        cur = p;
        hops += 1;
      }
    }
    trace = { found: found, nodeSet: nodeSet, edgeKeys: edgeKeys };
    var status = document.getElementById("trace-status");
    if (status) {
      status.textContent = found
        ? "Path: " + (hops + 1) + " files, " + hops + " hops."
        : "No path between the selected files.";
      status.hidden = false;
    }
    detailPanel.hidden = false;
  }

  function hideTraceStatus() {
    var status = document.getElementById("trace-status");
    if (status) status.hidden = true;
  }

  function onNodeClick(n, ev) {
    var wantsTrace = (ev.shiftKey || traceArmed) && selectedId !== null && selectedId !== n.id;
    if (wantsTrace) {
      runTrace(selectedId, n.id);
    } else {
      trace = null;
      hideTraceStatus();
      selectedId = n.id;
      showDetail(n);
    }
    recomputeVisibility();
  }

  function clearTraceAndSelection() {
    trace = null;
    selectedId = null;
    hideTraceStatus();
    detailPanel.hidden = true;
    recomputeVisibility();
  }

  var detailPanel = document.getElementById("detail-panel");
  function showDetail(n) {
    setText("detail-path", n.path);
    setText("detail-symbols", String(n.symbolCount));
    setText("detail-in", String(n.inDegree));
    setText("detail-out", String(n.outDegree));
    setText("detail-dependents", String(n.dependents));
    detailPanel.hidden = false;
  }
  document.getElementById("detail-close").addEventListener("click", function () {
    detailPanel.hidden = true;
  });
  svg.addEventListener("click", clearTraceAndSelection);
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") clearTraceAndSelection();
  });

  // ── Controls wiring ───────────────────────────────────────────────────────
  var searchInput = document.getElementById("search-input");
  if (searchInput) {
    // No debounce: recomputeVisibility is a single O(nodes+edges) pass and
    // the map caps at CHOCO_PI_LSP_MAP_MAX_NODES (500 default) — cheap per input.
    searchInput.addEventListener("input", function () {
      searchTerm = searchInput.value.trim().toLowerCase();
      recomputeVisibility();
    });
  }
  var maxWeight = edges.reduce(function (m, e) { return Math.max(m, e.weight || 1); }, 1);
  var slider = document.getElementById("weight-slider");
  if (slider) {
    slider.max = String(maxWeight);
    slider.addEventListener("input", function () {
      weightThreshold = Number(slider.value) || 1;
      recomputeVisibility();
    });
  }
  var traceToggle = document.getElementById("trace-toggle");
  if (traceToggle) {
    traceToggle.addEventListener("click", function () {
      traceArmed = !traceArmed;
      traceToggle.setAttribute("aria-pressed", traceArmed ? "true" : "false");
    });
  }

  // Pan (drag background) + zoom (wheel).
  var view = { x: 0, y: 0, scale: 1 };
  var dragging = false, lastX = 0, lastY = 0;
  function applyTransform() {
    world.setAttribute("transform", "translate(" + view.x + "," + view.y + ") scale(" + view.scale + ")");
  }
  svg.addEventListener("pointerdown", function (ev) {
    dragging = true;
    lastX = ev.clientX;
    lastY = ev.clientY;
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener("pointermove", function (ev) {
    if (!dragging) return;
    view.x += ev.clientX - lastX;
    view.y += ev.clientY - lastY;
    lastX = ev.clientX;
    lastY = ev.clientY;
    applyTransform();
  });
  svg.addEventListener("pointerup", function () { dragging = false; });
  svg.addEventListener("pointercancel", function () { dragging = false; });
  svg.addEventListener("wheel", function (ev) {
    ev.preventDefault();
    var delta = ev.deltaY > 0 ? 0.9 : 1.1;
    view.scale = Math.max(0.15, Math.min(6, view.scale * delta));
    applyTransform();
    // Zoom crossing LABEL_ZOOM changes which labels render.
    recomputeVisibility();
  }, { passive: false });
  applyTransform();
  recomputeVisibility();
})();
</script>
</body>
</html>
`;
}

export interface GenerateLensMapResult {
  filePath: string;
  fileCount: number;
  edgeCount: number;
  truncated: boolean;
  externalCount: number;
  testFileCount: number;
  compiledTwinCount: number;
  ignoredFileCount: number;
}

function resolveMaxNodes(): number {
  const raw = process.env.CHOCO_PI_LSP_MAP_MAX_NODES?.trim();
  if (!raw) return DEFAULT_MAX_MAP_NODES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_MAP_NODES;
}

export { parseUntrackedIgnoredOutput } from "./git-tracked-ignore.ts";

function toDisplayPath(p: string, projectRoot: string): string {
  return toProjectRelativePath(p, projectRoot);
}

export async function generateLensMap(cwd: string): Promise<GenerateLensMapResult> {
  const facts = new FactStore();
  const excludeIdsPromise = collectUntrackedIgnoredIds(cwd);
  const graph = await buildOrUpdateGraph(cwd, [], facts);
  const excludeIds = await excludeIdsPromise;

  const maxNodes = resolveMaxNodes();
  const aggregated = aggregateGraphToFiles(graph, { maxNodes, excludeIds });

  const displayNodes: FileMapNode[] = aggregated.nodes.map((node) => ({
    ...node,
    path: toDisplayPath(node.path, cwd),
  }));

  const width = DEFAULT_LAYOUT_WIDTH;
  const height = DEFAULT_LAYOUT_HEIGHT;
  const layout = computeLayout(displayNodes, aggregated.edges, {
    width,
    height,
  });
  const positionById = new Map(layout.map((p) => [p.id, p]));

  const payloadNodes: LensMapPayloadNode[] = displayNodes.map((node) => {
    const point = positionById.get(node.id);
    return { ...node, x: point?.x ?? width / 2, y: point?.y ?? height / 2 };
  });

  const payload: LensMapPayload = {
    generatedAt: new Date().toISOString(),
    projectLabel: path.basename(path.resolve(cwd)),
    fileCount: aggregated.nodes.length,
    edgeCount: aggregated.edges.length,
    externalCount: aggregated.externalCount,
    testFileCount: aggregated.testFileCount,
    compiledTwinCount: aggregated.compiledTwinCount,
    ignoredFileCount: aggregated.ignoredFileCount,
    truncated: aggregated.truncated,
    maxNodes,
    width,
    height,
    nodes: payloadNodes,
    edges: aggregated.edges,
  };

  const html = renderMapHtml(payload);
  const outDir = path.join(getProjectDataDir(cwd), "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, "lens-map.html");
  fs.writeFileSync(filePath, html, "utf-8");

  return {
    filePath,
    fileCount: aggregated.nodes.length,
    edgeCount: aggregated.edges.length,
    truncated: aggregated.truncated,
    externalCount: aggregated.externalCount,
    testFileCount: aggregated.testFileCount,
    compiledTwinCount: aggregated.compiledTwinCount,
    ignoredFileCount: aggregated.ignoredFileCount,
  };
}
