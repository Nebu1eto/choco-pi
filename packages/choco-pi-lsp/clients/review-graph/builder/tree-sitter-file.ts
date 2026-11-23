/**
 * Tree-sitter symbol extraction for non-JS/TS files, structural IR capture, and LSP fallback symbols.
 */
import { includePropertiesWhen } from "../../optional-properties.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FactStore } from "../../dispatch/fact-store.ts";
import type { FunctionSummary } from "../../dispatch/facts/function-facts.ts";
import type { ImportEntry, ReExportEntry } from "../../dispatch/facts/import-facts.ts";
import { featureHintMetadata } from "../../feature-hints.ts";
import { detectFileKind } from "../../file-kinds.ts";
import { detectFileRole } from "../../file-role.ts";
import { containerNameChain, lspSymbolKindName } from "../../lsp-document-symbols.ts";
import type { LSPSymbol } from "../../lsp/client.ts";
import { normalizeMapKey, toProjectRelativePath } from "../../path-utils.ts";
import { resolveImportToFiles } from "../import-resolvers.ts";
import { buildQualifiedName, findOwnerName } from "../../symbol-containment.ts";
import { getSharedTreeSitterClient } from "../../tree-sitter-shared.ts";
import {
  type ExtractedSymbols,
  TreeSitterSymbolExtractor,
} from "../../tree-sitter-symbol-extractor.ts";
import { withTreeSitterRoot } from "../../tree-sitter-shared.ts";
import { buildSymbolId } from "../symbol-id.ts";
import type { ReviewGraph } from "../types.ts";
import type {
  ReviewGraphExtractionStatus,
  ReviewGraphStructuralIr,
} from "../shared-extraction-ir.ts";
import { ensureFileNode } from "./file-update.ts";
import { addEdge, addNode } from "./graph-state.ts";
import { ensureReviewGraphFacts } from "./js-ts-file.ts";
import { MAIN_KINDS, extractorCache } from "./workspace-cache.ts";

export function mapKindToTreeSitterLanguage(
  kind: string | undefined,
  filePath?: string,
): string | undefined {
  switch (kind) {
    case "python":
      return "python";
    case "go":
      return "go";
    case "rust":
      return "rust";
    case "ruby":
      return "ruby";
    case "cxx": {
      const ext = filePath ? path.extname(filePath).toLowerCase() : "";
      return ext === ".c" || ext === ".h" ? "c" : "cpp";
    }
    case "java":
      return "java";
    case "kotlin":
      return "kotlin";
    case "dart":
      return "dart";
    case "elixir":
      return "elixir";
    case "csharp":
      return "csharp";
    case "php":
      return "php";
    case "swift":
      return "swift";
    case "lua":
      return "lua";
    case "ocaml":
      return "ocaml";
    case "zig":
      return "zig";
    case "shell":
      return "bash";
    default:
      return undefined;
  }
}

async function getExtractor(languageId: string): Promise<TreeSitterSymbolExtractor | null> {
  if (extractorCache.has(languageId)) return extractorCache.get(languageId)!;
  const client = getSharedTreeSitterClient();
  if (!client) return null;
  const extractor = new TreeSitterSymbolExtractor(languageId, client);
  const ok = await extractor.init();
  if (!ok) {
    // Memoize failures too (#955 review): the scan loop probes the
    // extractor once per file, and an unmemoized grammar-load failure
    // re-attempted resolution (possibly a lazy fetch) for every file of
    // that language. A restart re-probes; within a process, one verdict.
    extractorCache.set(languageId, null);
    return null;
  }
  extractorCache.set(languageId, extractor);
  return extractor;
}

export async function extractTreeSitterSymbols(
  filePath: string,
  languageId: string,
  contentOverride?: string | null,
): Promise<ExtractedSymbols> {
  const empty: ExtractedSymbols = {
    symbols: [],
    refs: [],
    imports: [],
    coverage: {
      definitions: "unavailable",
      references: "unavailable",
      imports: "unavailable",
    },
  };
  if (contentOverride === null) return empty;
  const treeSitterClient = getSharedTreeSitterClient();
  if (!treeSitterClient) return empty;
  const initialized = await treeSitterClient.init();
  if (!initialized) return empty;
  const extractor = await getExtractor(languageId);
  if (!extractor) return empty;
  const content = contentOverride ?? fs.readFileSync(filePath, "utf-8");
  const extracted = await treeSitterClient.withParsedTree(filePath, languageId, content, (tree) =>
    extractor.extract(tree, filePath, content),
  );
  return extracted.parsed ? extracted.value : empty;
}

