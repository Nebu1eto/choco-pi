/**
 * Tree-sitter Structural Search Client for choco-pi-lsp
 *
 * Inspired by pi-lsp-extension's search-engine.ts and pattern-compiler.ts
 * Provides AST-aware structural search with metavariable capture.
 *
 * Uses web-tree-sitter (WASM) for parsing - no native compilation needed.
 *
 * Pattern syntax:
 *   $NAME    - Matches any single AST node, captures as NAME
 *   $$$NAME  - Matches zero or more sibling nodes (variadic)
 *
 * Example:
 *   "console.log($MSG)" matches any console.log call, captures argument as MSG
 *   "function $NAME($$$PARAMS) { $BODY }" matches function declarations
 *
 * This module is a facade: the implementation lives in `./tree-sitter/`, and this file
 * re-exports the public surface unchanged.
 */
export { isTreeSitterWasmAbortError } from "./tree-sitter/shared.ts";
export type {
  StructuralMatch,
  SearchPattern,
  TreeSitterParserCounters,
  TreeSitterParseCacheStats,
  ParsedTreeOutcome,
} from "./tree-sitter/shared.ts";
export { TreeSitterClient } from "./tree-sitter/client.ts";
export { regexStructuralSearch } from "./tree-sitter/query-search.ts";
