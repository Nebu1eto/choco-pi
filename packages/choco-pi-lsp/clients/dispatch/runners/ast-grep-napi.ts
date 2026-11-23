import * as fs from "node:fs";
import * as path from "node:path";
import { obj, opt, str, unknown, compile } from "@earendil-works/pi-schema";
import {
  type AstGrepNapi,
  loadAstGrepNapi,
  type NapiConfig,
  type SgRoot,
} from "../../deps/ast-grep-napi.ts";
import { minimatch } from "../../deps/minimatch.ts";
import { type AstGrepRuleSource, getAstGrepRuleSources } from "../../sgconfig.ts";
import { logLatency } from "../../latency-logger.ts";
import { hasEslintConfig } from "../../tool-policy.ts";
import { enabledAuxiliaryLspServerIds } from "../auxiliary-lsp.ts";
import { classifyDefect } from "../diagnostic-taxonomy.ts";
import { recordDegradationOnce } from "../../degradation-ledger.ts";
import { isAuxiliaryLspAlive } from "../../lsp/index.ts";
import { resolveAstGrepNativeExe } from "../../lsp/wait-policy/index.ts";
import { PRIORITY } from "../priorities.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import {
  calculateRuleComplexity,
  isOverlyBroadPattern,
  isStructuredRule,
  loadYamlRules,
  loadYamlRulesFresh,
  MAX_BLOCKING_RULE_COMPLEXITY,
  type YamlRule,
  type YamlRuleCondition,
} from "./yaml-rule-parser.ts";

interface RawNativeConfig {
  rule: YamlRuleCondition;
  constraints?: YamlRule["constraints"];
  utils?: YamlRule["utils"];
}

const defaultUnsupportedLanguageLog = new Set<string>();
const UNSUPPORTED_RULE_ID_SAMPLE_SIZE = 5;

export function resetAstGrepUnsupportedLanguageLog(): void {
  defaultUnsupportedLanguageLog.clear();
}

let sg: AstGrepNapi | undefined;
let sgLoadPromise: Promise<AstGrepNapi | undefined> | undefined;
let sgSessionHold = false;
let sgHoldReason: "transient" | "genuine" | undefined;

const TRANSIENT_ERRNO_ALLOWLIST = new Set(["EMFILE", "EBUSY", "EAGAIN", "EPERM", "ETXTBSY"]);

const KNOWN_GENUINE_NATIVE_LOAD_MESSAGES = [
  /cannot find native binding/i,
  /failed to load native binding/i,
];

interface ErrorChain {
  codes: string[];
  messages: string[];
}

const ErrorCauseSchema = obj(
  {
    code: opt(str()),
    cause: opt(unknown()),
  },
  { open: true },
);
const isErrorCause = compile(ErrorCauseSchema).check;

function collectErrorChain<T>(err: T): ErrorChain {
  const codes: string[] = [];
  const messages: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      const candidate: unknown = current;
      if (isErrorCause(candidate)) {
        if (candidate.code !== undefined) codes.push(candidate.code);
        current = candidate.cause;
      } else {
        break;
      }
    } else {
      messages.push(String(current));
      break;
    }
  }
  return { codes, messages };
}

function classifyAstGrepLoadFailure<T>(err: T): "transient" | "genuine" {
  const { codes, messages } = collectErrorChain(err);
  const hasKnownGenuineMessage = messages.some((message) =>
    KNOWN_GENUINE_NATIVE_LOAD_MESSAGES.some((pattern) => pattern.test(message)),
  );
  if (hasKnownGenuineMessage) return "genuine";
  const hasTransientErrno = codes.some((code) => TRANSIENT_ERRNO_ALLOWLIST.has(code));
  return hasTransientErrno ? "transient" : "genuine";
}

function recordAstGrepUnavailableOnce(reason: "transient" | "genuine"): void {
  recordDegradationOnce({
    kind: "ast-grep-napi-unavailable",
    subject: "ast-grep-napi",
    reason:
      reason === "genuine"
        ? "native addon failed to load (durable for this session)"
        : "native addon load hit a transient error (durable for this session — see sgSessionHold doc)",
  });
}

export async function loadSg(): Promise<AstGrepNapi | undefined> {
  if (sg) return sg;
  if (sgLoadPromise) return sgLoadPromise;
  if (sgSessionHold) {
    recordAstGrepUnavailableOnce(sgHoldReason ?? "genuine");
    return undefined;
  }

  const task = (async (): Promise<AstGrepNapi | undefined> => {
    try {
      const loaded = await loadAstGrepNapi();
      sg = loaded;
      return loaded;
    } catch (err) {
      const reason = classifyAstGrepLoadFailure(err);
      sgSessionHold = true;
      sgHoldReason = reason;
      recordAstGrepUnavailableOnce(reason);
      return undefined;
    }
  })();
  sgLoadPromise = task;
  task.finally(() => {
    if (sgLoadPromise === task) sgLoadPromise = undefined;
  });
  return task;
}

