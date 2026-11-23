import { type LspBoundaryValue, type LspDictionaryValue } from "./runtime-guards.ts";
import { compile, oneOf, type Static } from "@earendil-works/pi-schema";
import { logTreeSitterDiagnostic } from "./tree-sitter-logger.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePackagePath } from "./package-root.ts";

const InlineTierSchema = oneOf(["blocking", "warning", "review"]);
const ConfidenceSchema = oneOf(["low", "medium", "high"]);
const isInlineTier = compile(InlineTierSchema).check;
const isConfidence = compile(ConfidenceSchema).check;

function parseInlineTier(value: LspBoundaryValue): Static<typeof InlineTierSchema> | undefined {
  if (!value) return undefined;
  const candidate = String(value);
  return isInlineTier(candidate) ? candidate : undefined;
}

function parseConfidence(value: LspBoundaryValue): Static<typeof ConfidenceSchema> | undefined {
  if (!value) return undefined;
  const candidate = String(value);
  return isConfidence(candidate) ? candidate : undefined;
}

interface ParseYamlResultContract extends Record<string, string | string[] | boolean> {}

export function isDisabledQueryDirectoryName(name: string): boolean {
  return name.endsWith("-disabled");
}

export function getQueryLanguageKey(directoryName: string): string {
  return isDisabledQueryDirectoryName(directoryName)
    ? directoryName.slice(0, -"-disabled".length)
    : directoryName;
}

const TYPESCRIPT_RULE_HEIRS = new Set(["tsx"]);

export function ruleSourceLanguages(languageId: string): string[] {
  return TYPESCRIPT_RULE_HEIRS.has(languageId) ? [languageId, "typescript"] : [languageId];
}

export function ruleFilesForLanguage(languageId: string, rootDir = process.cwd()): string[] {
  const resolvedRoot = path.resolve(rootDir);
  const files = new Set<string>();
  for (const lang of ruleSourceLanguages(languageId)) {
    for (const dir of [
      path.join(resolvedRoot, "rules", "tree-sitter-queries", lang),
      resolvePackagePath(import.meta.url, "rules", "tree-sitter-queries", lang),
    ]) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".yml")) files.add(path.join(dir, f));
      }
    }
  }
  return [...files];
}

export function queriesForLanguage(
  queries: Map<string, TreeSitterQuery[]>,
  languageId: string,
): TreeSitterQuery[] {
  const enabled = (langId: string): TreeSitterQuery[] =>
    (queries.get(langId) ?? []).filter((q) => !isDisabledQueryFilePath(q.filePath));
  return ruleSourceLanguages(languageId).flatMap((langId) => enabled(langId));
}

function stripInlineComment(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) return value;
  return value.replace(/\s+#.*$/, "").trim();
}

export function isDisabledQueryFilePath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  const parent = parts.length >= 2 ? parts[parts.length - 2] : "";
  return isDisabledQueryDirectoryName(parent);
}

export interface TreeSitterQuery {
  id: string;
  name: string;
  severity: "error" | "warning" | "info";
  category: string;
  language: string;
  message: string;
  description?: string;
  query: string;
  metavars: string[];
  post_filter?: string;

  post_filter_params?: Record<string, LspDictionaryValue>;
  predicates?: Array<{
    type: "eq" | "match" | "any-of";
    var: string;
    value: string | string[];
  }>;
  tags?: string[];
  cwe?: string[];
  owasp?: string[];
  confidence?: "low" | "medium" | "high";
  defect_class?: string;
  inline_tier?: "blocking" | "warning" | "review";
  skip_test_files?: boolean;
  ignore_paths?: string[];
  has_fix: boolean;
  fix_action?: string;
  examples?: {
    bad?: string;
    good?: string;
  };
  filePath: string;
}

export class TreeSitterQueryLoader {
  private queries: Map<string, TreeSitterQuery[]> = new Map();
  private loaded = false;
  private loadedRoot: string | null = null;
  private verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  private dbg(msg: string): void {
    if (this.verbose) {
      logTreeSitterDiagnostic({
        subsystem: "query-loader",
        level: "debug",
        message: msg,
      });
    }
  }

  async loadQueries(
    rootDir = process.cwd(),
    options: { force?: boolean } = {},
  ): Promise<Map<string, TreeSitterQuery[]>> {
    const resolvedRoot = path.resolve(rootDir);
    if (!options.force && this.loaded && this.loadedRoot === resolvedRoot) {
      return this.queries;
    }

    this.queries.clear();
    this.loaded = false;

    const queryDirs = [
      ...new Set([
        path.join(resolvedRoot, "rules", "tree-sitter-queries"),
        resolvePackagePath(import.meta.url, "rules", "tree-sitter-queries"),
      ]),
    ];

    for (const queriesDir of queryDirs) {
      if (!fs.existsSync(queriesDir)) {
        this.dbg(`Queries directory not found: ${queriesDir}`);
        continue;
      }

      const languageDirs = fs
        .readdirSync(queriesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const lang of languageDirs) {
        const langDir = path.join(queriesDir, lang);
        const languageKey = getQueryLanguageKey(lang);
        const queryFiles = fs.readdirSync(langDir).filter((f) => f.endsWith(".yml"));

        const langQueries = this.queries.get(languageKey) ?? [];

        for (const file of queryFiles) {
          const filePath = path.join(langDir, file);
          const query = this.parseQueryFile(filePath, languageKey);
          if (query) {
            langQueries.push(query);
          }
        }

        if (langQueries.length > 0) {
          this.queries.set(languageKey, langQueries);
          this.dbg(`Loaded ${langQueries.length} queries for ${languageKey}`);
        }
      }
    }

    this.loaded = true;
    this.loadedRoot = resolvedRoot;
    return this.queries;
  }

