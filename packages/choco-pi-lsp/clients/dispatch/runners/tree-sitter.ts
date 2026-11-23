import * as path from "node:path";
import { obj, compile } from "@earendil-works/pi-schema";
import { isRuntimeString } from "../../../tools/runtime-values.ts";
import { isFiniteNumber } from "../../lsp/schema-guards.ts";
import { RuleCache } from "../../cache/rule-cache.ts";
import { minimatch } from "../../deps/minimatch.ts";
import { isTestFile } from "../../file-utils.ts";
import {
  buildOrUpdateGraph,
  computeImpactCascade,
  recordEntitySnapshotDiff,
} from "../../review-graph/service.ts";
import type { TreeSitterClient } from "../../tree-sitter-client.ts";
import {
  getSharedTreeSitterClient,
  isTreeSitterWasmAborted,
  markTreeSitterWasmAborted,
  resolveTreeSitterLanguage,
} from "../../tree-sitter-shared.ts";
import { logTreeSitter } from "../../tree-sitter-logger.ts";
import {
  isDisabledQueryFilePath,
  queriesForLanguage,
  queryLoader,
  ruleFilesForLanguage,
  ruleSourceLanguages,
  type TreeSitterQuery,
} from "../../tree-sitter-query-loader.ts";
import type { ProtocolDictionary, ProtocolValue } from "../../../tools/runtime-values.ts";
import { classifyDefect } from "../diagnostic-taxonomy.ts";
import { PRIORITY } from "../priorities.ts";
import type {
  DefectClass,
  Diagnostic,
  DispatchContext,
  RunnerDefinition,
  RunnerResult,
} from "../types.ts";

const blastCooldownByFile = new Map<string, number>();
const BLAST_COOLDOWN_MS = 5_000;

function runBlastRadiusInBackground(
  cwd: string,
  filePath: string,
  languageId: string,
  facts: DispatchContext["facts"],
): void {
  void (async () => {
    try {
      const graph = await buildOrUpdateGraph(cwd, [filePath], facts);
      const impact = computeImpactCascade(graph, filePath, cwd);
      logTreeSitter({
        phase: "blast_radius",
        filePath,
        languageId,
        metadata: {
          changedSymbols: impact.changedSymbols,
          neighborFiles: impact.neighborFiles,
          directImporters: impact.directImporters,
          directCallers: impact.directCallers,
          riskFlags: impact.riskFlags,
        },
      });
    } catch {}
  })();
}

interface EntityQueryDef {
  id: string;
  kind: string;
  query: string;
}

const JSTS_SHARED_ENTITY_QUERIES: EntityQueryDef[] = [
  {
    id: "entity-jsts-function",
    kind: "function",
    query: "(function_declaration name: (identifier) @NAME)",
  },
  {
    id: "entity-jsts-method",
    kind: "method",
    query: "(method_definition name: (property_identifier) @NAME)",
  },
  {
    id: "entity-jsts-arrow",
    kind: "function",
    query:
      "(lexical_declaration (variable_declarator name: (identifier) @NAME value: [(arrow_function) (function_expression)]))",
  },
];

const TS_STRUCTURAL_ENTITY_QUERIES: EntityQueryDef[] = [
  {
    id: "entity-ts-interface",
    kind: "interface",
    query: "(interface_declaration name: (type_identifier) @NAME)",
  },
  {
    id: "entity-ts-type",
    kind: "type",
    query: "(type_alias_declaration name: (type_identifier) @NAME)",
  },
  {
    id: "entity-ts-enum",
    kind: "enum",
    query: "(enum_declaration name: (identifier) @NAME)",
  },
];

const ProtocolObjectSchema = obj({}, { open: true });
const isProtocolObject = compile(ProtocolObjectSchema).check;

function isProtocolValue<T>(value: T): value is T & ProtocolValue {
  if (
    value === null ||
    isRuntimeString(value) ||
    isFiniteNumber(value) ||
    value === true ||
    value === false
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isProtocolValue);
  if (!isProtocolObject(value)) return false;
  return Object.values(value).every(isProtocolValue);
}

