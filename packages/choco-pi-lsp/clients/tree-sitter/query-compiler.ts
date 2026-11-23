/**
 * Query compilation: pattern-to-query translation, inline patterns, query and query-batch caches, and compile-failure reporting.
 */
import type { LspBoundaryValue } from "../runtime-guards.ts";
import * as crypto from "node:crypto";
import { loadWebTreeSitter } from "../deps/web-tree-sitter.ts";
import { logTreeSitterDiagnostic } from "../tree-sitter-logger.ts";
import type { TreeSitterQuery } from "../tree-sitter-query-loader.ts";
import { loadLanguage } from "./grammar-loader.ts";
import {
  QUERY_BATCH_CACHE_MAX_ENTRIES,
  QUERY_CACHE_MAX_ENTRIES,
  type TreeSitterClientInternals,
} from "./internals.ts";
import { dbg } from "./runtime.ts";
import {
  QUERY_BATCH_MAX_LOAD_FAILURES,
  type GetInlinePatternResultContract,
  type PatternToQueryResultContract,
  type QueryBatch,
  type QueryBatchEntry,
} from "./shared.ts";

function queryCacheCap(): number {
  const value = Number.parseInt(process.env.CHOCO_PI_LSP_TREE_SITTER_QUERY_CACHE_CAP ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : QUERY_CACHE_MAX_ENTRIES;
}

function queryBatchCacheCap(): number {
  const value = Number.parseInt(
    process.env.CHOCO_PI_LSP_TREE_SITTER_QUERY_BATCH_CACHE_CAP ?? "",
    10,
  );
  return Number.isSafeInteger(value) && value > 0 ? value : QUERY_BATCH_CACHE_MAX_ENTRIES;
}

function cacheQuery(core: TreeSitterClientInternals, key: string, value: any): void {
  core.queryCache.delete(key);
  core.queryCache.set(key, value);
  while (core.queryCache.size > queryCacheCap()) {
    // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
    const oldest = core.queryCache.entries().next().value as [string, any] | undefined;
    if (!oldest) break;
    core.queryCache.delete(oldest[0]);
    oldest[1]?.query?.delete?.();
  }
}

function cacheQueryBatch(
  core: TreeSitterClientInternals,
  key: string,
  value: QueryBatch | null,
): void {
  core.queryBatchCache.delete(key);
  core.queryBatchCache.set(key, value);
  while (core.queryBatchCache.size > queryBatchCacheCap()) {
    // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
    const oldest = core.queryBatchCache.entries().next().value as
      | [string, QueryBatch | null]
      | undefined;
    if (!oldest) break;
    core.queryBatchCache.delete(oldest[0]);
    oldest[1]?.query?.delete?.();
  }
}

/**
 * Compile `queryDefs` into one multi-pattern Query for `languageId`, with a
 * pattern-index → rule map. Cached per language + rule-set identity.
 */
export async function compileQueryBatch(
  core: TreeSitterClientInternals,
  queryDefs: TreeSitterQuery[],
  languageId: string,
): Promise<QueryBatch | null> {
  // Key on rule CONTENT, not just ids: the batch stores each queryDef (its
  // message reaches diagnostics) and the compiled patterns. Rule ids are
  // stable across edits, so an id-only key kept serving the pre-edit batch
  // for the process lifetime even after the runner reloaded the rules from
  // disk on a RuleCache miss (#878). sha256 keeps the key bounded without
  // #889's 32-bit collision risk.
  const identity = crypto.createHash("sha256").update(JSON.stringify(queryDefs)).digest("hex");
  const cacheKey = getQueryCacheKey(`batch:${identity}`, languageId);
  const cached = core.queryBatchCache.get(cacheKey);
  if (cached !== undefined) {
    core.queryBatchCache.delete(cacheKey);
    core.queryBatchCache.set(cacheKey, cached);
    return cached;
  }

  // A loadLanguage() failure is transient (offline lazy grammar fetch,
  // transient mid-scan load error) — do NOT cache null for it, or every
  // later scan pays the ~3.3x per-rule fallback for the process lifetime
  // (#889). Retry on the next call, bounded so a grammar that never loads
  // doesn't re-attempt every scan.
  const language = await loadLanguage(core, languageId);
  if (!language) {
    const failures = (core.queryBatchLoadFailures.get(cacheKey) ?? 0) + 1;
    if (failures >= QUERY_BATCH_MAX_LOAD_FAILURES) {
      dbg(core, `Batch: grammar for ${languageId} failed to load ${failures} times — caching miss`);
      core.queryBatchLoadFailures.delete(cacheKey);
      cacheQueryBatch(core, cacheKey, null);
    } else {
      core.queryBatchLoadFailures.set(cacheKey, failures);
    }
    return null;
  }
  core.queryBatchLoadFailures.delete(cacheKey);

  const build = async (): Promise<QueryBatch | null> => {
    const Query = (await loadWebTreeSitter()).Query;

    const entries: QueryBatchEntry[] = [];
    const sources: string[] = [];
    const ownerOfPattern: number[] = [];
    for (const queryDef of queryDefs) {
      let patternCount: number;
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Language type compatibility

        // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
        const probe = new Query(language as any, queryDef.query);
        patternCount = probe.patternCount();
        probe.delete?.();
      } catch (err) {
        if (core.client.reportWasmAbort(err)) return null;
        // A rule that can't compile against THIS grammar is simply not
        // applicable here (e.g. a `type_annotation` pattern on javascript).
        dbg(core, `Batch: skipping ${queryDef.id} for ${languageId}: ${err}`);
        reportQueryCompileFailure(core, queryDef.id, languageId, err);
        continue;
      }
      const owner = entries.length;
      entries.push({
        queryDef,
        metavars: queryDef.metavars ?? [],
        postFilter: queryDef.post_filter,
        postFilterParams: queryDef.post_filter_params,
      });
      sources.push(queryDef.query);
      for (let i = 0; i < patternCount; i++) ownerOfPattern.push(owner);
    }
    if (entries.length === 0) return null;

    try {
      // biome-ignore lint/suspicious/noExplicitAny: Language type compatibility

      // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
      const query = new Query(language as any, sources.join("\n"));
      if (query.patternCount() !== ownerOfPattern.length) {
        dbg(
          core,
          `Batch pattern count mismatch for ${languageId} (${query.patternCount()} vs ${ownerOfPattern.length}) — falling back`,
        );
        return null;
      }
      return { query, entries, ownerOfPattern };
    } catch (err) {
      if (core.client.reportWasmAbort(err)) return null;
      dbg(core, `Batch compile failed for ${languageId}: ${err}`);
      return null;
    }
  };

  const batch = await build();
  cacheQueryBatch(core, cacheKey, batch);
  return batch;
}

