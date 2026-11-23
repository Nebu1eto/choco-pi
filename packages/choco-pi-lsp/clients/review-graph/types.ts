import type { ProtocolDictionary } from "../../tools/runtime-values.ts";
export type ReviewGraphNodeKind = "file" | "symbol" | "module" | "external";
export type ReviewGraphEdgeKind = "contains" | "defines" | "imports" | "calls" | "references";

export interface ReviewGraphNode {
  id: string;
  kind: ReviewGraphNodeKind;
  language: string;
  filePath?: string;
  symbolName?: string;
  symbolKind?: string;
  exported?: boolean;
  qualifiedName?: string;
  provenance?: "lsp";
  metadata?: ProtocolDictionary;
}

export interface ReviewGraphEdge {
  from: string;
  to: string;
  kind: ReviewGraphEdgeKind;
  metadata?: ProtocolDictionary;
  resolution?: "exact" | "import" | "receiver-type" | "name-only" | "unresolved";
}

export interface ReviewGraph {
  version: string;
  builtAt: string;
  nodes: Map<string, ReviewGraphNode>;
  edges: ReviewGraphEdge[];
  edgesByFrom: Map<string, ReviewGraphEdge[]>;
  edgesByTo: Map<string, ReviewGraphEdge[]>;
  fileNodes: Map<string, string>;
  symbolNodesByFile: Map<string, string[]>;
  changedSymbolsByFile: Map<string, string[]>;
  persistCoverage?: ReviewGraphPersistCoverage;
  buildGeneration?: number;
}

export interface ReviewGraphPersistCoverage {
  partial: boolean;
  cap: number;
  totalNodes: number;
  totalEdges: number;
  persistedNodes: number;
  persistedEdges: number;
  totalFiles: number;
  persistedFiles: number;
  sourceFilesTruncated?: true;
  inProgress?: true;
}

export type CascadeIndeterminateReason =
  | "graph_degraded"
  | "missing_node"
  | "excluded_by_role"
  | "budget_truncated"
  | "error"
  | "lsp_binding_rejected";

export interface CascadeMissingNodeDiagnostic {
  soughtNodeId: string;
  graphFileCount: number;
  symbolNodeCount: number;
  sameDirFileCount: number;
  nearestFile?: string;
}

export interface CascadeBudgetCoverage {
  candidateCount: number;
  eligibleCount: number;
  selectedCount: number;
  truncatedCount: number;
  transitiveTruncated?: boolean;
}

export interface CascadeIndeterminate {
  reason: CascadeIndeterminateReason;
  detail?: string;
  sourceFileCount?: number;
  maxFileCount?: number;
  budget?: CascadeBudgetCoverage;
  diagnostic?: CascadeMissingNodeDiagnostic;
}

export interface ImpactCascadeResult {
  filePath: string;
  changedSymbols: string[];
  directImporters: string[];
  directCallers: string[];
  neighborFiles: string[];
  riskFlags: string[];
  indeterminate?: CascadeIndeterminate;
}