function isProtocolDictionary<T>(value: T): value is T & ProtocolDictionary {
  return isProtocolObject(value) && Object.values(value).every(isProtocolValue);
}

function normalizeCachedSeverity(severity: string): TreeSitterQuery["severity"] {
  return severity === "error" || severity === "info" ? severity : "warning";
}

interface EntityQueryMap {
  [language: string]: EntityQueryDef[] | undefined;
}

const ENTITY_QUERIES: EntityQueryMap = {
  typescript: [
    {
      id: "entity-ts-class",
      kind: "class",
      query: "(class_declaration name: (type_identifier) @NAME)",
    },
    ...JSTS_SHARED_ENTITY_QUERIES,
    ...TS_STRUCTURAL_ENTITY_QUERIES,
  ],
  javascript: [
    {
      id: "entity-js-class",
      kind: "class",
      query: "(class_declaration name: (identifier) @NAME)",
    },
    ...JSTS_SHARED_ENTITY_QUERIES,
  ],
  python: [
    {
      id: "entity-py-function",
      kind: "function",
      query: "(function_definition name: (identifier) @NAME)",
    },
    {
      id: "entity-py-class",
      kind: "class",
      query: "(class_definition name: (identifier) @NAME)",
    },
  ],
  go: [
    {
      id: "entity-go-function",
      kind: "function",
      query: "(function_declaration name: (identifier) @NAME)",
    },
    {
      id: "entity-go-method",
      kind: "method",
      query: "(method_declaration name: (field_identifier) @NAME)",
    },
    {
      id: "entity-go-type",
      kind: "type",
      query: "(type_spec name: (type_identifier) @NAME)",
    },
  ],
  rust: [
    {
      id: "entity-rs-function",
      kind: "function",
      query: "(function_item name: (identifier) @NAME)",
    },
    {
      id: "entity-rs-struct",
      kind: "struct",
      query: "(struct_item name: (type_identifier) @NAME)",
    },
    {
      id: "entity-rs-enum",
      kind: "enum",
      query: "(enum_item name: (type_identifier) @NAME)",
    },
    {
      id: "entity-rs-trait",
      kind: "trait",
      query: "(trait_item name: (type_identifier) @NAME)",
    },
    {
      id: "entity-rs-type",
      kind: "type",
      query: "(type_item name: (type_identifier) @NAME)",
    },
  ],
  ruby: [
    {
      id: "entity-rb-method",
      kind: "method",
      query: "(method name: (identifier) @NAME)",
    },
    {
      id: "entity-rb-singleton-method",
      kind: "method",
      query: "(singleton_method name: (identifier) @NAME)",
    },
    {
      id: "entity-rb-class",
      kind: "class",
      query: "(class name: (constant) @NAME)",
    },
    {
      id: "entity-rb-module",
      kind: "module",
      query: "(module name: (constant) @NAME)",
    },
  ],
  c: [
    {
      id: "entity-c-function",
      kind: "function",
      query:
        "(function_definition declarator: (function_declarator declarator: (identifier) @NAME))",
    },
    {
      id: "entity-c-typedef",
      kind: "type",
      query: "(type_definition declarator: (type_identifier) @NAME)",
    },
    {
      id: "entity-c-struct",
      kind: "struct",
      query: "(struct_specifier name: (type_identifier) @NAME)",
    },
    {
      id: "entity-c-enum",
      kind: "enum",
      query: "(enum_specifier name: (type_identifier) @NAME)",
    },
  ],
  cpp: [
    {
      id: "entity-cpp-function",
      kind: "function",
      query:
        "(function_definition declarator: (function_declarator declarator: (identifier) @NAME))",
    },
    {
      id: "entity-cpp-class",
      kind: "class",
      query: "(class_specifier name: (type_identifier) @NAME)",
    },
    {
      id: "entity-cpp-struct",
      kind: "struct",
      query: "(struct_specifier name: (type_identifier) @NAME)",
    },
    {
      id: "entity-cpp-namespace",
      kind: "namespace",
      query: "(namespace_definition name: (namespace_identifier) @NAME)",
    },
  ],
};