export function resetAstGrepNapiLoadState(): void {
  sgSessionHold = false;
  sgHoldReason = undefined;
}

const SUPPORTED_EXTS = [".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".htm"];

const MAX_MATCHES_PER_RULE = 10;

const MAX_TOTAL_DIAGNOSTICS = 50;

const LINTER_OVERLAP = new Set([
  "getter-return",
  "no-array-constructor",
  "no-async-promise-executor",
  "no-await-in-loop",
  "no-case-declarations",
  "no-compare-neg-zero",
  "no-cond-assign",
  "no-constant-condition",
  "no-constructor-return",
  "no-dupe-args",
  "no-dupe-keys",
  "no-extra-boolean-cast",
  "no-new-symbol",
  "no-new-wrappers",
  "no-prototype-builtins",
]);

const NON_SUPPRESSIBLE = new Set(["empty-catch", "no-discarded-error", "unchecked-throwing-call"]);

function defaultFixSuggestion(defectClass: string, ruleId: string): string {
  if (defectClass === "silent-error") {
    return "Handle the error path explicitly: log context and rethrow or return a typed error result.";
  }
  if (defectClass === "secrets") {
    return "Remove hardcoded secret material and load values from env/secret manager.";
  }
  if (defectClass === "injection") {
    return "Avoid dynamic execution/interpolation here; use parameterized APIs or strict allowlists.";
  }
  if (defectClass === "async-misuse") {
    return "Make async flow explicit: await consistently and handle rejection/error paths.";
  }
  if (ruleId.includes("unsafe") || ruleId.includes("security")) {
    return "Refactor to a safer API usage with explicit validation and bounded behavior.";
  }
  return "Refactor this pattern to the safer equivalent used in the codebase.";
}

function explicitRuleFixSuggestion(rule: YamlRule): string | undefined {
  const raw = (rule.fix ?? rule.note ?? "").trim();
  if (!raw) return undefined;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
}

function normalizeRuleId(ruleId: string): string {
  return ruleId.replace(/-js$/, "");
}

function relativeForIgnoreGlob(filePath: string, root: string): string {
  const rel = path.relative(root, filePath);
  return (rel.startsWith("..") ? filePath : rel).split(path.sep).join("/");
}

function matchesRuleIgnores(
  filePath: string,
  root: string,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false;
  const rel = relativeForIgnoreGlob(filePath, root);
  return patterns.some((pattern) => minimatch(rel, pattern, { dot: true }));
}

export function canHandle(filePath: string): boolean {
  return SUPPORTED_EXTS.includes(path.extname(filePath).toLowerCase());
}

export function ruleLanguageForFile(
  filePath: string,
): "typescript" | "tsx" | "javascript" | undefined {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".jsx":
      return "javascript";
    default:
      return undefined;
  }
}

export function getLang(filePath: string, sgModule: AstGrepNapi) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
      return sgModule.ts;
    case ".tsx":
      return sgModule.tsx;
    case ".js":
    case ".jsx":
      return sgModule.js;
    case ".css":
      return sgModule.css;
    case ".html":
    case ".htm":
      return sgModule.html;
    default:
      return undefined;
  }
}

export interface AstGrepEvaluateOptions {
  blockingOnly?: boolean;
  maxMatchesPerRule?: number;
  maxTotalDiagnostics?: number;
  projectRoot?: string;
  log?: (message: string) => void;
  unsupportedLanguageLog?: Set<string>;
}

function duplicateRuleIds(rules: YamlRule[]): string[] {
  const counts = new Map<string, number>();
  for (const rule of rules) {
    counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
  }
  return Array.from(counts)
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));
}

function appendDuplicateRuleDiagnostics(
  diagnostics: Diagnostic[],
  seenRuleIds: Set<string>,
  duplicateIds: string[],
  source: AstGrepRuleSource,
  filePath: string,
  maxTotalDiagnostics: number,
): boolean {
  const sourceLabel = `${source.origin} ${source.tier} rules`;
  for (const ruleId of duplicateIds) {
    diagnostics.push({
      id: `ast-grep-napi-config-duplicate-${source.origin}-${source.tier}-${ruleId}`,
      message: `Duplicate ast-grep rule id "${ruleId}" in ${sourceLabel}`,
      filePath,
      line: 1,
      column: 1,
      severity: "error",
      semantic: "blocking",
      tool: "ast-grep-napi",
      rule: ruleId,
      defectClass: "correctness",
      fixable: false,
      autoFixAvailable: false,
      fixSuggestion: `Give every rule in ${sourceLabel} a unique id`,
    });
    seenRuleIds.add(ruleId);
    if (diagnostics.length >= maxTotalDiagnostics) return true;
  }
  return false;
}

