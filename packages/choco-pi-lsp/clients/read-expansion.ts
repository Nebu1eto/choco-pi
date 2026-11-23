import * as fs from "node:fs";
import { withBudget } from "./deadline-utils.ts";
import type { TreeSitterClient } from "./tree-sitter-client.ts";

export const EXPANSION_LIMIT_LINES = 100;

const EXPANDED_SIZE_CAP_LINES = 300;

export const EXPANSION_BUDGET_MS = 200;

interface EXTTOLANGValues extends Record<string, string> {}
const EXT_TO_LANG: EXTTOLANGValues = {
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
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".c++": "cpp",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".phtml": "php",
  ".swift": "swift",
  ".lua": "lua",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".zig": "zig",
  ".sh": "bash",
  ".bash": "bash",
};

export const CODE_FILE_EXTENSIONS: readonly string[] = Object.keys(EXT_TO_LANG);

interface ENCLOSINGTYPESValues extends Record<string, string[]> {}
const ENCLOSING_TYPES: ENCLOSINGTYPESValues = {
  typescript: [
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "class_declaration",
  ],
  tsx: [
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "class_declaration",
  ],
  javascript: [
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "class_declaration",
  ],
  python: ["function_definition", "class_definition", "decorated_definition"],
  go: ["function_declaration", "method_declaration"],
  rust: ["function_item", "impl_item"],
  ruby: ["method", "class", "module"],
  java: [
    "method_declaration",
    "constructor_declaration",
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
  ],
  kotlin: ["function_declaration", "class_declaration", "object_declaration"],
  dart: ["function_declaration", "method_declaration", "class_definition", "mixin_declaration"],
  elixir: ["call"],
  c: ["function_definition"],
  cpp: ["function_definition", "class_specifier", "struct_specifier"],
  csharp: [
    "method_declaration",
    "constructor_declaration",
    "class_declaration",
    "interface_declaration",
    "struct_declaration",
  ],
  php: ["function_definition", "method_declaration", "class_declaration"],
  swift: ["function_declaration", "class_declaration", "protocol_declaration", "init_declaration"],
  lua: ["function_declaration", "function_definition"],
  ocaml: ["value_definition", "module_definition"],
  zig: ["function_declaration"],
  bash: ["function_definition"],
};

export interface AncestorSymbol {
  name: string;
  kind: string;
  startLine: number;
}

export interface ExpandedRead {
  newOffset: number;
  newLimit: number;
  enclosingSymbol: {
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
  };
  ancestry?: AncestorSymbol[];
  durationMs: number;
}

function findEnclosingNodeForRange(
  node: any,
  startRow: number,
  endRow: number,
  types: string[],
): any {
  const nodeStartRow: number = node.startPosition?.row ?? 0;

  // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
  const nodeEndRow: number = (node as any).endPosition?.row ?? nodeStartRow;

  if (endRow < nodeStartRow || startRow > nodeEndRow) return undefined;

  for (const child of node.children ?? []) {
    const match = findEnclosingNodeForRange(child, startRow, endRow, types);
    if (match) return match;
  }

  return types.includes(node.type) ? node : undefined;
}

function getSymbolName(node: any): string {
  for (const child of node.children ?? []) {
    if (
      child.type === "identifier" ||
      child.type === "property_identifier" ||
      child.type === "name"
    ) {
      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      return child.text as string;
    }
  }

  // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
  return node.type as string;
}

function buildAncestryChain(node: any, types: string[]): AncestorSymbol[] {
  const chain: AncestorSymbol[] = [];
  let current: any = node.parent;
  while (current) {
    // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
    if (types.includes(current.type as string)) {
      chain.push({
        name: getSymbolName(current),

        // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
        kind: current.type as string,
        startLine: (current.startPosition?.row ?? 0) + 1,
      });
    }
    current = current.parent;
  }
  return chain.reverse();
}

