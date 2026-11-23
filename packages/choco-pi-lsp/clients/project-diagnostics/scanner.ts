import * as fs from "node:fs";
import * as path from "node:path";
import { createDispatchContext } from "../dispatch/dispatcher.ts";
import { evaluateRules } from "../dispatch/fact-rule-runner.ts";
import { runProviders } from "../dispatch/fact-runner.ts";
import { FactStore } from "../dispatch/fact-store.ts";
import {
  canHandle as astGrepCanHandle,
  getLang as astGrepGetLang,
  evaluateAstGrepRules,
  loadSg,
} from "../dispatch/runners/ast-grep-napi.ts";
import type { Diagnostic } from "../dispatch/types.ts";
import { isTestFile } from "../file-utils.ts";
import { isAtOrAboveHomeDir } from "../path-utils.ts";
import { getProjectDiagnosticsScannerMaxFiles } from "../project-scale.ts";
import { captureReviewGraphStructuralIr } from "../review-graph/builder.ts";
import {
  publishReviewGraphFileIr,
  reviewGraphIrContentHash,
} from "../review-graph/shared-extraction-ir.ts";
import {
  collectSourceFilesWithBudgetAsync,
  type SourceCollectionResult,
} from "../source-filter.ts";
import { logTreeSitter, logTreeSitterCacheStats } from "../tree-sitter-logger.ts";
import { queriesForLanguage, queryLoader } from "../tree-sitter-query-loader.ts";
import {
  EXT_TO_LANG,
  getSharedTreeSitterClient,
  isTreeSitterWasmAborted,
} from "../tree-sitter-shared.ts";
import { PROJECT_DIAGNOSTICS_CACHE_VERSION, saveProjectDiagnosticsSnapshot } from "./cache.ts";
import type {
  ProjectDiagnostic,
  ProjectDiagnosticsScanOptions,
  ProjectDiagnosticsSnapshot,
} from "./types.ts";
import "../dispatch/integration.ts";

const AST_GREP_MAX_FILE_BYTES = 1024 * 1024;
const AST_GREP_SCAN_MAX_MATCHES_PER_RULE = 25;
const AST_GREP_SCAN_MAX_DIAGNOSTICS_PER_FILE = 100;
const FACT_RULE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
interface TreeSitterLanguageByExtension {
  [extension: string]: string;
}

export const TREE_SITTER_EXT_TO_LANG: TreeSitterLanguageByExtension = {
  ...EXT_TO_LANG,
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
};

function normalizeSeverity(severity: string | undefined): ProjectDiagnostic["severity"] {
  if (severity === "error" || severity === "warning" || severity === "hint") {
    return severity;
  }
  return severity === "info" ? "info" : "warning";
}

function normalizeSemantic(diagnostic: Diagnostic): ProjectDiagnostic["semantic"] {
  if (diagnostic.semantic === "blocking") return "blocking";
  if (diagnostic.semantic === "warning") return "warning";
  return "none";
}

function fromDispatchDiagnostic(diagnostic: Diagnostic, runner: string): ProjectDiagnostic {
  return {
    filePath: path.resolve(diagnostic.filePath),
    line: diagnostic.line,
    column: diagnostic.column,
    severity: normalizeSeverity(diagnostic.severity),
    semantic: normalizeSemantic(diagnostic),
    tool: diagnostic.tool,
    runner,
    rule: diagnostic.rule,
    code: diagnostic.code,
    message: diagnostic.message,
    source: "project-scan",
  };
}

interface FileMajorScan {
  treeSitter: ProjectDiagnostic[];
  factRules: ProjectDiagnostic[];
  astGrep: ProjectDiagnostic[];
  filesScanned: number;
  wasmAborted: boolean;
}