export function normalizeRuleSeverity(raw: string | undefined): Diagnostic["severity"] {
  switch (raw) {
    case "error":
    case "warning":
    case "info":
    case "hint":
      return raw;
    default:
      return "warning";
  }
}

export function evaluateAstGrepRules(
  filePath: string,
  rootNode: ReturnType<SgRoot["root"]>,
  cwd: string,
  kind: string | undefined,
  options: AstGrepEvaluateOptions = {},
): Diagnostic[] {
  const maxMatchesPerRule = options.maxMatchesPerRule ?? MAX_MATCHES_PER_RULE;
  const maxTotalDiagnostics = options.maxTotalDiagnostics ?? MAX_TOTAL_DIAGNOSTICS;
  const blockingOnly = options.blockingOnly === true;
  const log = options.log;
  const unsupportedLanguageLog = options.unsupportedLanguageLog ?? defaultUnsupportedLanguageLog;

  const diagnostics: Diagnostic[] = [];
  const seenRuleIds = new Set<string>();
  const suppressLinterOverlap = kind === "jsts" && hasEslintConfig(cwd);
  const fileLang = ruleLanguageForFile(filePath);
  const newlyUnsupported = new Map<string, string[]>();
  const flushUnsupportedRuleSkips = (): void => {
    if (newlyUnsupported.size === 0) return;
    const firstSeenLanguages = Array.from(newlyUnsupported.entries()).filter(
      ([language]) => !unsupportedLanguageLog.has(language),
    );
    for (const [language] of firstSeenLanguages) {
      unsupportedLanguageLog.add(language);
    }
    if (firstSeenLanguages.length === 0) {
      newlyUnsupported.clear();
      return;
    }
    for (const [language] of firstSeenLanguages) unsupportedLanguageLog.add(language);
    logLatency({
      type: "phase",
      phase: "astgrep_napi_unsupported_rules_skipped",
      filePath,
      durationMs: 0,
      metadata: {
        skippedByLanguage: Object.fromEntries(
          firstSeenLanguages.map(([language, ruleIds]) => [
            language,
            {
              count: ruleIds.length,
              ruleIds: ruleIds.slice(0, UNSUPPORTED_RULE_ID_SAMPLE_SIZE),
            },
          ]),
        ),
      },
    });
    newlyUnsupported.clear();
  };

  const ignoreRoot = options.projectRoot ?? cwd;
  const ruleSources = getAstGrepRuleSources(ignoreRoot);

  for (const source of ruleSources) {
    let rules: YamlRule[];
    try {
      const loader = source.origin === "project" ? loadYamlRulesFresh : loadYamlRules;
      rules = loader(source.dir);
    } catch {
      continue;
    }

    const duplicates = duplicateRuleIds(rules);
    if (
      appendDuplicateRuleDiagnostics(
        diagnostics,
        seenRuleIds,
        duplicates,
        source,
        filePath,
        maxTotalDiagnostics,
      )
    ) {
      flushUnsupportedRuleSkips();
      return diagnostics;
    }
    const duplicateSet = new Set(duplicates);

    for (const rule of rules) {
      if (duplicateSet.has(rule.id)) continue;
      if (seenRuleIds.has(rule.id)) continue;
      seenRuleIds.add(rule.id);
      if (blockingOnly && rule.severity !== "error") continue;
      if (matchesRuleIgnores(filePath, ignoreRoot, rule.ignores)) continue;

      if (
        suppressLinterOverlap &&
        LINTER_OVERLAP.has(normalizeRuleId(rule.id)) &&
        !NON_SUPPRESSIBLE.has(normalizeRuleId(rule.id))
      ) {
        continue;
      }

      if (rule.rule && isOverlyBroadPattern(rule.rule.pattern) && !isStructuredRule(rule)) {
        continue;
      }

      const lang = rule.language?.toLowerCase();
      if (lang && lang !== "typescript" && lang !== "tsx" && lang !== "javascript") {
        if (!unsupportedLanguageLog.has(lang)) {
          const ids = newlyUnsupported.get(lang) ?? [];
          ids.push(rule.id);
          newlyUnsupported.set(lang, ids);
        }
        continue;
      }
      if (lang && fileLang && lang !== fileLang) {
        const runsAsTsOnTsx = fileLang === "tsx" && lang === "typescript";
        if (!runsAsTsOnTsx) {
          const key = `mismatch:${lang}->${fileLang}`;
          if (!unsupportedLanguageLog.has(key)) {
            const ids = newlyUnsupported.get(key) ?? [];
            ids.push(rule.id);
            newlyUnsupported.set(key, ids);
          }
          continue;
        }
      }

      if (blockingOnly && rule.rule) {
        const complexity = calculateRuleComplexity(rule.rule);
        if (complexity > MAX_BLOCKING_RULE_COMPLEXITY) {
          continue;
        }
      }

      if (!rule.rule) continue;

      try {
        let matches: ReturnType<typeof rootNode.findAll> = [];

        const rawNativeConfig: RawNativeConfig = { rule: rule.rule };
        if (rule.constraints) rawNativeConfig.constraints = rule.constraints;
        if (rule.utils) rawNativeConfig.utils = rule.utils;
        // SAFETY: findAll validates the complete native grammar and rejection is handled below.
        const nativeConfig = rawNativeConfig as NapiConfig;
        try {
          matches = rootNode.findAll(nativeConfig);
        } catch (err) {
          matches = [];
          log?.(
            `ast-grep-napi: rule "${rule.id}" rejected by native engine (${
              err instanceof Error ? err.message : String(err)
            })`,
          );
        }

        const limitedMatches = matches.slice(0, maxMatchesPerRule);

        for (const match of limitedMatches) {
          if (diagnostics.length >= maxTotalDiagnostics) break;

          const range = match.range();
          const severity = normalizeRuleSeverity(rule.severity);
          const semantic = severity === "error" ? "blocking" : "warning";
          const defectClass = classifyDefect(rule.id, "ast-grep-napi", rule.message || rule.id);
          const ruleFix = explicitRuleFixSuggestion(rule);

          diagnostics.push({
            id: `ast-grep-napi-${range.start.line}-${rule.id}`,
            message: `[${rule.metadata?.category || "slop"}] ${rule.message || rule.id}`,
            filePath,
            line: range.start.line + 1,
            column: range.start.column + 1,
            severity,
            semantic,
            tool: "ast-grep-napi",
            rule: rule.id,
            defectClass,
            fixable: !!ruleFix,
            autoFixAvailable: false,
            fixKind: ruleFix ? "suggestion" : undefined,
            fixSuggestion:
              semantic === "blocking"
                ? (ruleFix ?? defaultFixSuggestion(defectClass, rule.id))
                : ruleFix,
          });
        }

        if (diagnostics.length >= maxTotalDiagnostics) break;
      } catch {}
    }
  }

  flushUnsupportedRuleSkips();
  return diagnostics;
}