  private parseQueryFile(filePath: string, language: string): TreeSitterQuery | null {
    try {
      const content = fs.readFileSync(filePath, "utf-8");

      const parsed = this.parseYaml(content);

      if (!parsed.id || !parsed.query) {
        this.dbg(`Invalid query file: ${filePath}`);
        return null;
      }

      return {
        id: String(parsed.id),
        name: String(parsed.name || parsed.id),
        severity: this.parseSeverity(parsed.severity),
        category: String(parsed.category || "general"),
        language: String(parsed.language || language),
        message: String(parsed.message || `Pattern: ${parsed.id}`),
        description: parsed.description ? String(parsed.description) : undefined,
        query: this.extractMultilineValue(content, "query") || String(parsed.query),
        metavars: Array.isArray(parsed.metavars)
          ? parsed.metavars.map(String)
          : this.extractMetavars(String(parsed.query)),
        post_filter: parsed.post_filter ? String(parsed.post_filter) : undefined,

        // SAFETY: The tree-sitter adapter supplies this node/query representation, and the adjacent capture or node guard establishes the member used here.
        post_filter_params: parsed.post_filter_params as any,
        defect_class: parsed.defect_class ? String(parsed.defect_class) : undefined,
        inline_tier: parseInlineTier(parsed.inline_tier),
        skip_test_files: parsed.skip_test_files === true,
        ignore_paths: Array.isArray(parsed.ignore_paths)
          ? parsed.ignore_paths.map(String)
          : undefined,
        predicates: Array.isArray(parsed.predicates)
          ? parsed.predicates.map((p: any) => ({
              type: p.type,
              var: p.var,
              value: p.value,
            }))
          : undefined,
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : undefined,
        cwe: Array.isArray(parsed.cwe) ? parsed.cwe.map(String) : undefined,
        owasp: Array.isArray(parsed.owasp) ? parsed.owasp.map(String) : undefined,
        confidence: parseConfidence(parsed.confidence),
        has_fix: parsed.has_fix === true || parsed.has_fix === "true",
        fix_action: parsed.fix_action ? String(parsed.fix_action) : undefined,
        filePath,
      };
    } catch (err) {
      this.dbg(`Failed to parse ${filePath}: ${err}`);
      return null;
    }
  }

