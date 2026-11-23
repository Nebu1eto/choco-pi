/**
 * Structural search and rule queries over files: predicate evaluation, match collection, file walks, and the regex fallback.
 */
import type { LspBoundaryValue } from "../runtime-guards.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { recordDegradationOnce } from "../degradation-ledger.ts";
import { getProjectIgnoreMatcher, isExcludedDirName } from "../file-utils.ts";
import { logTreeSitterDiagnostic } from "../tree-sitter-logger.ts";
import type { TreeSitterQuery } from "../tree-sitter-query-loader.ts";
import type { TreeSitterClientInternals } from "./internals.ts";
import { parseFileAndUse } from "./parse.ts";
import { applyPostFilter } from "./post-filters.ts";
import { compileQuery, compileQueryBatch, compileRawQuery } from "./query-compiler.ts";
import { dbg } from "./runtime.ts";
import {
  TREE_SITTER_MAX_SCAN_FILES,
  describeQueryPredicateValue,
  type StructuralMatch,
  type TreeSitterNode,
} from "./shared.ts";

// --- Structural Search ---

/**
 * Search for a structural pattern in files
 *
 * @param pattern - Pattern with metavariables (e.g., "console.log($MSG)")
 * @param languageId - Language ID (typescript, python, etc.)
 * @param rootDir - Directory to search
 * @param options - Search options
 * @returns Array of matches with captures
 */
export async function structuralSearch(
  core: TreeSitterClientInternals,
  pattern: string,
  languageId: string,
  rootDir: string,
  options: {
    maxResults?: number;
    fileFilter?: (path: string) => boolean;
  } = {},
): Promise<StructuralMatch[]> {
  if (!core.initialized) {
    const ok = await core.client.init();
    if (!ok) return [];
  }

  try {
    await core.queryLoader.loadQueries(rootDir);
  } catch (err) {
    dbg(core, `Failed to load queries for ${rootDir}: ${err}`);
  }

  // Compile pattern into tree-sitter query
  dbg(core, `Compiling pattern: ${pattern.slice(0, 50)}...`);
  const compiled = await compileQuery(core, pattern, languageId);
  if (!compiled) {
    dbg(core, `Pattern compilation failed`);
    return [];
  }
  dbg(core, `Pattern compiled, metavars: ${compiled.metavars.join(", ")}`);

  // Collect source files
  const files = collectFiles(rootDir, languageId, options.fileFilter);
  dbg(core, `Scanning ${files.length} files...`);

  const matches: StructuralMatch[] = [];
  const maxResults = options.maxResults ?? 50;

  for (const file of files) {
    if (matches.length >= maxResults) break;

    const fileMatches = await searchFileWithQuery(
      core,
      file,
      compiled.query,
      compiled.metavars,
      languageId,
      pattern,
      compiled.postFilter,
      compiled.postFilterParams,
    );
    matches.push(...fileMatches);
  }

  return matches.slice(0, maxResults);
}

/**
 * Run a preloaded query definition against a single file.
 *
 * Optimized for dispatch runner usage to avoid per-query directory scans.
 */
export async function runQueryOnFile(
  core: TreeSitterClientInternals,
  queryDef: TreeSitterQuery,
  filePath: string,
  languageId: string,
  options: { maxResults?: number } = {},
  contentOverride?: string,
): Promise<StructuralMatch[]> {
  if (!core.initialized) {
    const ok = await core.client.init();
    if (!ok) return [];
  }

  // Compile against the language the FILE is parsed as, never the query's
  // own `language:` key. A Query is bound to the grammar it compiled
  // against; run it on a tree from another grammar and tree-sitter returns
  // zero matches forever — which is what the javascript→typescript rule
  // merge had been doing (31 queries per JS file, structurally unable to
  // fire). `getQueryCacheKey` already namespaces by language.
  const compiled = await compileRawQuery(
    core,
    queryDef.id,
    queryDef.query,
    queryDef.metavars,
    languageId,
    queryDef.post_filter,
    queryDef.post_filter_params,
  );
  if (!compiled) return [];

  const matches = await searchFileWithQuery(
    core,
    filePath,
    compiled.query,
    compiled.metavars,
    languageId,
    queryDef.id,
    compiled.postFilter,
    compiled.postFilterParams,
    contentOverride,
  );

  const maxResults = options.maxResults ?? 50;
  return matches.slice(0, maxResults);
}

