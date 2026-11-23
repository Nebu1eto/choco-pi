import { assignOptionalProperties } from "./optional-properties.ts";
import { isFiniteNumber } from "./runtime-guards.ts";
import { logTreeSitterDiagnostic } from "./tree-sitter-logger.ts";
import * as path from "node:path";
import { loadWebTreeSitter } from "./deps/web-tree-sitter.ts";
import type { Symbol, SymbolKind, SymbolRef } from "./symbol-types.ts";
import type { TreeSitterClient } from "./tree-sitter-client.ts";

interface SYMBOLQUERIESValues extends Record<string, { defs: string; refs: string }> {}
const SYMBOL_QUERIES: SYMBOLQUERIESValues = {
  typescript: {
    defs: `
      ;; Function declarations: function foo(params) { }
      (function_declaration
        name: (identifier) @funcName
        parameters: (formal_parameters) @funcParams
        body: (statement_block) @funcBody) @funcDef
      
      ;; Arrow functions: const foo = (params) => { }
      (variable_declarator
        name: (identifier) @arrowName
        value: (arrow_function
          parameters: (formal_parameters) @arrowParams
          body: (_) @arrowBody)) @arrowDef
      
      ;; Class declarations: class Foo { }
      (class_declaration
        name: (type_identifier) @className) @classDef
      
      ;; Method definitions: class Foo { bar() { } }
      (method_definition
        name: (property_identifier) @methodName
        parameters: (formal_parameters) @methodParams) @methodDef
      
      ;; Interface declarations: interface Foo { }
      (interface_declaration
        name: (type_identifier) @interfaceName) @interfaceDef
      
      ;; Type alias: type Foo = ...
      (type_alias_declaration
        name: (type_identifier) @typeName) @typeDef
    `,
    refs: `
      ;; Function/method calls: foo() or obj.bar()
      (call_expression
        function: (identifier) @callIdent) @callRef
      
      (call_expression
        function: (member_expression
          object: (_)
          property: (property_identifier) @callMethod)) @callMethodRef
      
      ;; New expressions: new Foo()
      (new_expression
        constructor: (identifier) @newIdent) @newRef
      
      ;; Type references: type T = Foo
      (type_identifier) @typeIdent
    `,
  },
  python: {
    defs: `
      ;; Function definitions: def foo(params):
      (function_definition
        name: (identifier) @funcName
        parameters: (parameters) @funcParams) @funcDef
      
      ;; Class definitions: class Foo:
      (class_definition
        name: (identifier) @className) @classDef
      
      ;; Method definitions (within class)
      (class_definition
        body: (block
          (function_definition
            name: (identifier) @methodName
            parameters: (parameters) @methodParams) @methodDef))
    `,
    refs: `
      ;; Function calls: foo() or obj.bar()
      (call
        function: (identifier) @callIdent) @callRef
      
      (call
        function: (attribute
          object: (_)
          attribute: (identifier) @callMethod)) @callMethodRef
    `,
  },
  rust: {
    defs: `
      ;; Function definitions: fn foo(params) { }
      (function_item
        name: (identifier) @funcName
        parameters: (parameters) @funcParams) @funcDef
      
      ;; Struct definitions: struct Foo { }
      (struct_item
        name: (type_identifier) @structName) @structDef
      
      ;; Impl blocks: impl Foo { fn bar() { } }
      (impl_item
        type: (type_identifier) @implType
        body: (declaration_list
          (function_item
            name: (identifier) @implMethodName) @implMethodDef))
    `,
    refs: `
      ;; Function calls: foo() or obj.bar()
      (call_expression
        function: (identifier) @callIdent) @callRef
      
      (call_expression
        function: (field_expression
          value: (_)
          field: (field_identifier) @callField)) @callFieldRef
    `,
  },
  go: {
    defs: `
      (function_declaration
        name: (identifier) @funcName
        parameters: (parameter_list) @funcParams) @funcDef

      (method_declaration
        name: (field_identifier) @methodName
        parameters: (parameter_list) @methodParams) @methodDef

      (type_spec
        name: (type_identifier) @typeName) @typeDef
    `,
    refs: `
      (call_expression
        function: (identifier) @callIdent) @callRef

      (call_expression
        function: (selector_expression
          field: (field_identifier) @callMethod)) @callMethodRef
    `,
  },
  ruby: {
    defs: `
      (method
        name: (identifier) @methodName) @methodDef

      (singleton_method
        name: (identifier) @methodName) @methodDef

      (class
        name: (constant) @className) @classDef

      (module
        name: (constant) @moduleName) @moduleDef
    `,
    refs: `
      (call
        method: (identifier) @callIdent) @callRef

      (call
        method: (constant) @typeIdent) @typeRef
    `,
  },
  c: {
    defs: `
      (function_definition
        declarator: (function_declarator
          declarator: (identifier) @funcName
          parameters: (parameter_list) @funcParams)) @funcDef

      (type_definition
        declarator: (type_identifier) @typeName) @typeDef

      (struct_specifier
        name: (type_identifier) @typeName) @typeDef

      (enum_specifier
        name: (type_identifier) @typeName) @typeDef
    `,
    refs: `
      (call_expression
        function: (identifier) @callIdent) @callRef

      (call_expression
        function: (field_expression
          field: (field_identifier) @callField)) @callFieldRef

      (type_identifier) @typeIdent
    `,
  },
  cpp: {
    defs: `
      (function_definition
        declarator: (function_declarator
          declarator: (identifier) @funcName
          parameters: (parameter_list) @funcParams)) @funcDef

      (class_specifier
        name: (type_identifier) @className) @classDef

      (struct_specifier
        name: (type_identifier) @className) @classDef

      (type_definition
        declarator: (type_identifier) @typeName) @typeDef
    `,
    refs: `
      (call_expression
        function: (identifier) @callIdent) @callRef

      (call_expression
        function: (field_expression
          field: (field_identifier) @callField)) @callFieldRef

      (type_identifier) @typeIdent
    `,
  },
  java: {
    defs: `
      (method_declaration
        name: (identifier) @methodName
        parameters: (formal_parameters) @methodParams) @methodDef

      (class_declaration
        name: (identifier) @className) @classDef

      (interface_declaration
        name: (identifier) @interfaceName) @interfaceDef

      (constructor_declaration
        name: (identifier) @funcName
        parameters: (formal_parameters) @funcParams) @funcDef

      (enum_declaration
        name: (identifier) @className) @classDef
    `,
    refs: `
      (method_invocation
        name: (identifier) @callMethod) @callRef

      (object_creation_expression
        type: (type_identifier) @newIdent) @newRef

      (type_identifier) @typeIdent
    `,
  },
  kotlin: {
    defs: `
      (function_declaration
        (simple_identifier) @funcName) @funcDef

      (class_declaration
        (type_identifier) @className) @classDef

      (object_declaration
        (type_identifier) @className) @classDef
    `,
    refs: `
      (call_expression
        (simple_identifier) @callIdent) @callRef

      (user_type (type_identifier) @typeIdent)
    `,
  },
  dart: {
    defs: `
      (function_signature
        (identifier) @funcName
        (formal_parameter_list) @funcParams) @funcDef

      (class_definition
        (identifier) @className) @classDef
    `,
    refs: `
      (type_identifier) @typeIdent
    `,
  },
  elixir: {
    defs: `
      (call
        target: (identifier) @_kw
        (arguments
          (call
            target: (identifier) @funcName
            (arguments) @funcParams) @funcDef)
        (#match? @_kw "^def[pm]?$"))

      (call
        target: (identifier) @_kw
        (arguments (alias) @moduleName) @moduleDef
        (#match? @_kw "^defmodule$"))
    `,
    refs: `
      (call
        target: (identifier) @callIdent) @callRef

      (alias) @typeIdent
    `,
  },
  csharp: {
    defs: `
      (method_declaration
        name: (identifier) @methodName
        parameters: (parameter_list) @methodParams) @methodDef

      (class_declaration
        name: (identifier) @className) @classDef

      (struct_declaration
        name: (identifier) @className) @classDef

      (interface_declaration
        name: (identifier) @interfaceName) @interfaceDef

      (constructor_declaration
        name: (identifier) @funcName
        parameters: (parameter_list) @funcParams) @funcDef

      (enum_declaration
        name: (identifier) @className) @classDef
    `,
    refs: `
      (invocation_expression
        function: (identifier) @callIdent) @callRef

      (invocation_expression
        function: (member_access_expression
          name: (identifier) @callMethod)) @callMethodRef

      (object_creation_expression
        type: (identifier) @newIdent) @newRef
    `,
  },
  php: {
    defs: `
      (function_definition
        name: (name) @funcName
        parameters: (formal_parameters) @funcParams) @funcDef

      (method_declaration
        name: (name) @methodName
        parameters: (formal_parameters) @methodParams) @methodDef

      (class_declaration
        name: (name) @className) @classDef

      (interface_declaration
        name: (name) @interfaceName) @interfaceDef

      (trait_declaration
        name: (name) @className) @classDef
    `,
    refs: `
      (function_call_expression
        function: (name) @callIdent) @callRef

      (member_call_expression
        name: (name) @callMethod) @callMethodRef

      (object_creation_expression
        (name) @newIdent) @newRef
    `,
  },
  swift: {
    defs: `
      (function_declaration
        (simple_identifier) @funcName) @funcDef

      (class_declaration
        (type_identifier) @className) @classDef

      (protocol_declaration
        (type_identifier) @interfaceName) @interfaceDef
    `,
    refs: `
      (call_expression
        (simple_identifier) @callIdent) @callRef

      (navigation_expression
        (simple_identifier) @callMethod) @callMethodRef

      (type_identifier) @typeIdent
    `,
  },
  lua: {
    defs: `
      (function_declaration
        (identifier) @funcName) @funcDef

      (function_declaration
        (dot_index_expression) @funcName) @funcDef
    `,
    refs: `
      (function_call (identifier) @callIdent) @callRef

      (function_call (dot_index_expression) @callIdent) @callRef
    `,
  },
  ocaml: {
    defs: `
      (value_definition
        (let_binding (value_name) @funcName)) @funcDef

      (module_definition
        (module_binding (module_name) @moduleName)) @moduleDef
    `,
    refs: `
      (application_expression
        (value_path (value_name) @callIdent)) @callRef

      (value_path (value_name) @callIdent) @callRef
    `,
  },
  zig: {
    defs: `
      (function_declaration
        (identifier) @funcName) @funcDef
    `,
    refs: `
      (call_expression
        (identifier) @callIdent) @callRef
    `,
  },
  bash: {
    defs: `
      (function_definition
        name: (word) @funcName) @funcDef
    `,
    refs: `
      (command
        name: (command_name (word) @callIdent)) @callRef
    `,
  },
  cue: {
    defs: `
      (field
        (label (identifier) @defName)
        (#match? @defName "^#")) @defDef

      (field
        (label (identifier) @fieldName)
        (value (_)) @fieldValue
        (#not-match? @fieldName "^#")) @fieldDef

      (let_clause
        left: (identifier) @letName
        right: (_) @letValue) @letDef
    `,
    refs: `
      ((identifier) @typeIdent
        (#match? @typeIdent "^#"))

      (call_expression
        function: (identifier) @callIdent) @callRef

      (call_expression
        function: (selector_expression (identifier) (identifier) @callMethod)) @callMethodRef
    `,
  },
};