async function extractEntitySnapshot(
  client: TreeSitterClient,
  filePath: string,
  languageId: string,
  contentOverride?: string,
): Promise<Map<string, string>> {
  const defs = ENTITY_QUERIES[languageId] ?? [];
  const snapshot = new Map<string, string>();

  for (const def of defs) {
    const matches = await client.runQueryOnFile(
      {
        id: def.id,
        name: def.id,
        severity: "info",
        category: "entity",
        language: languageId,
        message: "",
        query: def.query,
        metavars: ["NAME"],
        has_fix: false,
        filePath: "",
      },
      filePath,
      languageId,
      { maxResults: 200 },
      contentOverride,
    );

    for (const match of matches) {
      const name = match.captures.NAME?.trim();
      if (!name) continue;
      const key = `${def.kind}:${name}`;
      snapshot.set(key, `${match.line}:${match.matchedText.slice(0, 400)}`);
    }
  }

  return snapshot;
}

const SILENT_ERROR_QUERY_IDS = new Set([
  "empty-catch",
  "python-empty-except",
  "ruby-empty-rescue",
  "go-bare-error",
  "no-discarded-error",
]);

function defaultFixSuggestion(defectClass: string, ruleId: string): string {
  if (defectClass === "silent-error") {
    return "Handle the error path explicitly: add logging/telemetry and rethrow or return a typed error result.";
  }
  if (defectClass === "secrets") {
    return "Move secret material to environment/secret manager and read it at runtime.";
  }
  if (defectClass === "injection") {
    return "Replace dynamic execution/string interpolation with parameterized or allowlisted operations.";
  }
  if (defectClass === "async-misuse") {
    return "Restructure async flow to handle errors and sequencing deterministically (await/try-catch or explicit concurrency control).";
  }
  if (ruleId.includes("unwrap")) {
    return "Replace unwrap() with explicit error handling (match/if-let) or propagate with ?.";
  }
  return "Refactor this pattern to a safer, explicit form matching project conventions.";
}

function isLineInModifiedRanges(
  line: number,
  ranges: ReadonlyArray<{ start: number; end: number }> | undefined,
): boolean {
  if (!ranges || ranges.length === 0) return true;
  return ranges.some((r) => line >= r.start && line <= r.end);
}

function getTotalLinesChanged(
  ranges: ReadonlyArray<{ start: number; end: number }> | undefined,
): number {
  if (!ranges || ranges.length === 0) return 0;
  return ranges.reduce((total, r) => total + (r.end - r.start + 1), 0);
}

const ENTITY_EXTRACTION_LINE_THRESHOLD = 5;

function relativeForIgnoreGlob(filePath: string, root: string): string {
  const rel = path.relative(root, filePath);
  const normalized = (rel.startsWith("..") ? filePath : rel).split(path.sep).join("/");
  return normalized;
}

function matchesIgnorePaths(
  filePath: string,
  root: string,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false;
  const rel = relativeForIgnoreGlob(filePath, root);
  return patterns.some((pattern) => minimatch(rel, pattern, { dot: true }));
}