/**
 * Convert pattern to tree-sitter query
 * First tries to load from query files, then falls back to inline patterns
 */
function patternToQuery(
  core: TreeSitterClientInternals,
  pattern: string,
  languageId: string,
): PatternToQueryResultContract {
  // Try to find matching query from loaded files
  const loadedQuery = core.queryLoader.findMatchingQuery(pattern, languageId);

  if (loadedQuery) {
    dbg(core, `Using loaded query: ${loadedQuery.id}`);

    return {
      query: loadedQuery.query,
      metavars: loadedQuery.metavars,
      postFilter: loadedQuery.post_filter,
      postFilterParams: loadedQuery.post_filter_params,
      queryDef: loadedQuery,
    };
  }

  // Fallback to inline patterns
  return getInlinePattern(pattern);
}

/**
 * Inline patterns as fallback when no query file matches
 */
function getInlinePattern(pattern: string): GetInlinePatternResultContract {
  // Pattern: async function $NAME($$$PARAMS) { $BODY }
  if (pattern.includes("async function") && pattern.includes("$NAME")) {
    return {
      query: `(function_declaration
					"async"
					name: (identifier) @NAME
					parameters: (formal_parameters) @PARAMS
					body: (statement_block) @BODY)`,
      metavars: ["NAME", "PARAMS", "BODY"],
    };
  }

  // Pattern: console.$METHOD($MSG)
  if (pattern.includes("console")) {
    return {
      query: `(call_expression
					function: (member_expression
						object: (identifier) @OBJ (#eq? @OBJ "console")
						property: (property_identifier) @METHOD)
					arguments: (arguments) @ARGS)`,
      metavars: ["OBJ", "METHOD", "ARGS"],
    };
  }

  // Pattern: function $NAME($$$PARAMS) { $BODY } - match long parameter lists
  if (pattern.includes("function $NAME") && pattern.includes("PARAMS")) {
    return {
      query: `(function_declaration
					name: (identifier) @NAME
					parameters: (formal_parameters) @PARAMS
					body: (statement_block) @BODY)`,
      metavars: ["NAME", "PARAMS", "BODY"],
      postFilter: "count_params",
      postFilterParams: { min_params: 6 },
    };
  }

  // Pattern: promise chains with .then().catch().then() - 3+ levels
  if (pattern.includes(".then") && pattern.includes(".catch")) {
    return {
      query: `(call_expression
					function: (member_expression
						object: (call_expression
							function: (member_expression
								object: (call_expression
									function: (member_expression
										property: (property_identifier) @M1)
									arguments: (arguments))
								property: (property_identifier) @M2)
							arguments: (arguments))
						property: (property_identifier) @M3)
					arguments: (arguments))
					(#match? @M1 "^(then|catch)$")
					(#match? @M2 "^(then|catch)$")
					(#match? @M3 "^(then|catch)$")`,
      metavars: ["M1", "M2", "M3"],
    };
  }

  // Fallback: try to create a simple identifier capture
  const simpleMatch = pattern.match(/\$([A-Z_][A-Z0-9_]*)/);
  if (simpleMatch) {
    const name = simpleMatch[1];

    return {
      query: `(identifier) @${name}`,
      metavars: [name],
    };
  }

  // If we can't convert, return empty to trigger fallback

  return { query: "", metavars: [] };
}