/**
 * Run a whole rule set against one file in a SINGLE tree walk (#675).
 *
 * Calling `runQueryOnFile` per rule re-walks the tree once per rule — ~34
 * walks per file on a project scan, measured at 3.3× the cost of one
 * combined query for byte-identical matches. Patterns are concatenated in
 * rule order and `match.patternIndex` maps back to the owning rule, so
 * per-rule metavars, predicates, post-filters and caps still apply and
 * results stay grouped in rule order. Rules that don't compile against this
 * language are dropped individually (never poisoning the batch), and a
 * combined query that fails to compile falls back to per-rule execution.
 */
export async function runQueriesOnFile(
  core: TreeSitterClientInternals,
  queryDefs: TreeSitterQuery[],
  filePath: string,
  languageId: string,
  options: { maxResults?: number } = {},
  contentOverride?: string,
): Promise<Array<{ queryDef: TreeSitterQuery; match: StructuralMatch }>> {
  if (queryDefs.length === 0) return [];
  if (!core.initialized) {
    const ok = await core.client.init();
    if (!ok) return [];
  }
  const maxResults = options.maxResults ?? 50;

  const batch = await compileQueryBatch(core, queryDefs, languageId);
  if (!batch) {
    // Fallback: one walk per rule, preserving rule order.
    const results: Array<{
      queryDef: TreeSitterQuery;
      match: StructuralMatch;
    }> = [];
    for (const queryDef of queryDefs) {
      const matches = await core.client.runQueryOnFile(
        queryDef,
        filePath,
        languageId,
        options,
        contentOverride,
      );
      for (const match of matches) results.push({ queryDef, match });
    }
    return results;
  }

  const perQuery = new Map<number, StructuralMatch[]>();
  await parseFileAndUse(core, filePath, languageId, contentOverride, (tree) => {
    try {
      for (const match of batch.query.matches(tree.rootNode)) {
        const owner = batch.ownerOfPattern[match.patternIndex];
        if (owner === undefined) continue;
        const bucket = perQuery.get(owner) ?? [];
        if (bucket.length >= maxResults) continue;
        const entry = batch.entries[owner];
        const captures: Record<string, TreeSitterNode> = {};
        for (const capture of match.captures) {
          if (entry.metavars.includes(capture.name)) {
            captures[capture.name] = capture.node;
          }
        }
        if (!evaluatePredicates(core, batch.query, match)) continue;
        if (
          entry.postFilter &&
          !applyPostFilter(core, entry.postFilter, entry.postFilterParams, captures, tree.rootNode)
        ) {
          continue;
        }
        if (match.captures.length === 0) continue;
        const firstNode = match.captures[0].node;
        const textCaptures: Record<string, string> = {};
        for (const [name, node] of Object.entries(captures)) {
          // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
          textCaptures[name] = (node as TreeSitterNode).text;
        }
        bucket.push({
          file: filePath,
          line: firstNode.startPosition.row + 1,
          column: firstNode.startPosition.column + 1,
          matchedText: firstNode.text,

          // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
          nodeType: firstNode.type as string | undefined,
          captures: textCaptures,
        });
        perQuery.set(owner, bucket);
      }
    } catch (err) {
      core.client.reportWasmAbort(err);
      dbg(core, `Batched query matching error: ${err}`);
    }
  });

  const results: Array<{
    queryDef: TreeSitterQuery;
    match: StructuralMatch;
  }> = [];
  for (let i = 0; i < batch.entries.length; i++) {
    for (const match of perQuery.get(i) ?? []) {
      results.push({ queryDef: batch.entries[i].queryDef, match });
    }
  }
  return results;
}

/**
 * Typed accessor for `query.textPredicates`. If the property is missing or the
 * wrong shape — e.g. a future web-tree-sitter upgrade renames or removes it —
 * `query.textPredicates?.[i] ?? []` would silently mean "no predicates for this
 * pattern," passing every match through unfiltered. That's a silent fail-open on
 * #match?/#eq? predicates that rules rely on for correctness, and because this
 * runs for every match of every query, it would zero out ALL structural matches
 * across every language while choco-pi-lsp reports "no issues found." Fail loud (log
 * once per client instance, record a degradation so it reaches the user) and
 * closed (report the query has no usable predicates) instead of guessing.
 *
 * No WeakSet short-circuit for already-known-bad queries here (#1523 review
 * R1): `Array.isArray` is O(1), so memoizing it buys nothing, and a
 * process-lifetime WeakSet would make the SAME cached Query object (the query
 * cache is LRU-evicted, never cleared) skip straight past
 * `recordDegradationOnce` on every call after the first — which is exactly
 * what made the degradation record fail to re-arm across a session boundary
 * for a query the cache kept warm. `recordDegradationOnce` itself is called
 * unconditionally on every invalid check; the ledger's own once-per-kind/
 * subject dedupe (cleared by resetDegradationLedger, which handleSessionStart
 * calls first thing — clients/runtime-session.ts) is the single source of
 * truth for "how often does this actually get recorded."
 */
// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter Query instances
function hasValidTextPredicates(core: TreeSitterClientInternals, query: any): boolean {
  const valid = Array.isArray(query?.textPredicates);
  if (!valid) {
    if (!core.textPredicatesInvalidLogged) {
      core.textPredicatesInvalidLogged = true;
      logTreeSitterDiagnostic({
        subsystem: "tree-sitter-client",
        message:
          "web-tree-sitter Query.textPredicates is missing or not an array — " +
          "#match?/#eq? predicates cannot be evaluated. Failing CLOSED: matches " +
          "for this query are dropped rather than reported unfiltered.",

        metadata: { textPredicatesType: describeQueryPredicateValue(query?.textPredicates) },
      });
    }
    // User-facing signal (#1523 review F1). Called unconditionally on every
    // invalid check (not gated by a client-lifetime latch) so it re-arms
    // every session, per the R1 fix above.
    recordDegradationOnce({
      kind: "query-predicates-invalid",
      subject: "web-tree-sitter",
      reason:
        "Query.textPredicates is missing or not an array — #match?/#eq? " +
        "predicates cannot be evaluated; structural matches relying on them " +
        "are dropped fail-closed",
    });
  }
  return valid;
}

/**
 * Evaluate text predicates (#match?, #eq?) for a query match. web-tree-sitter
 * 0.25's `Query.matches()` DOES apply these predicates itself (probed on the
 * shipped grammars — see clients/tree-sitter-symbol-extractor.ts), so this is a
 * belt-and-braces re-filter, not a workaround for missing enforcement. It also
 * doubles as the fail-closed guard (#1523): if `query.textPredicates` is ever
 * missing or malformed, this drops the match instead of assuming it already
 * passed upstream.
 */
// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter types
function evaluatePredicates(core: TreeSitterClientInternals, query: any, match: any): boolean {
  if (!hasValidTextPredicates(core, query)) return false;
  // `?.` guards a post-validation removal of the property (e.g. a later
  // mutation strips it after the first successful check) so the read can't
  // throw here — an uncaught throw would be swallowed by the outer try/catch
  // in searchFileWithQuery and silently zero out matches for the whole file.

  const predicates: Array<(captures: LspBoundaryValue) => boolean> =
    query.textPredicates?.[match.patternIndex] ?? [];
  return predicates.every((fn) => fn(match.captures));
}

/** Search a single file using tree-sitter Query */
async function searchFileWithQuery(
  core: TreeSitterClientInternals,
  filePath: string,
  // biome-ignore lint/suspicious/noExplicitAny: Query type from web-tree-sitter
  query: any,
  metavars: string[],
  languageId: string,
  _originalPattern?: string,
  postFilter?: string,
  // biome-ignore lint/suspicious/noExplicitAny: Post filter params
  postFilterParams?: any,
  contentOverride?: string,
): Promise<StructuralMatch[]> {
  const matches: StructuralMatch[] = [];

  await parseFileAndUse(core, filePath, languageId, contentOverride, (tree) => {
    try {
      const queryMatches = query.matches(tree.rootNode);

      for (const match of queryMatches) {
        const captures: Record<string, TreeSitterNode> = {};

        for (const capture of match.captures) {
          if (metavars.includes(capture.name)) {
            captures[capture.name] = capture.node;
          }
        }

        // Belt-and-braces re-check of #match?/#eq? predicates (web-tree-sitter
        // 0.25's Query.matches() already applies them) plus the fail-closed
        // guard for a malformed query.textPredicates (see evaluatePredicates).
        if (!evaluatePredicates(core, query, match)) {
          continue;
        }

        if (
          postFilter &&
          !applyPostFilter(core, postFilter, postFilterParams, captures, tree.rootNode)
        ) {
          continue;
        }

        if (match.captures.length > 0) {
          const firstNode = match.captures[0].node;
          const textCaptures: Record<string, string> = {};
          for (const [name, node] of Object.entries(captures)) {
            // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
            textCaptures[name] = (node as TreeSitterNode).text;
          }
          matches.push({
            file: filePath,
            line: firstNode.startPosition.row + 1,
            column: firstNode.startPosition.column + 1,
            matchedText: firstNode.text,

            // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
            nodeType: firstNode.type as string | undefined,
            captures: textCaptures,
          });
        }
      }

      if (matches.length > 0) {
        dbg(core, `Found ${matches.length} matches in ${path.basename(filePath)}`);
      }
    } catch (err) {
      core.client.reportWasmAbort(err);
      dbg(core, `Query matching error: ${err}`);
    }
  });

  return matches;
}

