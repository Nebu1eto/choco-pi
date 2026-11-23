/**
 * JavaScript/TypeScript file extraction into the review graph (imports, symbols, facts).
 */
import { includePropertiesWhen } from "../../optional-properties.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FactStore } from "../../dispatch/fact-store.ts";
import { fileContentProvider } from "../../dispatch/facts/file-content.ts";
import type { FunctionSummary } from "../../dispatch/facts/function-facts.ts";
import type { ImportEntry } from "../../dispatch/facts/import-facts.ts";
import { featureHintMetadata } from "../../feature-hints.ts";
import { detectFileKind } from "../../file-kinds.ts";
import { detectFileRole } from "../../file-role.ts";
import { normalizeMapKey, toProjectRelativePath } from "../../path-utils.ts";
import {
  jsTsCandidatePaths,
  resolveAliasedImport,
  resolveProjectReferenceImport,
  resolveWorkspacePackageImport,
} from "../import-resolvers.ts";
import { buildQualifiedName } from "../../symbol-containment.ts";
import { logReviewGraph } from "../../review-graph-logger.ts";
import { buildSymbolId } from "../symbol-id.ts";
import type { ReviewGraph } from "../types.ts";
import { addEdge, addNode, escapeRegExp, makeCtx } from "./graph-state.ts";
import { CHANGED_SYMBOLS_PREFIX } from "./workspace-cache.ts";

/**
 * Resolve a relative ESM import to an in-project file — the warm jsts
 * counterpart to import-resolvers.ts's `resolveJsTs` (the cold module_report
 * path). Both share `jsTsCandidatePaths`'s SOURCE-TWIN-PREFERRING candidate
 * order (#694: try `.ts`/`.tsx`/`.mts`/`.cts` before the literal/compiled
 * extension) so a repo that compiles in place never diverges on which of the
 * two an import edge lands on.
 *
 * `ignoredIds` (#694): when the first existing candidate is untracked-AND-
 * gitignored (a build artifact with no surviving source twin — see
 * git-tracked-ignore.ts), it is skipped rather than returned, so the ignore
 * invariant (#243) reaches import-resolution-created nodes too, not just the
 * initial file walk. Undefined ⇒ no filtering (the fetch degraded or wasn't
 * requested).
 *
 * A bare specifier (`react`, `@scope/pkg[/subpath]`) is resolved against
 * known workspace package names (#775) via `resolveWorkspacePackageImport` —
 * the same resolver the cold module_report path (`resolveJsTs`) uses — before
 * falling back to `undefined` (external dep, unchanged behavior).
 */
function localImportToFile(
  cwd: string,
  filePath: string,
  source: string,
  ignoredIds?: ReadonlySet<string>,
): string | undefined {
  if (!source.startsWith(".")) {
    const aliased = resolveAliasedImport(cwd, source, path.dirname(filePath));
    const referenced = aliased.length
      ? []
      : resolveProjectReferenceImport(cwd, source, path.dirname(filePath));
    const resolved = aliased.length
      ? aliased
      : referenced.length
        ? referenced
        : resolveWorkspacePackageImport(cwd, source);
    for (const normalized of resolved) {
      if (ignoredIds?.has(normalized)) continue;
      return normalized;
    }
    return undefined;
  }
  const root = path.resolve(cwd);
  for (const candidate of jsTsCandidatePaths(filePath, source)) {
    const relative = path.relative(root, candidate);
    if (
      (relative.startsWith("..") &&
        (relative.length === 2 || relative.startsWith(`..${path.sep}`))) ||
      path.isAbsolute(relative) ||
      !fs.existsSync(candidate)
    )
      continue;
    const normalized = normalizeMapKey(candidate);
    if (ignoredIds?.has(normalized)) continue;
    return normalized;
  }
  return undefined;
}