async function scanFileMajorRules(
  cwd: string,
  files: string[],
  signal?: AbortSignal,
): Promise<FileMajorScan> {
  const client = getSharedTreeSitterClient();
  client?.ensureTreeCacheCapacity(files.length);
  const treeSitterReady = !!client && client.isAvailable() && (await client.init());
  const queryMap = treeSitterReady ? await queryLoader.loadQueries(cwd) : undefined;

  const facts = new FactStore();
  const pi = { getFlag: () => undefined };
  const treeSitter: ProjectDiagnostic[] = [];
  const factRules: ProjectDiagnostic[] = [];
  const astGrep: ProjectDiagnostic[] = [];
  const sgModule = await loadSg();
  let phaseOneFilesScanned = 0;
  let astGrepFilesScanned = 0;
  let astGrepDurationMs = 0;
  let filesScanned = 0;
  let wasmAborted = isTreeSitterWasmAborted();

  const scanTreeSitterFile = async (
    filePath: string,
    langId: string | undefined,
    content: string | null,
  ): Promise<void> => {
    if (!queryMap || !langId || !client || content === null) return;
    const queries = queriesForLanguage(queryMap, langId);
    try {
      const found = await client.runQueriesOnFile(
        queries,
        filePath,
        langId,
        { maxResults: 50 },
        content,
      );
      for (const { queryDef: query, match } of found) {
        treeSitter.push({
          filePath,
          line: match.line ?? 1,
          column: match.column,
          severity: query.severity === "error" ? "error" : query.severity,
          semantic:
            query.inline_tier === "blocking" || query.severity === "error" ? "blocking" : "warning",
          tool: "tree-sitter",
          runner: "tree-sitter",
          rule: query.id,
          message: query.message,
          source: "project-scan",
        });
      }
    } catch {}
  };

  const scanFactRulesFile = async (filePath: string, content: string | null): Promise<void> => {
    facts.clearFileFactsFor(filePath);
    facts.setFileFact(filePath, "file.content", content);
    const ctx = createDispatchContext(filePath, cwd, pi, facts, false);
    try {
      await runProviders(ctx);
      for (const diagnostic of evaluateRules(ctx)) {
        factRules.push(fromDispatchDiagnostic(diagnostic, "fact-rules"));
      }
    } catch {}
  };

  const scanAstGrepFile = (
    filePath: string,
    content: string,
    lang: NonNullable<ReturnType<typeof astGrepGetLang>>,
  ): void => {
    const startedAt = Date.now();
    try {
      const rootNode = lang.parse(content).root();
      const fileDiagnostics = evaluateAstGrepRules(filePath, rootNode, cwd, "jsts", {
        maxMatchesPerRule: AST_GREP_SCAN_MAX_MATCHES_PER_RULE,
        maxTotalDiagnostics: AST_GREP_SCAN_MAX_DIAGNOSTICS_PER_FILE,
      });
      for (const diagnostic of fileDiagnostics) {
        astGrep.push(fromDispatchDiagnostic(diagnostic, "ast-grep-napi"));
      }
    } catch {
    } finally {
      astGrepFilesScanned++;
      astGrepDurationMs += Date.now() - startedAt;
    }
  };

  const scan = async (): Promise<void> => {
    for (const filePath of files) {
      if (signal?.aborted || isTreeSitterWasmAborted()) {
        wasmAborted ||= isTreeSitterWasmAborted();
        break;
      }
      if (isTestFile(filePath)) continue;
      const ext = path.extname(filePath);
      const langId = TREE_SITTER_EXT_TO_LANG[ext];
      const factEligible = FACT_RULE_EXTENSIONS.has(ext);
      let astGrepLang: ReturnType<typeof astGrepGetLang> | undefined;
      if (sgModule && astGrepCanHandle(filePath)) {
        try {
          if (fs.statSync(filePath).size <= AST_GREP_MAX_FILE_BYTES) {
            astGrepLang = astGrepGetLang(filePath, sgModule);
          }
        } catch {}
      }
      if (!langId && !factEligible && !astGrepLang) continue;
      if (langId || factEligible) phaseOneFilesScanned++;

      let content: string | null;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        content = null;
      }

      try {
        await scanTreeSitterFile(filePath, langId, content);
        if (isTreeSitterWasmAborted()) {
          wasmAborted = true;
          break;
        }

        if (factEligible) {
          await scanFactRulesFile(filePath, content);
          if (isTreeSitterWasmAborted()) {
            wasmAborted = true;
            break;
          }
        }

        let graphIr: Awaited<ReturnType<typeof captureReviewGraphStructuralIr>> | undefined;
        if (content !== null) {
          try {
            graphIr = await captureReviewGraphStructuralIr(filePath, cwd, content, facts);
          } catch {
            graphIr = { complete: false };
          }
          if (isTreeSitterWasmAborted()) {
            wasmAborted = true;
            break;
          }
        }

        if (signal?.aborted) {
          astGrep.length = 0;
          break;
        }
        if (astGrepLang && content !== null) {
          scanAstGrepFile(filePath, content, astGrepLang);
        }
        if (signal?.aborted) break;
        if (content !== null && graphIr?.complete && graphIr.structural) {
          publishReviewGraphFileIr(cwd, {
            filePath,
            contentHash: reviewGraphIrContentHash(content),
            ...graphIr,
          });
        }
        filesScanned++;
      } finally {
        facts.clearFileFactsFor(filePath);
      }
    }
    if (wasmAborted) {
      astGrep.length = 0;
    }
  };

  if (!client) {
    await scan();
    return { treeSitter, factRules, astGrep, filesScanned, wasmAborted };
  }

  const startedAt = Date.now();
  await client.withParseCacheMeasurement(scan, (stats) => {
    logTreeSitterCacheStats({
      scope: "project_diagnostics_scan",
      filePath: cwd,
      fileCount: phaseOneFilesScanned,
      durationMs: Date.now() - startedAt - astGrepDurationMs,
      stats,
    });
  });
  await client.withParseCacheMeasurement(
    async () => {},
    (stats) => {
      logTreeSitterCacheStats({
        scope: "project_diagnostics_ast_grep_scan",
        filePath: cwd,
        fileCount: astGrepFilesScanned,
        durationMs: astGrepDurationMs,
        stats,
      });
    },
  );
  return { treeSitter, factRules, astGrep, filesScanned, wasmAborted };
}

