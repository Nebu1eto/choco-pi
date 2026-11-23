import { assignOptionalProperties } from "./optional-properties.ts";
import { notifyUserDegradation } from "./user-notify.ts";
import * as path from "node:path";
import { type ParsedTreeOutcome, TreeSitterClient } from "./tree-sitter-client.ts";
import { logTreeSitter } from "./tree-sitter-logger.ts";

let _shared: TreeSitterClient | null = null;
let _wasmAborted = false;
let _wasmAbortedAt: string | undefined;

export interface TreeSitterRuntimeStatus {
  available: boolean;
  wasmAborted: boolean;
  recovery: "restart_required" | "not_required";
  abortedAt?: string;
}

export function getSharedTreeSitterClient(): TreeSitterClient | null {
  if (_wasmAborted) return null;
  _shared ??= new TreeSitterClient(false, markTreeSitterWasmAborted);
  return _shared;
}

export function isTreeSitterWasmAborted(): boolean {
  return _wasmAborted;
}

export function resetTreeSitterClientLoadState(): void {
  _shared?.resetLoadStateForSession();
}

export function getTreeSitterRuntimeStatus(): TreeSitterRuntimeStatus {
  return assignOptionalProperties(
    {
      available: !_wasmAborted,
      wasmAborted: _wasmAborted,
      recovery: _wasmAborted ? "restart_required" : "not_required",
    },
    _wasmAbortedAt,
    () => ({ abortedAt: _wasmAbortedAt }),
  );
}

export function markTreeSitterWasmAborted(): void {
  if (_wasmAborted) return;
  _wasmAborted = true;
  _wasmAbortedAt = new Date().toISOString();
  _shared = null;
  notifyUserDegradation(
    "choco-pi-lsp: tree-sitter WASM runtime aborted; structural analysis is disabled " +
      "for this process. Restart the choco-pi-lsp extension/MCP server to recover.",
    "error",
  );
  logTreeSitter({
    phase: "runtime_abort",
    filePath: process.cwd(),
    status: "degraded",
    reason: "wasm_aborted_restart_required",
    metadata: { abortedAt: _wasmAbortedAt },
  });
}

export function _resetSharedTreeSitterClientForTests(): void {
  _shared = null;
  _wasmAborted = false;
  _wasmAbortedAt = undefined;
}

interface EXTTOLANGValues extends Record<string, string> {}
export const EXT_TO_LANG: EXTTOLANGValues = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".c++": "cpp",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".inl": "cpp",
  ".ipp": "cpp",
  ".tpp": "cpp",
  ".txx": "cpp",
  ".cu": "cpp",
  ".hip": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".phtml": "php",
  ".php3": "php",
  ".php4": "php",
  ".php5": "php",
  ".css": "css",
};

export function resolveTreeSitterLanguage(filePath: string): string | undefined {
  return EXT_TO_LANG[path.extname(filePath).toLowerCase()];
}

export type TsNode = any;

export async function withTreeSitterRoot<T>(
  filePath: string,
  content: string,
  consume: (root: TsNode) => T,
): Promise<ParsedTreeOutcome<T>> {
  const languageId = resolveTreeSitterLanguage(filePath);
  const client = getSharedTreeSitterClient();
  if (!languageId || !client || !(await client.init())) return { parsed: false };
  return client.withParsedTree(filePath, languageId, content, (tree) =>
    // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
    consume(tree.rootNode as TsNode),
  );
}

export function childrenOfType(node: TsNode, type: string): TsNode[] {
  return (node.children ?? []).filter((c: TsNode) => c && c.type === type);
}

export function firstChildOfType(node: TsNode, type: string): TsNode | undefined {
  return (node.children ?? []).find((c: TsNode) => c && c.type === type);
}

export function walk(node: TsNode, visit: (n: TsNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) {
    if (child) walk(child, visit);
  }
}