const treeSitterRunner: RunnerDefinition = {
  id: "tree-sitter",
  appliesTo: ["jsts", "python", "go", "rust", "ruby", "cxx", "csharp", "php", "css"],
  priority: PRIORITY.STRUCTURAL_ANALYSIS,
  enabledByDefault: true,
  skipTestFiles: false,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const client = getSharedTreeSitterClient();
    logTreeSitter({ phase: "runner_start", filePath: ctx.filePath });
    if (!client || !client.isAvailable()) {
      logTreeSitter({
        phase: "runner_skip",
        filePath: ctx.filePath,
        reason: isTreeSitterWasmAborted() ? "wasm_aborted" : "client_unavailable",
        status: "skipped",
      });
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const initialized = await client.init();
    if (!initialized) {
      logTreeSitter({
        phase: "runner_skip",
        filePath: ctx.filePath,
        reason: "client_init_failed",
        status: "skipped",
      });
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const filePath = ctx.filePath;
    const ext = path.extname(filePath).toLowerCase();
    const languageId = resolveTreeSitterLanguage(filePath);
    if (!languageId) {
      logTreeSitter({
        phase: "runner_skip",
        filePath: ctx.filePath,
        reason: `unsupported_extension:${ext}`,
        status: "skipped",
      });
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    let languageQueries: TreeSitterQuery[] = [];
    const cache = new RuleCache(languageId, ctx.cwd);

    const ruleFiles = ruleFilesForLanguage(languageId, ctx.cwd);

    const cached = cache.get(ruleFiles);
    let cacheHit = false;
    if (cached) {
      cacheHit = true;
      languageQueries = cached.queries
        .map((q) => ({
          ...q,
          severity: normalizeCachedSeverity(q.severity),
          category: "cached",
          has_fix: q.has_fix ?? false,
          filePath: q.filePath ?? "",
        }))
        .filter((q) => !isDisabledQueryFilePath(q.filePath));
    } else {
      await queryLoader.loadQueries(ctx.cwd, { force: true });

      languageQueries = queriesForLanguage(
        new Map(
          ruleSourceLanguages(languageId).map((lang) => [
            lang,
            queryLoader.getQueriesForLanguage(lang),
          ]),
        ),
        languageId,
      );

      cache.set(
        ruleFiles,
        languageQueries.map((q) => ({
          id: q.id,
          name: q.name,
          severity: q.severity,
          language: q.language,
          message: q.message,
          query: q.query,
          metavars: q.metavars,
          post_filter: q.post_filter,
          post_filter_params: isProtocolDictionary(q.post_filter_params)
            ? q.post_filter_params
            : undefined,
          defect_class: q.defect_class,
          inline_tier: q.inline_tier,
          skip_test_files: q.skip_test_files,
          ignore_paths: q.ignore_paths,
          has_fix: q.has_fix,
          fix_action: q.fix_action,
          filePath: q.filePath,
        })),
      );
    }

    if (languageQueries.length === 0) {
      logTreeSitter({
        phase: "runner_complete",
        filePath,
        languageId,
        status: "succeeded",
        diagnostics: 0,
        blocking: 0,
        queryCount: 0,
        effectiveQueryCount: 0,
      });
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    const fileIsTest = isTestFile(filePath);
    const ignoreRoot = ctx.projectRoot ?? ctx.cwd;
    const effectiveQueries = (
      ctx.blockingOnly ? languageQueries.filter((q) => q.inline_tier !== "review") : languageQueries
    ).filter(
      (q) =>
        !(fileIsTest && q.skip_test_files) &&
        !matchesIgnorePaths(filePath, ignoreRoot, q.ignore_paths),
    );

    logTreeSitter({
      phase: "queries_loaded",
      filePath,
      languageId,
      queryCount: languageQueries.length,
      effectiveQueryCount: effectiveQueries.length,
      cacheHit,
      metadata: { blockingOnly: !!ctx.blockingOnly },
    });

    const contentFromFacts = ctx.facts.getFileFact<string | null>(filePath, "file.content");
    const contentOverride =
      contentFromFacts !== undefined && contentFromFacts !== null ? contentFromFacts : undefined;

    const diagnostics: Diagnostic[] = [];
    try {
      const found = await client.runQueriesOnFile(
        effectiveQueries,
        filePath,
        languageId,
        { maxResults: 10 },
        contentOverride,
      );

      for (const { queryDef: query, match } of found) {
        const { line, column } = match;

        const isSeverityBlocking =
          query.severity === "error" ||
          query.inline_tier === "blocking" ||
          SILENT_ERROR_QUERY_IDS.has(query.id);
        if (
          ctx.blockingOnly &&
          isSeverityBlocking &&
          !isLineInModifiedRanges(line, ctx.modifiedRanges)
        ) {
          continue;
        }

        const semantic =
          query.severity === "error"
            ? "blocking"
            : query.severity === "warning"
              ? "warning"
              : "none";
        const configuredDefectClass: DefectClass | undefined = (() => {
          switch (query.defect_class) {
            case "silent-error":
            case "injection":
            case "secrets":
            case "async-misuse":
            case "correctness":
            case "safety":
            case "style":
            case "unknown":
            case "unused-value":
              return query.defect_class;
            default:
              return undefined;
          }
        })();
        const defectClass =
          configuredDefectClass ?? classifyDefect(query.id, "tree-sitter", query.message);
        const suggestion =
          query.has_fix && query.fix_action
            ? `${query.fix_action} this statement`
            : semantic === "blocking"
              ? defaultFixSuggestion(defectClass, query.id)
              : undefined;

        const hasSuggestedFix = !!query.has_fix;
        diagnostics.push({
          id: `tree-sitter:${query.id}:${line}`,
          message: query.message.replace(
            /\{\{(\w+)\}\}/g,
            (_, name) => match.captures[name]?.trim() ?? `{{${name}}}`,
          ),
          filePath,
          line,
          column,
          severity: query.severity,
          semantic,
          tool: "tree-sitter",
          rule: query.id,
          defectClass,
          fixable: hasSuggestedFix,
          autoFixAvailable: false,
          fixKind: hasSuggestedFix ? "suggestion" : undefined,
          fixSuggestion: suggestion,
          matchedText: match.matchedText || undefined,
          astNodeType: match.nodeType || undefined,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Aborted") || msg.includes("abort()")) {
        markTreeSitterWasmAborted();
        logTreeSitter({
          phase: "query_error",
          filePath,
          languageId,
          error: "wasm_aborted_fatal",
          metadata: { queryIds: effectiveQueries.map((q) => q.id) },
        });
      } else {
        logTreeSitter({
          phase: "query_error",
          filePath,
          languageId,
          error: msg,
          metadata: { queryIds: effectiveQueries.map((q) => q.id) },
        });
      }
    }

    const totalLinesChanged = getTotalLinesChanged(ctx.modifiedRanges);
    const skipEntityExtraction =
      ctx.modifiedRanges != null &&
      ctx.modifiedRanges.length > 0 &&
      totalLinesChanged < ENTITY_EXTRACTION_LINE_THRESHOLD;

    if (!skipEntityExtraction) {
      try {
        const snapshot = await extractEntitySnapshot(client, filePath, languageId, contentOverride);
        const diff = recordEntitySnapshotDiff(ctx.facts, filePath, snapshot);
        const changedEntityKeys = [...diff.added, ...diff.modified, ...diff.removed];

        if (changedEntityKeys.length > 0) {
          logTreeSitter({
            phase: "entity_diff",
            filePath,
            languageId,
            metadata: {
              added: diff.added,
              modified: diff.modified,
              removed: diff.removed,
              totalChanged: changedEntityKeys.length,
            },
          });

          const lastBlast = blastCooldownByFile.get(filePath) ?? 0;
          if (Date.now() - lastBlast < BLAST_COOLDOWN_MS) {
            logTreeSitter({
              phase: "blast_radius",
              filePath,
              languageId,
              metadata: { skipped: "cooldown", cooldownMs: BLAST_COOLDOWN_MS },
            });
          } else {
            blastCooldownByFile.set(filePath, Date.now());
            runBlastRadiusInBackground(ctx.cwd, filePath, languageId, ctx.facts);
          }
        }
      } catch {}
    }

    if (diagnostics.length === 0) {
      logTreeSitter({
        phase: "runner_complete",
        filePath,
        languageId,
        status: "succeeded",
        diagnostics: 0,
        blocking: 0,
        queryCount: languageQueries.length,
        effectiveQueryCount: effectiveQueries.length,
      });
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
    const blockingCount = diagnostics.filter((d) => d.semantic === "blocking").length;

    logTreeSitter({
      phase: "runner_complete",
      filePath,
      languageId,
      status: hasBlocking ? "failed" : "succeeded",
      diagnostics: diagnostics.length,
      blocking: blockingCount,
      queryCount: languageQueries.length,
      effectiveQueryCount: effectiveQueries.length,
    });

    return {
      status: hasBlocking ? "failed" : "succeeded",
      diagnostics,
      semantic: hasBlocking ? "blocking" : "warning",
    };
  },
};

export default treeSitterRunner;