export function upsertChangedSymbols(graph: ReviewGraph, facts: FactStore, filePath: string): void {
  // #260: tests aren't in the graph, so don't track their changed symbols.
  if (detectFileRole(filePath) === "test") return;
  const normalized = normalizeMapKey(filePath);
  const changed = facts.getSessionFact<string[]>(`${CHANGED_SYMBOLS_PREFIX}${normalized}`);
  if (changed && changed.length > 0) {
    graph.changedSymbolsByFile.set(normalized, [...changed]);
  } else {
    graph.changedSymbolsByFile.delete(normalized);
  }
}

export async function ensureReviewGraphFacts(
  filePath: string,
  cwd: string,
  facts: FactStore,
  contentOverride?: string | null,
): Promise<void> {
  const ctx = makeCtx(filePath, cwd, facts);
  if (contentOverride === undefined) {
    await fileContentProvider.run(ctx, facts);
  } else {
    facts.setFileFact(filePath, "file.content", contentOverride);
  }
  // The import/function fact providers parse via the shared tree-sitter client
  // (#419/#402 — no `typescript` compiler). Loaded on demand + run here so
  // file.imports / file.reexports / file.functionSummaries are populated before
  // the graph reads them; if the parse stack is unavailable the graph builds
  // without structural facts rather than failing (the shared client loads
  // web-tree-sitter lazily, so that degrade otherwise lives at client.init()).
  try {
    const [{ importFactProvider }, { functionFactProvider }] = await Promise.all([
      import("../../dispatch/facts/import-facts.ts"),
      import("../../dispatch/facts/function-facts.ts"),
    ]);
    // Both providers are async (tree-sitter parse) — await so the facts are
    // populated before the graph reads them.
    await importFactProvider.run(ctx, facts);
    await functionFactProvider.run(ctx, facts);
    // choco-pi-lsp-ignore: missing-error-propagation
  } catch (err) {
    logReviewGraph({
      cwd,
      phase: "build_skipped",
      reason: "structural_facts_disabled",
      // SAFETY: The fact-store, parser, or cache producer establishes this review-graph shape; adjacent checks reject unavailable values.
      error: (err as Error)?.message ?? String(err),
    });
  }
}