/**
 * Extract the compact graph-facing facts while the scanner's parse is still
 * hot. The caller publishes the result only after every consumer of that file
 * has completed, so cancellation can never expose an in-progress entry.
 */
export async function captureReviewGraphStructuralIr(
  filePath: string,
  cwd: string,
  content: string,
  facts: FactStore,
): Promise<{ complete: boolean; structural?: ReviewGraphStructuralIr }> {
  const kind = detectFileKind(filePath);
  if (!kind || !MAIN_KINDS.has(kind) || detectFileRole(filePath) === "test") {
    return { complete: true };
  }
  if (kind === "jsts") {
    if (
      !facts.hasFileFact(filePath, "file.imports") ||
      !facts.hasFileFact(filePath, "file.reexports") ||
      !facts.hasFileFact(filePath, "file.functionSummaries")
    ) {
      await ensureReviewGraphFacts(filePath, cwd, facts, content);
    }
    const parsed = await withTreeSitterRoot(filePath, content, () => true);
    if (!parsed.parsed) return { complete: false };
    const functionCoverage: ReviewGraphExtractionStatus =
      // SAFETY: The fact-store, parser, or cache producer establishes this review-graph shape; adjacent checks reject unavailable values.
      (facts.getFileFact<string>(filePath, "file.functionFactsCoverage") as
        | ReviewGraphExtractionStatus
        | undefined) ?? "unavailable";
    const importCoverage: ReviewGraphExtractionStatus =
      // SAFETY: The fact-store, parser, or cache producer establishes this review-graph shape; adjacent checks reject unavailable values.
      (facts.getFileFact<string>(filePath, "file.importFactsCoverage") as
        | ReviewGraphExtractionStatus
        | undefined) ?? "unavailable";
    const coverage = {
      definitions: functionCoverage,
      references: functionCoverage,
      imports: importCoverage,
      calls: functionCoverage,
    } as const;
    if (Object.values(coverage).some((status) => status !== "complete")) {
      return { complete: false };
    }
    return {
      complete: true,
      structural: {
        kind: "jsts",
        imports: facts.getFileFact<ImportEntry[]>(filePath, "file.imports") ?? [],
        reexports: facts.getFileFact<ReExportEntry[]>(filePath, "file.reexports") ?? [],
        functionSummaries:
          facts.getFileFact<FunctionSummary[]>(filePath, "file.functionSummaries") ?? [],
        coverage,
      },
    };
  }
  const languageId = mapKindToTreeSitterLanguage(kind, filePath);
  // A graph-relevant kind without a tree-sitter mapping is unsupported, not
  // an empty successful extraction. Do not publish a complete IR for it.
  if (!languageId) return { complete: false };
  const client = getSharedTreeSitterClient();
  if (!client || !(await client.init())) return { complete: false };
  const extractor = await getExtractor(languageId);
  if (!extractor) return { complete: false };
  const result = await client.withParsedTree(filePath, languageId, content, (tree) =>
    extractor.extract(tree, filePath, content),
  );
  if (!result.parsed) return { complete: false };
  return {
    complete: true,
    structural: {
      kind: "tree-sitter",
      languageId,
      extracted: result.value,
    },
  };
}

// #655: some grammars' SYMBOL_QUERIES match the SAME declaration node under two
// patterns — e.g. python's generic `function_definition` rule also matches a
// method's `function_definition` nested inside a class body, in addition to
// the class-scoped "method" rule (tree-sitter-symbol-extractor.ts has no
// `#not-`-style scope predicate to exclude it). `extract()` then yields TWO
// Symbol records for one real declaration: identical name/line/column,
// differing only in `kind` ("function" vs "method"). The pre-#655
// `${file}:${name}` ID silently collapsed these onto one node (`Map.set`
// overwrote by name, last-extracted kind winning in whatever order
// `Query.matches` returned). The new kind-qualified ID would otherwise turn
// that pre-existing extractor quirk into two REAL, persisted duplicate nodes
// for one symbol — so dedupe by (name, line, column) here, preferring the
// more specific kind, keeping exactly one node per real declaration regardless
// of how many query patterns matched it.
interface SymbolKindSpecificity {
  [kind: string]: number;
}

