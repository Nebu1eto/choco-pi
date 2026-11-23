import { isRuntimeNumber } from "../../../tools/runtime-values.ts";
import type { CallGraphEvidenceCoverage } from "../../call-graph.ts";
import type { ReviewGraph, ReviewGraphNode } from "../types.ts";
import type { SymbolKind, SymbolRef } from "../../symbol-types.ts";

export function extractSymbolsAndRefsFromGraph(graph: ReviewGraph) {
  const allSymbols = new Map<string, import("../../symbol-types.ts").Symbol[]>();
  const allRefs = new Map<string, import("../../symbol-types.ts").SymbolRef[]>();
  const nodeSymbols = new Map<string, import("../../symbol-types.ts").Symbol>();
  const coverage: CallGraphEvidenceCoverage = {
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
    complete: graph.persistCoverage?.partial !== true && graph.persistCoverage?.inProgress !== true,
    languages: {},
  };

  const numberMetadata = (node: ReviewGraphNode | undefined, key: string): number | undefined => {
    const value = node?.metadata?.[key];
    return isRuntimeNumber(value) && Number.isFinite(value) ? value : undefined;
  };
  const symbolKind = (node: ReviewGraphNode): SymbolKind => {
    switch (node.symbolKind) {
      case "class":
      case "interface":
      case "type":
      case "variable":
      case "method":
      case "property":
      case "function":
        return node.symbolKind;
      default:
        return "function";
    }
  };

  for (const node of graph.nodes.values()) {
    if (node.kind !== "symbol" || !node.filePath || !node.symbolName) continue;
    const sym: import("../../symbol-types.ts").Symbol = {
      id: node.id,
      name: node.symbolName,
      kind: symbolKind(node),
      filePath: node.filePath,
      line: numberMetadata(node, "line") ?? 1,
      endLine: numberMetadata(node, "endLine"),
      column: numberMetadata(node, "column") ?? 1,
      isExported: node.exported === true,
    };
    nodeSymbols.set(node.id, sym);
    const list = allSymbols.get(node.filePath) ?? [];
    list.push(sym);
    allSymbols.set(node.filePath, list);
  }

  const addRef = (ref: SymbolRef): void => {
    const list = allRefs.get(ref.filePath) ?? [];
    list.push(ref);
    allRefs.set(ref.filePath, list);
  };

  for (const edge of graph.edges) {
    if (edge.kind !== "calls" && edge.kind !== "references") continue;
    coverage.totalEvidence++;
    if (edge.kind === "calls") coverage.callsEvidence++;
    else coverage.referencesEvidence++;

    const fromNode = graph.nodes.get(edge.from);
    const targetNode = graph.nodes.get(edge.to);
    const callerFile =
      fromNode?.kind === "symbol"
        ? fromNode.filePath
        : fromNode?.kind === "file"
          ? fromNode.filePath
          : edge.from.startsWith("file:")
            ? edge.from.slice("file:".length)
            : undefined;
    if (!callerFile) {
      coverage.unsupportedEvidence++;
      continue;
    }
    const metadata = edge.metadata ?? {};
    const referenceKind =
      edge.kind === "calls"
        ? "call"
        : metadata.referenceKind === "call"
          ? "call"
          : metadata.referenceKind === "type"
            ? "type"
            : "unknown";
    const resolution =
      edge.resolution ??
      (targetNode && !targetNode.metadata?.unresolvedName ? "exact" : "unresolved");
    const targetSymbol = nodeSymbols.get(edge.to);
    const targetName =
      targetNode?.symbolName ??
      (edge.to.startsWith("symbol-name:") ? edge.to.slice("symbol-name:".length) : undefined);
    const line = isRuntimeNumber(metadata.line)
      ? metadata.line
      : (numberMetadata(fromNode, "line") ?? 1);
    const column = isRuntimeNumber(metadata.column)
      ? metadata.column
      : (numberMetadata(fromNode, "column") ?? 1);
    addRef({
      symbolId: targetName ? `${callerFile}:${targetName}` : edge.to,
      filePath: callerFile,
      line,
      column,
      evidenceKind: edge.kind,
      referenceKind,
      targetId: edge.to,
      callerSymbolId: fromNode?.kind === "symbol" ? fromNode.id : undefined,
      resolution,
      targetName,
      targetKind: targetNode?.symbolKind,
      targetFilePath: targetNode?.filePath,
      targetLine: numberMetadata(targetNode, "line"),
      targetColumn: numberMetadata(targetNode, "column"),
    });

    if (referenceKind === "type") coverage.typeOnlyEvidence++;
    else if (referenceKind !== "call") coverage.unsupportedEvidence++;
    else if (!targetSymbol || resolution === "name-only" || resolution === "unresolved") {
      coverage.unresolvedEvidence++;
    } else {
      coverage.eligibleEvidence++;
      coverage.resolvedEvidence++;
    }
  }

  let sawRelevantFileNode = false;
  for (const node of graph.nodes.values()) {
    if (node.kind !== "file") continue;
    sawRelevantFileNode = true;
    // SAFETY: The fact-store, parser, or cache producer establishes this review-graph shape; adjacent checks reject unavailable values.
    const extraction = node.metadata?.extractionCoverage as
      | Record<string, "complete" | "partial" | "unavailable" | undefined>
      | undefined;
    const statuses = extraction ? Object.values(extraction) : [];
    const languageStatus =
      !extraction || statuses.length === 0 || statuses.includes("unavailable")
        ? "unavailable"
        : statuses.includes("partial")
          ? "partial"
          : "complete";
    if (languageStatus !== "complete") coverage.complete = false;
    if (node.language) {
      const prior = coverage.languages![node.language];
      coverage.languages![node.language] =
        prior === "unavailable" || languageStatus === "unavailable"
          ? "unavailable"
          : prior === "partial" || languageStatus === "partial"
            ? "partial"
            : languageStatus;
    }
  }
  if (!sawRelevantFileNode) coverage.complete = false;

  return { allSymbols, allRefs, coverage };
}