  private parseYaml(content: string): ParseYamlResultContract {
    const result: Record<string, string | string[] | boolean> = {};
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^([a-z_]+):\s*(.*)$/);
      if (match) {
        const key = match[1];
        let value: string | string[] | boolean = stripInlineComment(match[2].trim());

        if (value.startsWith("[") && value.endsWith("]")) {
          value = value
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim().replace(/^["']|["']$/g, ""));
        } else if (value === "") {
          const arrayItems: string[] = [];
          const nestedObj: Record<string, string> = {};
          const baseIndent = line.match(/^(\s*)/)?.[0].length || 0;

          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j];
            const nextIndent = nextLine.match(/^(\s*)/)?.[0].length || 0;

            if (nextIndent <= baseIndent && nextLine.trim() !== "" && nextLine.match(/^\S/)) {
              break;
            }

            const itemMatch = nextLine.match(/^\s+-\s*(.+)$/);
            if (itemMatch) {
              const item = itemMatch[1].trim().replace(/\s*#.*$/, "");
              if (item) arrayItems.push(item);
              continue;
            }

            const nestedMatch = nextLine.match(/^\s+(\w+):\s*(.+)$/);
            if (nestedMatch) {
              let nv = nestedMatch[2].trim();
              if (
                (nv.startsWith('"') && nv.endsWith('"')) ||
                (nv.startsWith("'") && nv.endsWith("'"))
              ) {
                nv = nv.slice(1, -1);
              }
              nestedObj[nestedMatch[1]] = nv;
            }
          }

          if (arrayItems.length > 0) {
            value = arrayItems;
          } else if (Object.keys(nestedObj).length > 0) {
            // SAFETY: The source key list is checked against the named owner type, so the constructed keys and values exhaust that representation.
            (result as any)[key] = nestedObj;
            continue;
          }
        } else if (value === "true") value = true;
        else if (value === "false") value = false;
        else if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }

        result[key] = value;
      }
    }

    return result;
  }

  private extractMultilineValue(content: string, key: string): string | null {
    const lines = content.split("\n");
    let startLine = -1;
    let startIndent = 0;

    const keyPrefix = `${key}:`;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (trimmed.startsWith(keyPrefix)) {
        startLine = i;
        startIndent = lines[i].length - trimmed.length;
        const afterKey = trimmed.slice(keyPrefix.length).trim();
        if (afterKey && afterKey !== "|") return afterKey;
        break;
      }
    }

    if (startLine === -1) return null;

    const valueLines: string[] = [];
    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];

      if (!line.trim()) {
        valueLines.push("");
        continue;
      }

      const indentMatch = line.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1].length : 0;
      const trimmed = line.trim();

      if (indent <= startIndent && trimmed.match(/^[a-z_]+:/)) {
        break;
      }

      if (trimmed.startsWith("#") && indent <= startIndent) {
        break;
      }

      if (trimmed.startsWith("#") && key !== "query") continue;

      valueLines.push(line);
    }

    const nonEmpty = valueLines.filter((l: string) => l.trim().length > 0);
    if (nonEmpty.length > 0) {
      const minExtraIndent = Math.min(
        ...nonEmpty.map((l: string) => {
          const m = l.match(/^(\s*)/);
          return (m?.[1].length ?? 0) - startIndent;
        }),
      );
      for (let i = 0; i < valueLines.length; i++) {
        if (valueLines[i].trim().length === 0) continue;
        valueLines[i] = valueLines[i].slice(startIndent + Math.max(0, minExtraIndent));
      }
    }

    while (valueLines.length > 0 && !valueLines[valueLines.length - 1].trim()) {
      valueLines.pop();
    }

    return valueLines.length > 0 ? valueLines.join("\n") : null;
  }

  private parseSeverity(value: LspBoundaryValue): "error" | "warning" | "info" {
    if (value === "error") return "error";
    if (value === "warning") return "warning";
    if (value === "info") return "info";
    return "warning";
  }

  private extractMetavars(query: string): string[] {
    const matches = query.match(/@([A-Z_][A-Z0-9_]*)/g);
    if (!matches) return [];
    return [...new Set(matches.map((m) => m.slice(1)))];
  }

  getQueriesForLanguage(language: string): TreeSitterQuery[] {
    const all = this.queries.get(language) || [];
    return all.filter((q) => !isDisabledQueryFilePath(q.filePath));
  }

  getQueryById(id: string): TreeSitterQuery | undefined {
    for (const langQueries of this.queries.values()) {
      const query = langQueries.find((q) => q.id === id);
      if (query) return query;
    }
    return undefined;
  }

  findMatchingQuery(pattern: string, language: string): TreeSitterQuery | undefined {
    const langQueries = this.getQueriesForLanguage(language);

    for (const query of langQueries) {
      if (pattern.includes(query.id)) return query;

      switch (query.id) {
        case "empty-catch":
          if (pattern.includes("empty-catch") || pattern.includes("catch {}")) return query;
          break;
        case "debugger-statement":
          if (pattern.includes("debugger")) return query;
          break;
        case "await-in-loop":
          if (pattern.includes("await-in-loop") || pattern.includes("await")) return query;
          break;
        case "hardcoded-secrets":
          if (
            pattern.includes("hardcoded") ||
            pattern.includes("api_key") ||
            pattern.includes("password")
          )
            return query;
          break;
        case "dangerously-set-inner-html":
          if (pattern.includes("dangerously") || pattern.includes("innerHTML")) return query;
          break;
        case "nested-ternary":
          if (pattern.includes("ternary") || pattern.includes("? :")) return query;
          break;
        case "no-eval":
          if (pattern.includes("eval") && !pattern.includes("console")) return query;
          break;
        case "deep-promise-chain":
          if (pattern.includes(".then") && pattern.includes(".catch")) return query;
          break;
        case "console-statement":
          if (pattern.includes("console") && !pattern.includes("test")) return query;
          break;
        case "long-parameter-list":
          if (pattern.includes("PARAMS")) return query;
          break;
        case "bare-except":
          if (pattern.includes("bare-except") || pattern.includes("except:")) return query;
          break;
        case "mutable-default-arg":
          if (pattern.includes("mutable") || pattern.includes("default")) return query;
          break;
        case "wildcard-import":
          if (pattern.includes("wildcard") || pattern.includes("import *")) return query;
          break;
        case "eval-exec":
          if (pattern.includes("eval") || pattern.includes("exec")) return query;
          break;
        case "is-vs-equals":
          if (pattern.includes("is") || pattern.includes("equals")) return query;
          break;
        case "unreachable-except":
          if (pattern.includes("unreachable") || pattern.includes("except")) return query;
          break;
      }
    }

    return undefined;
  }

  getAllQueries(): TreeSitterQuery[] {
    const all: TreeSitterQuery[] = [];
    for (const queries of this.queries.values()) {
      all.push(...queries);
    }
    return all;
  }

  async reload(): Promise<void> {
    this.queries.clear();
    this.loaded = false;
    await this.loadQueries();
  }
}

export const queryLoader = new TreeSitterQueryLoader();