/** Collect source files for a language */
function collectFiles(
  dir: string,
  languageId: string,
  fileFilter?: (path: string) => boolean,
): string[] {
  const files: string[] = [];
  const extensions = getExtensionsForLanguage(languageId);
  const rootDir = path.resolve(dir);
  const ignoreMatcher = getProjectIgnoreMatcher(rootDir);

  // Hard cap on the walk itself (not just result collection). The per-file
  // `maxResults` break upstream only stops gathering matches *after* the walk
  // has already enumerated the whole tree — so a misrooted structuralSearch
  // would still synchronously read every directory. Bound the walk (#262).
  const scan = (d: string) => {
    if (files.length >= TREE_SITTER_MAX_SCAN_FILES) return;
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= TREE_SITTER_MAX_SCAN_FILES) return;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (isExcludedDirName(entry.name)) continue;
          if (ignoreMatcher.isIgnored(full, true)) continue;
          scan(full);
        } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
          if (ignoreMatcher.isIgnored(full, false)) continue;
          if (!fileFilter || fileFilter(full)) {
            files.push(full);
          }
        }
      }
    } catch {}
  };

  scan(rootDir);
  return files;
}

/** Get file extensions for a language */
function getExtensionsForLanguage(languageId: string): string[] {
  interface MappingValues extends Record<string, string[]> {}
  const mapping: MappingValues = {
    typescript: [".ts", ".mts", ".cts"],
    tsx: [".tsx"],
    javascript: [".js", ".mjs", ".cjs"],
    python: [".py"],
    rust: [".rs"],
    go: [".go"],
    java: [".java"],
    kotlin: [".kt", ".kts"],
    dart: [".dart"],
    c: [".c", ".h"],
    cpp: [".cpp", ".hpp", ".cc", ".hh"],
    elixir: [".ex", ".exs"],
    ruby: [".rb"],
  };
  return mapping[languageId] || [];
}

// --- Simplified Pattern Search (regex fallback) ---

/**
 * Fallback structural search using regex when tree-sitter unavailable
 * Less accurate but works without WASM dependencies
 */
export function regexStructuralSearch(
  pattern: string,
  files: string[],
  options: { maxResults?: number } = {},
): StructuralMatch[] {
  const matches: StructuralMatch[] = [];
  const maxResults = options.maxResults ?? 50;

  // Extract pattern structure for regex
  // "console.log($MSG)" -> /console\.log\(([^)]+)\)/
  const regexPattern = pattern
    .replace(/\\/g, "\\\\")
    .replace(/\./g, "\\.")
    .replace(/\$\$\$[A-Z_][A-Z0-9_]*/g, "(.*?)") // variadic - non-greedy
    .replace(/\$[A-Z_][A-Z0-9_]*/g, "([^,)]+)"); // single - capture group

  try {
    const regex = new RegExp(regexPattern, "g");

    for (const file of files) {
      if (matches.length >= maxResults) break;

      try {
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0;
          const match = regex.exec(lines[i]);
          if (match) {
            const captures: Record<string, string> = {};
            // Extract captures
            for (let j = 1; j < match.length; j++) {
              captures[`$${j}`] = match[j];
            }

            matches.push({
              file,
              line: i + 1,
              column: match.index + 1,
              matchedText: match[0],
              captures,
            });

            if (matches.length >= maxResults) break;
          }
        }
      } catch {}
    }
  } catch {
    // Invalid regex
  }

  return matches;
}