export async function scanProjectDiagnostics(
  options: ProjectDiagnosticsScanOptions,
): Promise<ProjectDiagnosticsSnapshot> {
  const cwd = path.resolve(options.cwd);
  const { signal } = options;
  if (!options.files && isAtOrAboveHomeDir(cwd, options.homeDir)) {
    return {
      version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
      cwd,
      tier: options.tier,
      scannedAt: new Date().toISOString(),
      diagnostics: [],
      filesScanned: 0,
      runners: [],
      unsafeRoot: true,
    };
  }
  const maxFiles = Math.max(1, options.maxFiles ?? getProjectDiagnosticsScannerMaxFiles(cwd));
  const collected: SourceCollectionResult = options.files
    ? { files: options.files.slice(0, maxFiles), entryBudgetExceeded: false }
    : await collectSourceFilesWithBudgetAsync(cwd, {
        maxFiles,
        maxScanEntries: options.maxScanEntries,
        includeGenerated: options.includeGenerated === true,
      });
  const files = collected.files;
  const runners: string[] = [];
  const diagnostics: ProjectDiagnostic[] = [];
  let wasmAborted = false;
  let filesScanned = files.length;
  if (!signal?.aborted) {
    const scanned = await scanFileMajorRules(cwd, files, signal);
    diagnostics.push(...scanned.treeSitter, ...scanned.factRules);
    runners.push("tree-sitter", "fact-rules");
    wasmAborted = scanned.wasmAborted;
    if (wasmAborted) filesScanned = scanned.filesScanned;
    if (!signal?.aborted && !wasmAborted) {
      diagnostics.push(...scanned.astGrep);
      runners.push("ast-grep-napi");
    }
  }
  const snapshot: ProjectDiagnosticsSnapshot = {
    version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
    cwd,
    tier: options.tier,
    scannedAt: new Date().toISOString(),
    diagnostics,
    filesScanned,
    runners,
  };
  if (collected.entryBudgetExceeded) snapshot.scanTruncated = true;
  if (collected.generatedOrArtifactSkips) {
    snapshot.generatedFileSkips = collected.generatedOrArtifactSkips;
  }
  if (collected.generatedNameOnlySkips) {
    snapshot.generatedNameOnlySkips = collected.generatedNameOnlySkips;
  }
  if (collected.generatedDirSkips) {
    snapshot.generatedDirSkips = collected.generatedDirSkips;
  }
  if (wasmAborted) {
    snapshot.scanTruncated = true;
    snapshot.treeSitterStatus = "wasm_aborted_restart_required";
    logTreeSitter({
      phase: "runner_skip",
      filePath: cwd,
      status: "aborted",
      reason: "wasm_aborted_mid_scan",
      metadata: {
        scope: "project_diagnostics_scan",
        filesScanned,
        totalFiles: files.length,
        abortPoint: filesScanned + 1,
      },
    });
  }
  if (signal?.aborted || options.files || wasmAborted) return snapshot;
  saveProjectDiagnosticsSnapshot(cwd, snapshot);
  return snapshot;
}