const SYMBOL_KIND_SPECIFICITY: SymbolKindSpecificity = {
  method: 2,
  property: 2,
};

function dedupeSamePositionSymbols(
  symbols: ExtractedSymbols["symbols"],
): ExtractedSymbols["symbols"] {
  const bestByKey = new Map<string, ExtractedSymbols["symbols"][number]>();
  for (const symbol of symbols) {
    const key = `${symbol.name}0000${symbol.line}0000${symbol.column}`;
    const existing = bestByKey.get(key);
    if (!existing) {
      bestByKey.set(key, symbol);
      continue;
    }
    const existingScore = SYMBOL_KIND_SPECIFICITY[existing.kind] ?? 0;
    const candidateScore = SYMBOL_KIND_SPECIFICITY[symbol.kind] ?? 0;
    if (candidateScore > existingScore) bestByKey.set(key, symbol);
  }
  return [...bestByKey.values()];
}

export function addTreeSitterFile(
  graph: ReviewGraph,
  cwd: string,
  filePath: string,
  languageId: string,
  extracted: ExtractedSymbols,
  ignoredIds?: ReadonlySet<string>,
): void {
  const normalized = normalizeMapKey(filePath);
  const hintPath = toProjectRelativePath(normalized, cwd);
  const fileNodeId = `file:${normalized}`;
  addNode(graph, {
    id: fileNodeId,
    kind: "file",
    language: languageId,
    filePath: normalized,
    metadata: {
      ...featureHintMetadata(hintPath),
      extractionCoverage: extracted.coverage,
    },
  });

  const dedupedSymbols = dedupeSamePositionSymbols(extracted.symbols);
  // refs #655 phase 2: qualified (owner-chain) display name, computed via the
  // SAME strict-containment/smallest-span algorithm module-report.ts's outline
  // nesting (`nestEntries`, #301) uses over its own tree-sitter-symbol-extractor
  // output — see symbol-containment.ts. Candidates are the file's OWN deduped
  // symbol list; a symbol with no strictly-containing entry (top-level) gets
  // no qualifiedName.
  const containers = dedupedSymbols.map((s) => ({
    name: s.name,
    startLine: s.line,
    endLine: s.endLine ?? s.line,
  }));

  for (const symbol of dedupedSymbols) {
    const symbolId = buildSymbolId(normalized, symbol.name, symbol.kind, symbol.line);
    const owner = findOwnerName(containers, symbol.line, symbol.endLine ?? symbol.line);
    const qualifiedName = buildQualifiedName(owner, symbol.name);
    addNode(graph, {
      id: symbolId,
      kind: "symbol",
      language: languageId,
      filePath: normalized,
      symbolName: symbol.name,
      symbolKind: symbol.kind,
      ...includePropertiesWhen(qualifiedName, () => ({ qualifiedName })),
      exported: symbol.isExported,
      metadata: {
        line: symbol.line,
        endLine: symbol.endLine,
        column: symbol.column,
        signature: symbol.signature,
        ...featureHintMetadata(`${symbol.name} ${hintPath}`),
      },
    });
    addEdge(graph, { from: fileNodeId, to: symbolId, kind: "contains" });
    addEdge(graph, { from: fileNodeId, to: symbolId, kind: "defines" });
  }

  for (const ref of extracted.refs) {
    const refName = ref.symbolName ?? ref.symbolId;
    const targetId = `symbol-name:${refName}`;
    if (!graph.nodes.has(targetId)) {
      addNode(graph, {
        id: targetId,
        kind: "symbol",
        language: languageId,
        symbolName: refName,
        metadata: { unresolvedName: refName },
      });
    }
    addEdge(graph, {
      from: fileNodeId,
      to: targetId,
      kind: "references",
      metadata: {
        line: ref.line,
        column: ref.column,
        referenceKind: ref.referenceKind ?? "unknown",
      },
      // Always starts bare-name-only (the extractor has no scope/type info);
      // resolveDeferredSymbolEdges may upgrade this to "exact" below.
      resolution: "name-only",
    });
  }

  // #249: import edges for tree-sitter languages. First try to resolve the
  // source to in-project FILE(s) (ruby/zig/bash/dart relative paths, python
  // dotted modules, go package dirs, java source-root files — see
  // import-resolvers.ts); on success emit real file→file edges like jsts/cxx.
  // An unresolvable source (stdlib, third-party, namespace-only langs) falls
  // back to an UNRESOLVED external/module node — never a fabricated file edge.
  for (const imp of extracted.imports) {
    // #694: drop any resolved target that's untracked-AND-gitignored (a build
    // artifact with no surviving source twin) BEFORE deciding resolved vs
    // unresolved — a fully-filtered-out result falls through to the same
    // unresolved module/external placeholder below, never a fabricated
    // ignored-file node.
    const resolved = resolveImportToFiles(cwd, filePath, languageId, imp.source).filter(
      (target) => !ignoredIds?.has(target),
    );
    if (resolved.length > 0) {
      for (const target of resolved) {
        const toNode = ensureFileNode(
          graph,
          target,
          cwd,
          mapKindToTreeSitterLanguage(detectFileKind(target), target) ?? languageId,
        );
        addEdge(graph, {
          from: fileNodeId,
          to: toNode,
          kind: "imports",
          metadata: { line: imp.line, source: imp.source },
        });
      }
      continue;
    }
    const isRelative = imp.source.startsWith(".");
    const targetId = `${isRelative ? "module" : "external"}:${imp.source}`;
    if (!graph.nodes.has(targetId)) {
      addNode(graph, {
        id: targetId,
        kind: isRelative ? "module" : "external",
        language: languageId,
        metadata: { source: imp.source },
      });
    }
    addEdge(graph, {
      from: fileNodeId,
      to: targetId,
      kind: "imports",
      metadata: { line: imp.line },
    });
  }
}

