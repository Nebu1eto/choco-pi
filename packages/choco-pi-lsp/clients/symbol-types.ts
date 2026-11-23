export type SymbolKind =
  | "function"
  | "class"
  | "variable"
  | "interface"
  | "type"
  | "method"
  | "property";

export interface Symbol {
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  line: number;
  endLine?: number;
  column: number;
  signature?: string;
  isExported: boolean;
  visibility?: "private" | "protected";
  local?: boolean;
  doc?: string;
  docStartLine?: number;
  decorators?: string[];
  isAsync?: boolean;
}

export type CallGraphEvidenceKind = "calls" | "references";
export type SymbolReferenceKind = "call" | "type" | "unknown";
export type SymbolResolution = "exact" | "import" | "receiver-type" | "name-only" | "unresolved";

export interface SymbolRef {
  symbolId: string;
  symbolName?: string;
  filePath: string;
  line: number;
  column: number;
  context?: string;
  evidenceKind?: CallGraphEvidenceKind;
  referenceKind?: SymbolReferenceKind;
  targetId?: string;
  callerSymbolId?: string;
  resolution?: SymbolResolution;
  targetName?: string;
  targetKind?: string;
  targetFilePath?: string;
  targetLine?: number;
  targetColumn?: number;
}

export interface SymbolIndex {
  version: string;
  createdAt: string;
  symbols: Map<string, Symbol>;
  refs: Map<string, SymbolRef[]>;
  byFile: Map<string, string[]>;
}

export interface CallEdge {
  caller: string;
  callerFile: string;
  callerLine: number;
  callerColumn: number;
  callee: string;
  calleeResolved: boolean;
}

export interface CallGraph {
  edges: CallEdge[];
  adjacency: Map<string, string[]>;
  reverse: Map<string, string[]>;
  cycles: string[][];
  orphans: string[];
  entryPoints: string[];
}

export interface SerializableSymbolIndex {
  version: string;
  createdAt: string;
  symbols: [string, Symbol][];
  refs: [string, SymbolRef[]][];
  byFile: [string, string[]][];
}

export interface SerializableCallGraph {
  edges: CallEdge[];
  adjacency: [string, string[]][];
  reverse: [string, string[]][];
  cycles: string[][];
  orphans: string[];
  entryPoints: string[];
}