SYMBOL_QUERIES.tsx = SYMBOL_QUERIES.typescript;

SYMBOL_QUERIES.javascript = {
  defs: `
      ;; Function declarations: function foo(params) { }
      (function_declaration
        name: (identifier) @funcName
        parameters: (formal_parameters) @funcParams
        body: (statement_block) @funcBody) @funcDef

      ;; Arrow functions: const foo = (params) => { }
      (variable_declarator
        name: (identifier) @arrowName
        value: (arrow_function
          parameters: (formal_parameters) @arrowParams
          body: (_) @arrowBody)) @arrowDef

      ;; Class declarations: class Foo { } — (identifier) name on this grammar.
      (class_declaration
        name: (identifier) @className) @classDef

      ;; Method definitions: class Foo { bar() { } }
      (method_definition
        name: (property_identifier) @methodName
        parameters: (formal_parameters) @methodParams) @methodDef
    `,
  refs: `
      ;; Function/method calls: foo() or obj.bar()
      (call_expression
        function: (identifier) @callIdent) @callRef

      (call_expression
        function: (member_expression
          object: (_)
          property: (property_identifier) @callMethod)) @callMethodRef

      ;; New expressions: new Foo()
      (new_expression
        constructor: (identifier) @newIdent) @newRef
    `,
};