/**
 * Inject native tree-sitter predicates into S-expression query
 * This moves text filtering to WASM for better performance
 */
/** Generate cache key for compiled query */
function getQueryCacheKey(pattern: string, languageId: string): string {
  // Full pattern text as the key. The previous 32-bit hash could collide
  // across rules and permanently poison a cache slot with the wrong
  // compiled query (or a null meant for a different rule set) (#889).
  return `${languageId}:${pattern}`;
}

/** Compile a pattern into a tree-sitter Query with caching */
export async function compileQuery(
  core: TreeSitterClientInternals,
  pattern: string,
  languageId: string,
): Promise<{
  query: any;
  metavars: string[];
  postFilter?: string;
  postFilterParams?: unknown;
} | null> {
  const cacheKey = getQueryCacheKey(pattern, languageId);

  // Check cache first
  if (core.queryCache.has(cacheKey)) {
    dbg(core, `Query cache hit: ${cacheKey}`);
    const cached = core.queryCache.get(cacheKey);
    core.queryCache.delete(cacheKey);
    core.queryCache.set(cacheKey, cached);
    return cached;
  }

  const language = await loadLanguage(core, languageId);
  if (!language) {
    dbg(core, `Could not load language ${languageId}`);
    return null;
  }

  const {
    query: queryStr,
    metavars,
    postFilter,
    postFilterParams,
  } = patternToQuery(core, pattern, languageId);
  dbg(core, `Query string: ${queryStr.slice(0, 100)}...`);

  try {
    // biome-ignore lint/suspicious/noExplicitAny: Query constructor
    const Query = (await loadWebTreeSitter()).Query;
    // biome-ignore lint/suspicious/noExplicitAny: Language type compatibility

    // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
    const query = new Query(language as any, queryStr);
    dbg(core, `Query compiled with ${query.patternCount()} patterns`);

    const result = { query, metavars, postFilter, postFilterParams };
    // Cache the compiled query
    cacheQuery(core, cacheKey, result);
    return result;
  } catch (err) {
    core.client.reportWasmAbort(err);
    dbg(core, `Query compilation failed: ${err}`);
    return null;
  }
}

/** Compile a raw tree-sitter query string with caching */
export async function compileRawQuery(
  core: TreeSitterClientInternals,
  queryId: string,
  queryStr: string,
  metavars: string[],
  languageId: string,
  postFilter?: string,

  postFilterParams?: LspBoundaryValue,
): Promise<{
  query: any;
  metavars: string[];
  postFilter?: string;
  postFilterParams?: unknown;
} | null> {
  const cacheKey = getQueryCacheKey(`raw:${queryId}:${queryStr}`, languageId);

  if (core.queryCache.has(cacheKey)) {
    const cached = core.queryCache.get(cacheKey);
    core.queryCache.delete(cacheKey);
    core.queryCache.set(cacheKey, cached);
    return cached;
  }

  const language = await loadLanguage(core, languageId);
  if (!language) return null;

  try {
    // biome-ignore lint/suspicious/noExplicitAny: Query constructor from web-tree-sitter
    const Query = (await loadWebTreeSitter()).Query;
    // biome-ignore lint/suspicious/noExplicitAny: Language type compatibility

    // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
    const query = new Query(language as any, queryStr);
    const result = { query, metavars, postFilter, postFilterParams };
    cacheQuery(core, cacheKey, result);
    return result;
  } catch (err) {
    core.client.reportWasmAbort(err);
    dbg(core, `Raw query compilation failed (${queryId}): ${err}`);
    reportQueryCompileFailure(core, queryId, languageId, err);
    return null;
  }
}

/** Warn once per rule+grammar pair whose query fails to compile — a silently-dead rule needs a trail. */

function reportQueryCompileFailure(
  core: TreeSitterClientInternals,
  ruleId: string,
  languageId: string,
  err: LspBoundaryValue,
): void {
  // Keyed by rule AND language: a rule can be dispatched against more than one
  // grammar (`queriesForLanguage` hands the typescript set to tsx too), and
  // failing on one must not mute the report for the others.
  const key = `${ruleId}:${languageId}`;
  if (core.reportedCompileFailures.has(key)) return;
  core.reportedCompileFailures.add(key);
  logTreeSitterDiagnostic({
    subsystem: "tree-sitter-client",
    languageId,
    message:
      `tree-sitter rule '${ruleId}' failed to compile against '${languageId}' — ` +
      `matches for this rule are silently dropped rather than reported. ` +
      `Fix the query in the rule definition to re-enable it. (${err})`,
    metadata: { ruleId },
  });
}
