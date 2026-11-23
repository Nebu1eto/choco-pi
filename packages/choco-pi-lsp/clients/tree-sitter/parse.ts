import * as fs from "node:fs";
import { findGrammarsDir, getParser, loadLanguage, resolveGrammarFile } from "./grammar-loader.ts";
import type { TreeSitterClientInternals } from "./internals.ts";
import { dbg, recordParserCounter } from "./runtime.ts";
import {
  NOT_PARSED,
  type ParsedTreeOutcome,
  type TreeSitterLanguage,
  type TreeSitterTree,
} from "./shared.ts";

export async function parseFile(
  core: TreeSitterClientInternals,
  filePath: string,
  languageId: string,
  contentOverride?: string,
): Promise<TreeSitterTree | null> {
  const outcome = await parseFileAndUse(
    core,
    filePath,
    languageId,
    contentOverride,
    (tree) => tree,
  );
  return outcome.parsed ? outcome.value : null;
}

export async function withParsedTree<T>(
  core: TreeSitterClientInternals,
  filePath: string,
  languageId: string,
  contentOverride: string | undefined,
  consume: (tree: TreeSitterTree) => T,
): Promise<ParsedTreeOutcome<T>> {
  return parseFileAndUse(core, filePath, languageId, contentOverride, consume);
}

export async function parseFileAndUse<T>(
  core: TreeSitterClientInternals,
  filePath: string,
  languageId: string,
  contentOverride: string | undefined,
  consume: (tree: TreeSitterTree) => T,
): Promise<ParsedTreeOutcome<T>> {
  dbg(core, `Parsing ${filePath} with language ${languageId}`);
  const parser = await getParser(core, languageId);
  if (!parser) {
    dbg(core, `Failed to get parser for ${languageId}`);
    return NOT_PARSED;
  }

  let tree: TreeSitterTree;
  try {
    const content = contentOverride ?? fs.readFileSync(filePath, "utf-8");
    dbg(core, `File content length: ${content.length}`);

    const cachedTree = core.treeCache.get(filePath, content, languageId);
    if (cachedTree) {
      dbg(core, `Using cached tree for ${filePath}`);
      tree = cachedTree;
    } else {
      const parseStartedAt = performance.now();
      recordParserCounter(core, "parserInvocations");
      try {
        tree = parser.parse(content);
      } catch (err) {
        recordParserCounter(core, "parserFailures");
        throw err;
      } finally {
        recordParserCounter(core, "parserDurationMs", performance.now() - parseStartedAt);
      }
      dbg(core, `Parsed, root node type: ${tree.rootNode.type}`);
      core.treeCache.set(filePath, content, languageId, tree);
    }
  } catch (err) {
    core.client.reportWasmAbort(err);
    dbg(core, `Parse error: ${err}`);
    return NOT_PARSED;
  }
  try {
    return { parsed: true, value: consume(tree) };
  } catch (error) {
    core.client.reportWasmAbort(error);
    throw error;
  }
}

export function extractInjections(
  core: TreeSitterClientInternals,
  filePath: string,
  content: string,
): Array<{
  type: "sql" | "css" | "html" | "gql" | "regex";
  content: string;
  line: number;
  column: number;
}> {
  const injections: Array<{
    type: "sql" | "css" | "html" | "gql" | "regex";
    content: string;
    line: number;
    column: number;
  }> = [];

  const sqlPattern = /\b(sql|query|execute)\s*`([^`]+)`/gi;
  let match: RegExpExecArray | null;
  while ((match = sqlPattern.exec(content)) !== null) {
    const lines = content.slice(0, match.index).split("\n");
    injections.push({
      type: "sql",
      content: match[2],
      line: lines.length,
      column: lines[lines.length - 1].length,
    });
  }

  const cssPattern = /\b(styled(?:\.\w+)?|css)\s*`([^`]+)`/gi;
  while ((match = cssPattern.exec(content)) !== null) {
    const lines = content.slice(0, match.index).split("\n");
    injections.push({
      type: "css",
      content: match[2],
      line: lines.length,
      column: lines[lines.length - 1].length,
    });
  }

  const regexPattern = /new\s+RegExp\s*\(\s*`([^`]+)`/gi;
  while ((match = regexPattern.exec(content)) !== null) {
    const lines = content.slice(0, match.index).split("\n");
    injections.push({
      type: "regex",
      content: match[1],
      line: lines.length,
      column: lines[lines.length - 1].length,
    });
  }

  dbg(core, `Found ${injections.length} injections in ${filePath}`);
  return injections;
}

export function isAvailable(core: TreeSitterClientInternals): boolean {
  if (core.wasmAborted) return false;
  if (resolveGrammarFile(core, "tree-sitter-typescript.wasm")) return true;
  const dir = findGrammarsDir();
  core.grammarsDir = dir;
  return !!dir && fs.existsSync(dir);
}

export async function isLanguageSupported(
  core: TreeSitterClientInternals,
  languageId: string,
): Promise<boolean> {
  if (core.wasmAborted) return false;
  if (!core.initialized) await core.client.init();
  const language = await loadLanguage(core, languageId);
  return language !== null;
}

export function getLanguage(
  core: TreeSitterClientInternals,
  languageId: string,
): TreeSitterLanguage | null {
  if (core.wasmAborted) return null;
  return core.languages.get(languageId) || null;
}