export function getSymbolQueryLanguages(): readonly string[] {
  return Object.keys(SYMBOL_QUERIES);
}

interface IMPORTQUERIESValues extends Record<string, string> {}
const IMPORT_QUERIES: IMPORTQUERIESValues = {
  typescript: `
      (import_statement source: (string) @importSource)
      (export_statement source: (string) @importSource)
    `,
  tsx: `
      (import_statement source: (string) @importSource)
      (export_statement source: (string) @importSource)
    `,
  c: `
      (preproc_include path: (string_literal) @importSource)
      (preproc_include path: (system_lib_string) @importSource)
    `,
  cpp: `
      (preproc_include path: (string_literal) @importSource)
      (preproc_include path: (system_lib_string) @importSource)
    `,
  python: `
      (import_statement name: (dotted_name) @importSource)
      (import_statement name: (aliased_import name: (dotted_name) @importSource))
      (import_from_statement module_name: (dotted_name) @importSource)
      (import_from_statement module_name: (relative_import) @importSource)
    `,
  go: `(import_spec path: (interpreted_string_literal) @importSource)`,
  rust: `(use_declaration argument: (_) @importSource)`,
  java: `(import_declaration (scoped_identifier) @importSource)`,
  kotlin: `(import_header (identifier) @importSource)`,
  csharp: `
      (using_directive (identifier) @importSource)
      (using_directive (qualified_name) @importSource)
    `,
  swift: `(import_declaration (identifier) @importSource)`,
  php: `(namespace_use_clause (name) @importSource)`,
  ocaml: `(open_module (module_path) @importSource)`,
  dart: `(import_specification (configurable_uri (uri (string_literal) @importSource)))`,
  lua: `
      (function_call
        (identifier) @_m
        (arguments (string) @importSource)
        (#match? @_m "^require$"))
    `,
  ruby: `
      (call
        method: (identifier) @_m
        (argument_list (string (string_content) @importSource))
        (#match? @_m "^require"))
    `,
  zig: `
      (builtin_function (builtin_identifier) @_m
        (arguments (string (string_content) @importSource))
        (#match? @_m "^@import$"))
    `,
  elixir: `
      (call target: (identifier) @_m
        (arguments (alias) @importSource)
        (#match? @_m "^(import|alias|require|use)$"))
    `,
  bash: `
      (command (command_name (word) @_m)
        (word) @importSource
        (#match? @_m "^(source|\\.)$"))
    `,
  cue: `
      (import_declaration (import_spec path: (string) @importSource))
      (import_declaration (import_spec_list (import_spec path: (string) @importSource)))
    `,
};

