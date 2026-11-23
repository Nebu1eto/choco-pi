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