export function addJsTsFile(
  graph: ReviewGraph,
  cwd: string,
  filePath: string,
  facts: FactStore,
  ignoredIds?: ReadonlySet<string>,
): void {
  const normalized = normalizeMapKey(filePath);
  const hintPath = toProjectRelativePath(normalized, cwd);
  const content = facts.getFileFact<string>(normalized, "file.content") ?? "";
  const fileNodeId = `file:${normalized}`;
  // The function-facts provider uses the shared tree-sitter integration for
  // both TypeScript and JavaScript-family grammars. Do not suppress JS call
  // evidence merely because import resolution may canonicalize a compiled twin
  // onto its source; the graph must describe every supported source file, and
  // lens-map performs the separate presentation-level twin merge.
  const warmCallCoverage =
    facts.getFileFact<string>(normalized, "file.functionFactsCoverage") ?? "unavailable";
  const importCoverage =
    facts.getFileFact<string>(normalized, "file.importFactsCoverage") ?? "unavailable";
  addNode(graph, {
    id: fileNodeId,
    kind: "file",
    language: "jsts",
    filePath: normalized,
    metadata: {
      lineCount: content.split("\n").length,
      extractionCoverage: {
        definitions: warmCallCoverage,
        references: warmCallCoverage,
        imports: importCoverage,
        calls: warmCallCoverage,
      },
      ...featureHintMetadata(hintPath),
    },
  });

  const imports = facts.getFileFact<ImportEntry[]>(normalized, "file.imports") ?? [];
  const functions =
    facts.getFileFact<FunctionSummary[]>(normalized, "file.functionSummaries") ?? [];

  for (const entry of imports) {
    const localFile = localImportToFile(cwd, normalized, entry.source, ignoredIds);
    if (localFile) {
      const targetId = `file:${localFile}`;
      if (!graph.nodes.has(targetId)) {
        addNode(graph, {
          id: targetId,
          kind: "file",
          language: detectFileKind(localFile) ?? "jsts",
          filePath: localFile,
        });
      }
      addEdge(graph, { from: fileNodeId, to: targetId, kind: "imports" });
    } else {
      const targetId = `${entry.source.startsWith(".") ? "module" : "external"}:${entry.source}`;
      if (!graph.nodes.has(targetId)) {
        addNode(graph, {
          id: targetId,
          kind: entry.source.startsWith(".") ? "module" : "external",
          language: "jsts",
          metadata: { source: entry.source },
        });
      }
      addEdge(graph, { from: fileNodeId, to: targetId, kind: "imports" });
    }
  }

  // refs #655 phase 2 ("import" resolution tier): a bare-name callee that
  // matches a named/default import specifier hints exactly which in-project
  // FILE it should resolve against, narrowing resolveDeferredSymbolEdges'
  // candidate search below (before it falls back to the graph-wide
  // uniqueness check). Only local (in-project) import sources produce a
  // hint — third-party/stdlib imports have no graph file to narrow to.
  const importedNameToFile = new Map<string, string>();
  for (const entry of imports) {
    const localFile = localImportToFile(cwd, normalized, entry.source, ignoredIds);
    if (!localFile) continue;
    for (const name of entry.names) importedNameToFile.set(name, localFile);
    if (entry.defaultName) importedNameToFile.set(entry.defaultName, localFile);
  }

  // refs #655 phase 2 (qualified names + "receiver-type" resolution): build
  // the per-file `Owner.method -> symbolId[]` map alongside each node so the
  // second pass below (call-site resolution) can look up SAME-FILE receiver
  // types without a second traversal. Collecting ALL matches (not just the
  // last-written one) lets the resolver below tell "exactly one real target"
  // apart from "this owner+name pair is itself ambiguous" (duplicate/overload
  // declarations sharing one qualified name) — the latter must stay
  // "name-only", never guess one of the 2+ candidates.
  const methodsByQualifiedName = new Map<string, string[]>();
  for (const fn of functions) {
    const symbolId = buildSymbolId(normalized, fn.name, "function", fn.line);
    const qualifiedName = buildQualifiedName(fn.owner, fn.name);
    if (qualifiedName) {
      const existing = methodsByQualifiedName.get(qualifiedName) ?? [];
      existing.push(symbolId);
      methodsByQualifiedName.set(qualifiedName, existing);
    }
    addNode(graph, {
      id: symbolId,
      kind: "symbol",
      language: "jsts",
      filePath: normalized,
      symbolName: fn.name,
      symbolKind: "function",
      ...includePropertiesWhen(qualifiedName, () => ({ qualifiedName })),
      exported: new RegExp(
        String.raw`export\s+(?:async\s+)?(?:function|const|let|var)\s+${escapeRegExp(fn.name)}\b`,
      ).test(content),
      metadata: {
        line: fn.line,
        endLine: fn.endLine,
        column: fn.column,
        cyclomaticComplexity: fn.cyclomaticComplexity,
        maxNestingDepth: fn.maxNestingDepth,
        isBoundaryWrapper: fn.isBoundaryWrapper,
        isPassThroughWrapper: fn.isPassThroughWrapper,
        ...featureHintMetadata(`${fn.name} ${hintPath}`),
      },
    });
    addEdge(graph, { from: fileNodeId, to: symbolId, kind: "contains" });
    addEdge(graph, { from: fileNodeId, to: symbolId, kind: "defines" });
  }

  for (const fn of functions) {
    const symbolId = buildSymbolId(normalized, fn.name, "function", fn.line);
    // Member call sites (`obj.method()`) with a same-file, structurally
    // determinable receiver type resolve directly here — refs #655 phase 2
    // "receiver-type" tier. Skip their text form in the outgoingCalls loop
    // below (memberCallText) so the same call site doesn't double-edge.
    const memberCallTexts = new Set<string>();
    for (const site of fn.memberCallSites ?? []) {
      const callText = `${site.receiver}.${site.method}`;
      memberCallTexts.add(callText);
      const receiverClass = fn.receiverTypes?.[site.receiver];
      const candidates = receiverClass
        ? (methodsByQualifiedName.get(`${receiverClass}.${site.method}`) ?? [])
        : [];
      if (candidates.length === 1) {
        addEdge(graph, {
          from: symbolId,
          to: candidates[0],
          kind: "calls",
          metadata: {
            unresolvedName: callText,
            receiver: site.receiver,
            receiverType: receiverClass,
          },
          resolution: "receiver-type",
        });
        continue;
      }
      if (candidates.length > 1) {
        // The receiver's class is known, but that class has 2+ same-named
        // methods (duplicate/overload declarations) — the owner+name pair
        // itself is ambiguous. Point at a qualified-name placeholder (not the
        // bare-name one, which would incorrectly conflate this with unrelated
        // same-named methods elsewhere) and stay "name-only": never guess
        // which of the 2+ candidates this call reaches.
        const qualifiedPlaceholderId = `symbol-qualified-name:${receiverClass}.${site.method}`;
        if (!graph.nodes.has(qualifiedPlaceholderId)) {
          addNode(graph, {
            id: qualifiedPlaceholderId,
            kind: "symbol",
            language: "jsts",
            symbolName: site.method,
            qualifiedName: `${receiverClass}.${site.method}`,
            metadata: {
              unresolvedName: callText,
              ambiguousCandidates: candidates.length,
            },
          });
        }
        addEdge(graph, {
          from: symbolId,
          to: qualifiedPlaceholderId,
          kind: "calls",
          metadata: {
            unresolvedName: callText,
            receiver: site.receiver,
            receiverType: receiverClass,
          },
          resolution: "name-only",
        });
        continue;
      }
      // Receiver type unknown — falls back to the same "definite external"
      // placeholder the pre-#655 code used for every dotted call;
      // conservative (never claims a resolution tier it can't back up).
      const externalId = `external:${callText}`;
      if (!graph.nodes.has(externalId)) {
        addNode(graph, {
          id: externalId,
          kind: "external",
          language: "jsts",
          metadata: { unresolvedName: callText },
        });
      }
      addEdge(graph, {
        from: symbolId,
        to: externalId,
        kind: "calls",
        metadata: { unresolvedName: callText },
      });
    }

    for (const callee of fn.outgoingCalls) {
      if (memberCallTexts.has(callee)) continue;
      const targetId = callee.includes(".") ? `external:${callee}` : `symbol-name:${callee}`;
      if (!graph.nodes.has(targetId)) {
        addNode(graph, {
          id: targetId,
          kind: callee.includes(".") ? "external" : "symbol",
          language: "jsts",
          symbolName: callee.includes(".") ? undefined : callee,
          metadata: { unresolvedName: callee },
        });
      }
      const importHintFile = !callee.includes(".") ? importedNameToFile.get(callee) : undefined;
      addEdge(graph, {
        from: symbolId,
        to: targetId,
        kind: "calls",
        metadata: {
          unresolvedName: callee,
          ...includePropertiesWhen(importHintFile, () => ({ importHintFile })),
        },
        // A definite external call (`callee.includes(".")`) is never
        // ambiguous — no in-project candidate to collide with, so no
        // resolution marker. An in-project bare-name callee starts
        // "name-only" and resolveDeferredSymbolEdges below may upgrade it
        // to "import" (when importHintFile narrows it) or "exact" once
        // every file has been added.
        ...includePropertiesWhen(!callee.includes("."), () => ({ resolution: "name-only" })),
      });
    }
  }
}