/**
 * Add documentSymbol results only after tree-sitter produced no declarations.
 * Hierarchical responses preserve their parent/child containment. Flat
 * SymbolInformation results (including native TypeScript 7) recover the same
 * containment through `containerName` when the owner is present in the result.
 */
export function addLspFallbackSymbols(
  graph: ReviewGraph,
  filePath: string,
  languageId: string,
  symbols: LSPSymbol[],
): number {
  const normalized = normalizeMapKey(filePath);
  const fileNodeId = `file:${normalized}`;
  let added = 0;
  const flatOwnerIds = new Map<string, string>();
  for (const symbol of symbols) {
    const range = symbol.range ?? symbol.location?.range;
    if (!range) continue;
    const kind = lspSymbolKindName(symbol.kind);
    const id = buildSymbolId(normalized, symbol.name, kind, range.start.line + 1);
    flatOwnerIds.set(symbol.name, id);
    if (symbol.containerName) {
      flatOwnerIds.set(`${symbol.containerName}.${symbol.name}`, id);
    }
  }
  const visit = (items: LSPSymbol[], parentId: string, ancestry: string[]): void => {
    for (const symbol of items) {
      const range = symbol.range ?? symbol.location?.range;
      if (!range) continue;
      const line = range.start.line + 1;
      const kind = lspSymbolKindName(symbol.kind);
      const symbolId = buildSymbolId(normalized, symbol.name, kind, line);
      // Shared with the read-path enrichment (#951 Sonar dedup): flat
      // results qualify through the full containerName chain, not just
      // the immediate owner.
      const owners = ancestry.length > 0 ? ancestry : containerNameChain(symbol, symbols);
      const qualifiedName = owners.length > 0 ? [...owners, symbol.name].join(".") : undefined;
      addNode(graph, {
        id: symbolId,
        kind: "symbol",
        language: languageId,
        filePath: normalized,
        symbolName: symbol.name,
        symbolKind: kind,
        ...includePropertiesWhen(qualifiedName, () => ({ qualifiedName })),
        provenance: "lsp",
        metadata: {
          line,
          column: range.start.character,
          endLine: range.end.line + 1,
          ...featureHintMetadata(`${symbol.name} ${normalized}`),
        },
      });
      const resolvedParentId =
        ancestry.length === 0 && symbol.containerName
          ? (flatOwnerIds.get(symbol.containerName) ?? parentId)
          : parentId;
      addEdge(graph, {
        from: resolvedParentId,
        to: symbolId,
        kind: "contains",
      });
      addEdge(graph, { from: fileNodeId, to: symbolId, kind: "defines" });
      added++;
      if (symbol.children) {
        visit(symbol.children, symbolId, [...owners, symbol.name]);
      }
    }
  };
  visit(symbols, fileNodeId, []);
  return added;
}
