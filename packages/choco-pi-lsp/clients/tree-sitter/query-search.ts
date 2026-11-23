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

  dbg(core, `Compiling pattern: ${pattern.slice(0, 50)}...`);
  const compiled = await compileQuery(core, pattern, languageId);
  if (!compiled) {
    dbg(core, `Pattern compilation failed`);
    return [];
  }
  dbg(core, `Pattern compiled, metavars: ${compiled.metavars.join(", ")}`);

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

function evaluatePredicates(core: TreeSitterClientInternals, query: any, match: any): boolean {
  if (!hasValidTextPredicates(core, query)) return false;

  const predicates: Array<(captures: LspBoundaryValue) => boolean> =
    query.textPredicates?.[match.patternIndex] ?? [];
  return predicates.every((fn) => fn(match.captures));
}

async function searchFileWithQuery(
  core: TreeSitterClientInternals,
  filePath: string,
  query: any,
  metavars: string[],
  languageId: string,
  _originalPattern?: string,
  postFilter?: string,
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

function collectFiles(
  dir: string,
  languageId: string,
  fileFilter?: (path: string) => boolean,
): string[] {
  const files: string[] = [];
  const extensions = getExtensionsForLanguage(languageId);
  const rootDir = path.resolve(dir);
  const ignoreMatcher = getProjectIgnoreMatcher(rootDir);

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

export function regexStructuralSearch(
  pattern: string,
  files: string[],
  options: { maxResults?: number } = {},
): StructuralMatch[] {
  const matches: StructuralMatch[] = [];
  const maxResults = options.maxResults ?? 50;

  const regexPattern = pattern
    .replace(/\\/g, "\\\\")
    .replace(/\./g, "\\.")
    .replace(/\$\$\$[A-Z_][A-Z0-9_]*/g, "(.*?)")
    .replace(/\$[A-Z_][A-Z0-9_]*/g, "([^,)]+)");

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
  } catch {}

  return matches;
}