const astGrepNapiRunner: RunnerDefinition = {
  id: "ast-grep-napi",
  appliesTo: ["jsts"],
  priority: PRIORITY.SPECIALIZED_ANALYSIS,
  enabledByDefault: true,
  skipTestFiles: true,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    if (!canHandle(ctx.filePath)) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const astGrepLspEnabled = enabledAuxiliaryLspServerIds((f) => ctx.pi?.getFlag?.(f)).includes(
      "ast-grep",
    );
    const astGrepLspAlive = astGrepLspEnabled
      ? await isAuxiliaryLspAlive("ast-grep", ctx.filePath)
      : false;
    let astGrepBinaryResolvable = false;
    if (astGrepLspEnabled && !astGrepLspAlive) {
      astGrepBinaryResolvable =
        Boolean(resolveAstGrepNativeExe()) || (await ctx.hasTool("ast-grep"));
    }
    if (astGrepLspEnabled && (astGrepLspAlive || astGrepBinaryResolvable)) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const sgModule = await loadSg();
    if (!sgModule) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    if (!fs.existsSync(ctx.filePath)) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const lang = getLang(ctx.filePath, sgModule);
    if (!lang) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    let stats: import("fs").Stats;
    try {
      stats = fs.statSync(ctx.filePath);
    } catch {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }
    if (stats.size > 1024 * 1024) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    let content: string;
    const contentFromFacts = ctx.facts.getFileFact<string | null>(ctx.filePath, "file.content");
    if (contentFromFacts !== undefined && contentFromFacts !== null) {
      content = contentFromFacts;
    } else {
      try {
        content = fs.readFileSync(ctx.filePath, "utf-8");
      } catch {
        return { status: "skipped", diagnostics: [], semantic: "none" };
      }
    }

    let root: SgRoot;
    try {
      root = lang.parse(content);
    } catch {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    let rootNode: ReturnType<SgRoot["root"]>;
    try {
      rootNode = root.root();
    } catch {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const diagnostics = evaluateAstGrepRules(ctx.filePath, rootNode, ctx.cwd, ctx.kind, {
      blockingOnly: ctx.blockingOnly,
      projectRoot: ctx.projectRoot,
      log: (message: string) => ctx.log(message),
    });

    const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
    let semantic: "blocking" | "warning" | "none" = "none";
    if (hasBlocking) {
      semantic = "blocking";
    } else if (diagnostics.length > 0) {
      semantic = "warning";
    }
    return {
      status: hasBlocking ? "failed" : "succeeded",
      diagnostics,
      semantic,
    };
  },
};

export default astGrepNapiRunner;