IMPORT_QUERIES.javascript = IMPORT_QUERIES.typescript;

export interface ImportRef {
  source: string;
  line: number;
}

export interface ExtractedSymbols {
  symbols: Symbol[];
  refs: SymbolRef[];
  imports: ImportRef[];
  coverage?: {
    definitions: "complete" | "unavailable";
    references: "complete" | "unavailable";
    imports: "complete" | "unavailable";
  };
}

function parseImportMatch(match: any): ImportRef | null {
  for (const capture of match.captures) {
    if (capture.name !== "importSource") continue;
    const raw = String(capture.node.text ?? "").trim();
    const source = raw.replace(/^["'`]+|["'`]+$/g, "");
    if (!source) continue;
    return { source, line: capture.node.startPosition.row + 1 };
  }
  return null;
}

export class TreeSitterSymbolExtractor {
  private languageId: string;
  private client: TreeSitterClient;
  private defQuery: any = null;
  private refQuery: any = null;
  private importQuery: any = null;

  constructor(languageId: string, client: TreeSitterClient) {
    this.languageId = languageId;
    this.client = client;
  }

  async init(): Promise<boolean> {
    try {
      if (!(await this.client.isLanguageSupported(this.languageId))) return false;
      const language = this.client.getLanguage(this.languageId);
      if (!language) return false;

      const { Query } = await loadWebTreeSitter();
      const queries = SYMBOL_QUERIES[this.languageId];
      if (queries) {
        this.defQuery = this.compileQuery(Query, language, queries.defs, "defs");
        this.refQuery = this.compileQuery(Query, language, queries.refs, "refs");
      }
      const importQuerySrc = IMPORT_QUERIES[this.languageId];
      if (importQuerySrc) {
        this.importQuery = this.compileQuery(Query, language, importQuerySrc, "imports");
      }
      return Boolean(this.defQuery || this.importQuery);
    } catch (err) {
      this.client.reportWasmAbort(err);
      logTreeSitterDiagnostic({
        subsystem: "symbol-extractor",
        languageId: this.languageId,
        message: `Failed to init ${this.languageId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      return false;
    }
  }

  private compileQuery(Query: any, language: any, src: string, label: string) {
    try {
      return new Query(language, src);
    } catch (err) {
      if (this.client.reportWasmAbort(err)) throw err;
      logTreeSitterDiagnostic({
        subsystem: "symbol-extractor",
        languageId: this.languageId,

        message: `${this.languageId} ${label} query failed: ${err instanceof Error ? err.message : undefined}`,
        metadata: { query: label },
      });
      return null;
    }
  }

  extract(tree: any, filePath: string, content: string): ExtractedSymbols {
    const symbols: Symbol[] = [];
    const refs: SymbolRef[] = [];

    const relativePath = path.relative(process.cwd(), filePath);

    if (this.defQuery) {
      for (const match of this.queryMatches(this.defQuery, tree.rootNode)) {
        const symbol = this.parseDefMatch(match, relativePath, content);
        if (symbol) symbols.push(symbol);
      }
    }

    if (this.refQuery) {
      for (const match of this.queryMatches(this.refQuery, tree.rootNode)) {
        const ref = this.parseRefMatch(match, relativePath);
        if (ref) refs.push(ref);
      }
    }

    const imports: ImportRef[] = [];
    if (this.importQuery) {
      for (const match of this.queryMatches(this.importQuery, tree.rootNode)) {
        const ref = parseImportMatch(match);
        if (ref) imports.push(ref);
      }
    }

    return {
      symbols,
      refs,
      imports,
      coverage: {
        definitions: this.defQuery ? "complete" : "unavailable",
        references: this.refQuery ? "complete" : "unavailable",
        imports: this.importQuery ? "complete" : "unavailable",
      },
    };
  }

  private queryMatches(query: any, rootNode: any): any[] {
    try {
      return query.matches(rootNode);
    } catch (error) {
      this.client.reportWasmAbort(error);
      throw error;
    }
  }

  private parseDefMatch(match: any, filePath: string, content: string): Symbol | null {
    const captures: Record<string, { text: string; node: unknown }> = {};

    for (const capture of match.captures) {
      captures[capture.name] = {
        text: capture.node.text,

        // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
        node: capture.node as any,
      };
    }

    let name: string | undefined;
    let kind: SymbolKind | undefined;
    let params: string | undefined;
    let defNode:
      | {
          startPosition: { row: number; column: number };
          endPosition: { row: number; column: number };
        }
      | undefined;

    if (captures.funcName) {
      name = captures.funcName.text;
      kind = "function";
      params = captures.funcParams?.text;

      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      defNode = captures.funcDef?.node as any;
    } else if (captures.arrowName) {
      name = captures.arrowName.text;
      kind = "function";
      params = captures.arrowParams?.text;

      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      defNode = captures.arrowDef?.node as any;
    } else if (captures.className) {
      name = captures.className.text;
      kind = "class";

      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      defNode = captures.classDef?.node as any;
    } else if (captures.methodName) {
      name = captures.methodName.text;
      kind = "method";
      params = captures.methodParams?.text;

      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      defNode = captures.methodDef?.node as any;
    } else if (captures.interfaceName) {
      name = captures.interfaceName.text;
      kind = "interface";

      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      defNode = captures.interfaceDef?.node as any;
    } else if (captures.typeName) {
      name = captures.typeName.text;
      kind = "type";

      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      defNode = captures.typeDef?.node as any;
    } else if (captures.moduleName) {
      name = captures.moduleName.text;
      kind = "class";

      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      defNode = captures.moduleDef?.node as any;
    } else if (captures.defName) {
      name = captures.defName.text;
      kind = "type";

      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      defNode = captures.defDef?.node as any;
    } else if (captures.fieldName) {
      name = captures.fieldName.text;
      kind = "property";

      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      defNode = captures.fieldDef?.node as any;
    } else if (captures.letName) {
      name = captures.letName.text;
      kind = "variable";

      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      defNode = captures.letDef?.node as any;
    }

    if (!name || !kind || !defNode) return null;

    const isExported = this.isExported(defNode, content);
    const signature = params ? this.extractSignature(params, kind) : undefined;
    const local = this.isFunctionLocal(defNode);
    const visibility = kind === "method" ? this.detectVisibility(defNode, name) : undefined;
    const decorators = this.extractDecorators(defNode);
    const isAsync = (kind === "function" || kind === "method") && this.isAsyncDecl(defNode);
    const docInfo = this.extractDocCommentInfo(defNode);

    return assignOptionalProperties(
      assignOptionalProperties(
        assignOptionalProperties(
          assignOptionalProperties(
            assignOptionalProperties(
              {
                id: `${filePath}:${name}`,
                name,
                kind,
                filePath,
                line: defNode.startPosition.row + 1,
                endLine: defNode.endPosition.row + 1,
                column: defNode.startPosition.column + 1,
                signature,
                isExported,
              },
              local,
              () => ({ local: true }),
            ),
            visibility,
            () => ({ visibility }),
          ),
          decorators.length > 0,
          () => ({ decorators }),
        ),
        isAsync,
        () => ({ isAsync: true }),
      ),
      docInfo,
      (includedDoc) => ({ doc: includedDoc.text, docStartLine: includedDoc.startLine }),
    );
  }

  private static readonly COMMENT_NODE_KIND = "comment";

  private extractDocCommentInfo(declNode: any): { text: string; startLine: number } | undefined {
    const isComment = (n: any): boolean =>
      !!n && n.type === TreeSitterSymbolExtractor.COMMENT_NODE_KIND;
    const isDeco = (n: any) => !!n && TreeSitterSymbolExtractor.DECORATOR_NODE_KINDS.has(n.type);
    const samePos = (a: any, b: any) =>
      a?.startPosition?.row === b?.startPosition?.row &&
      a?.startPosition?.column === b?.startPosition?.column;
    const sameStartRow = (a: any, b: any) => a?.startPosition?.row === b?.startPosition?.row;

    let node = declNode;
    for (let hops = 0; hops < 4; hops++) {
      const parent = node.parent;
      if (!parent || !sameStartRow(parent, node)) break;
      node = parent;
    }

    const siblings: any[] = node.parent?.children ?? [];
    const idx = siblings.findIndex((s) => samePos(s, node));
    if (idx <= 0) return undefined;

    let cursor = idx - 1;
    while (cursor >= 0 && isDeco(siblings[cursor])) cursor--;
    let boundaryRow: number | undefined = node.startPosition?.row;
    let end = -1;
    let start = -1;
    while (cursor >= 0 && isComment(siblings[cursor])) {
      const candidate = siblings[cursor];
      const gapRows =
        boundaryRow !== undefined && isFiniteNumber(candidate.endPosition?.row)
          ? boundaryRow - candidate.endPosition.row
          : 0;
      if (gapRows > 1) break;
      if (end < 0) end = cursor;
      start = cursor;
      boundaryRow = candidate.startPosition?.row;
      cursor--;
    }
    if (start < 0 || end < 0) return undefined;

    const raw = siblings
      .slice(start, end + 1)
      .map((n) => String(n.text ?? ""))
      .join("\n");
    const text = this.summarizeDocComment(raw);
    if (!text) return undefined;
    const startLine = (siblings[start].startPosition?.row ?? 0) + 1;
    return { text, startLine };
  }

  private static readonly DOC_MAX_CHARS = 120;

  private summarizeDocComment(raw: string): string | undefined {
    const cleaned = raw
      .replace(/^\s*\/\*\*?/, "")
      .replace(/\*\/\s*$/, "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(\*|\/\/\/?|#)\s?/, "").trimEnd())
      .filter((line) => line.trim().length > 0)
      .join(" ")
      .trim();
    if (!cleaned) return undefined;

    const sentenceMatch = cleaned.match(/^.*?[.!?](?:\s|$)/);
    let first = (sentenceMatch ? sentenceMatch[0] : cleaned).trim();
    first = first.replace(/\s+/g, " ");
    if (first.length > TreeSitterSymbolExtractor.DOC_MAX_CHARS) {
      first = `${first.slice(0, TreeSitterSymbolExtractor.DOC_MAX_CHARS - 1).trimEnd()}…`;
    }
    return first || undefined;
  }

  private isAsyncDecl(node: any): boolean {
    const isAsyncTok = (n: any): boolean =>
      !!n &&
      (n.type === "async" ||
        n.type === "suspend" ||
        (/modifier/.test(String(n.type)) &&
          /^(?:async|suspend)$/.test(String(n.text ?? "").trim())));
    for (const child of node.children ?? []) {
      if (isAsyncTok(child)) return true;
      if (/modifiers/.test(String(child?.type))) {
        for (const gc of child.children ?? []) {
          if (isAsyncTok(gc)) return true;
        }
      }
    }
    return false;
  }

  private static readonly DECORATOR_NODE_KINDS = new Set([
    "decorator",
    "attribute_item",
    "marker_annotation",
    "annotation",
  ]);
  private static readonly MODIFIERS_CONTAINER_KINDS = new Set(["modifiers"]);

  private extractDecorators(node: any): string[] {
    const isDeco = (n: any) => !!n && TreeSitterSymbolExtractor.DECORATOR_NODE_KINDS.has(n.type);
    const text = (n: any): string => {
      const first =
        String(n?.text ?? "")
          .split(/\r?\n/, 1)[0]
          ?.trim() ?? "";
      return first.length > 120 ? `${first.slice(0, 117)}…` : first;
    };
    const out: string[] = [];

    for (const sib of node.parent?.children ?? []) {
      if (sib.startIndex >= node.startIndex) break;
      if (isDeco(sib)) out.push(text(sib));
      else if (sib.isNamed) out.length = 0;
    }

    for (const child of node.children ?? []) {
      if (isDeco(child)) out.push(text(child));
      else if (TreeSitterSymbolExtractor.MODIFIERS_CONTAINER_KINDS.has(child?.type)) {
        for (const gc of child.children ?? []) {
          if (isDeco(gc)) out.push(text(gc));
        }
      }
    }

    return [...new Set(out.filter(Boolean))].slice(0, 8);
  }

  private parseRefMatch(match: any, filePath: string): SymbolRef | null {
    let name: string | undefined;
    let refNode: { startPosition: { row: number; column: number } } | undefined;
    let referenceKind: SymbolRef["referenceKind"] = "unknown";

    for (const capture of match.captures) {
      const captureName = String(capture.name);
      if (
        captureName.endsWith("Ident") ||
        captureName.endsWith("Method") ||
        captureName.endsWith("Field")
      ) {
        name = capture.node.text;

        // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
        refNode = capture.node as any;
        if (captureName.startsWith("type")) referenceKind = "type";
        else if (captureName.startsWith("call") || captureName.startsWith("new")) {
          referenceKind = "call";
        }
      }
      if (captureName.endsWith("Ref") && !refNode) {
        // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
        refNode = capture.node as any;
        if (captureName.startsWith("type")) referenceKind = "type";
        else if (captureName.startsWith("call") || captureName.startsWith("new")) {
          referenceKind = "call";
        }
      }
    }

    if (!name || !refNode) return null;

    return {
      symbolId: `${filePath}:${name}`,
      symbolName: name,
      filePath,
      line: refNode.startPosition.row + 1,
      column: refNode.startPosition.column + 1,
      referenceKind,
    };
  }

  private isExported(node: any, content: string): boolean {
    const lines = content.split("\n");
    const lineIdx = node.startPosition.row;
    const line = lines[lineIdx] || "";
    return /^\s*export\b/.test(line) || this.hasExportModifier(node, content);
  }

  private hasExportModifier(node: any, _content: string): boolean {
    let current = node.parent;
    while (current) {
      if (current.type === "statement_block") return false;
      if (current.type === "export_statement" || current.type === "export_declaration") {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  private isFunctionLocal(node: any): boolean {
    let current = node.parent;
    while (current) {
      if (current.type === "statement_block") return true;
      current = current.parent;
    }
    return false;
  }

  private detectVisibility(node: any, nameText: string): "private" | "protected" | undefined {
    if (nameText.startsWith("#")) return "private";
    for (const child of node?.children ?? []) {
      if (child?.type === "accessibility_modifier") {
        if (child.text === "private") return "private";
        if (child.text === "protected") return "protected";
        return undefined;
      }
    }
    return undefined;
  }

  private extractSignature(paramsText: string, kind: SymbolKind): string | undefined {
    if (kind === "function" || kind === "method") {
      return paramsText
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim();
    }
    return undefined;
  }
}