function tryExpandMarkdownSection(
  content: string,
  requestedStartRow: number,
  requestedLimit: number,
  totalLines: number,
): Omit<ExpandedRead, "durationMs"> | undefined {
  const lines = content.split(/\r?\n/);
  const lastRow = totalLines - 1;

  let headingLevel = 7;
  let sectionStartRow = 0;
  let headingText = "";

  for (let i = requestedStartRow; i >= 0; i--) {
    const match = lines[i]?.match(/^(#{1,6})\s+(.*)/);
    if (match) {
      headingLevel = match[1].length;
      sectionStartRow = i;
      headingText = match[2].trim();
      break;
    }
  }

  let sectionEndRow = lastRow;
  for (let i = sectionStartRow + 1; i <= lastRow; i++) {
    const match = lines[i]?.match(/^(#{1,6})\s+/);
    if (match && match[1].length <= headingLevel) {
      sectionEndRow = i - 1;
      break;
    }
  }

  const expandedStart = sectionStartRow + 1;
  const expandedEnd = sectionEndRow + 1;
  const expandedSize = expandedEnd - expandedStart + 1;

  if (expandedSize > EXPANDED_SIZE_CAP_LINES) return undefined;
  if (expandedSize <= requestedLimit) return undefined;

  return {
    newOffset: expandedStart,
    newLimit: expandedSize,
    enclosingSymbol: {
      name: headingText || "(untitled section)",
      kind: "markdown_section",
      startLine: expandedStart,
      endLine: expandedEnd,
    },
  };
}

export async function tryExpandRead(
  filePath: string,
  requestedOffset: number,
  requestedLimit: number,
  totalLines: number,
  tsClient: TreeSitterClient,
): Promise<ExpandedRead | undefined> {
  if (requestedLimit > EXPANSION_LIMIT_LINES) return undefined;
  if (requestedLimit >= totalLines) return undefined;

  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const startedAt = Date.now();

  try {
    const content = fs.readFileSync(filePath, "utf8");

    if (ext === ".md" || ext === ".mdx") {
      const requestedStartRow = requestedOffset - 1;
      const result = tryExpandMarkdownSection(
        content,
        requestedStartRow,
        requestedLimit,
        totalLines,
      );
      if (!result) return undefined;
      return { ...result, durationMs: Date.now() - startedAt };
    }

    const languageId = EXT_TO_LANG[ext];
    if (!languageId) return undefined;

    const enclosingTypes = ENCLOSING_TYPES[languageId];
    if (!enclosingTypes) return undefined;
    const initOk = await withBudget(tsClient.init(), EXPANSION_BUDGET_MS);
    if (!initOk) return undefined;

    const remaining = Math.max(0, EXPANSION_BUDGET_MS - (Date.now() - startedAt));
    const requestedStartRow = requestedOffset - 1;
    const requestedEndRow = Math.min(totalLines - 1, requestedOffset + requestedLimit - 2);
    const parsed = await withBudget(
      tsClient.withParsedTree(filePath, languageId, content, (tree) => {
        const node = findEnclosingNodeForRange(
          // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
          tree.rootNode as any,
          requestedStartRow,
          requestedEndRow,
          enclosingTypes,
        );
        if (!node) return undefined;
        return {
          name: getSymbolName(node),

          // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
          kind: node.type as string,
          startRow: node.startPosition.row,

          // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
          endRow: (node as any).endPosition?.row ?? node.startPosition.row,
          ancestry: buildAncestryChain(node, enclosingTypes),
        };
      }),
      remaining,
    );
    const enclosing = parsed?.parsed ? parsed.value : undefined;
    if (!enclosing) return undefined;

    const symbolStart: number = enclosing.startRow + 1;
    const symbolEnd: number = enclosing.endRow + 1;
    const requestedStartLine = requestedOffset;
    const requestedEndLine = requestedEndRow + 1;
    const expandedStart = Math.min(requestedStartLine, symbolStart);
    const expandedEnd = Math.max(requestedEndLine, symbolEnd);
    const expandedSize = expandedEnd - expandedStart + 1;

    if (expandedSize > EXPANDED_SIZE_CAP_LINES) return undefined;
    if (expandedSize <= requestedLimit) return undefined;

    return {
      newOffset: expandedStart,
      newLimit: expandedSize,
      enclosingSymbol: {
        name: enclosing.name,
        kind: enclosing.kind,
        startLine: symbolStart,
        endLine: symbolEnd,
      },
      ancestry: enclosing.ancestry.length > 0 ? enclosing.ancestry : undefined,
      durationMs: Date.now() - startedAt,
    };
  } catch {
    return undefined;
  }
}
