import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { arr, bool, obj, opt, str, union, unknown, compile } from "@earendil-works/pi-schema";
import { finiteNum } from "../../lsp/schema-guards.ts";
import { isRuntimeString } from "../../../tools/runtime-values.ts";
import yaml from "../../deps/js-yaml.ts";
import { BoundedLruCache } from "../../bounded-cache.ts";

export interface YamlRuleCondition {
  kind?: string;
  pattern?: string | YamlRichPattern;
  regex?: string;
  has?: YamlRuleCondition;
  any?: YamlRuleCondition[];
  all?: YamlRuleCondition[];
  not?: YamlRuleCondition;
  inside?: YamlRuleCondition;
  follows?: YamlRuleCondition;
  precedes?: YamlRuleCondition;
  stopBy?: unknown;
  field?: string;
  nthChild?: unknown;
}

export interface YamlRule {
  id: string;
  language?: string;
  severity?: string;
  message?: string;
  note?: string;
  fix?: string;
  metadata?: { weight?: number; category?: string };
  rule?: YamlRuleCondition;
  constraints?: Record<string, { regex?: string }>;
  utils?: Record<string, YamlRuleCondition>;
  ignores?: string[];
}

interface CachedRules {
  rules: YamlRule[];
  mtime: number;
}

interface ContentCachedRules {
  rules: YamlRule[];
  signature: string;
}

export interface YamlRichPattern {
  context?: string;
  selector?: string;
  strictness?: string;
}

export const OVERLY_BROAD_PATTERNS = ["$NAME", "$FIELD", "$_", "$X", "$VAR", "$EXPR"];

export const MAX_BLOCKING_RULE_COMPLEXITY = 8;

const rulesCache = new BoundedLruCache<string, CachedRules>(64);
const blockingRulesCache = new BoundedLruCache<string, CachedRules>(64);
const contentRulesCache = new BoundedLruCache<string, ContentCachedRules>(64);
const contentBlockingRulesCache = new BoundedLruCache<string, ContentCachedRules>(64);

export function clearRulesCache(): void {
  rulesCache.clear();
  blockingRulesCache.clear();
  contentRulesCache.clear();
  contentBlockingRulesCache.clear();
}

export function loadYamlRules(ruleDir: string, severityFilter?: "error"): YamlRule[] {
  return getCachedRules(ruleDir, severityFilter);
}

function findYamlRuleFiles(ruleDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs
      .readdirSync(ruleDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(ruleDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findYamlRuleFiles(full));
    } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function loadYamlRuleFiles(files: string[], severityFilter?: "error"): YamlRule[] {
  const rules: YamlRule[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const documents = content.split(/^---\s*$/m).filter((doc) => doc.trim());
    for (const document of documents) {
      const rule = parseSimpleYaml(document.trim());
      if (!rule?.id) continue;
      if (severityFilter && rule.severity !== severityFilter) continue;
      rules.push(rule);
    }
  }
  return rules;
}

export function loadYamlRulesUncached(ruleDir: string, severityFilter?: "error"): YamlRule[] {
  return loadYamlRuleFiles(findYamlRuleFiles(ruleDir), severityFilter);
}

export function loadYamlRulesFresh(ruleDir: string, severityFilter?: "error"): YamlRule[] {
  const files = findYamlRuleFiles(ruleDir);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(ruleDir, file));
    hash.update("\0");
    try {
      hash.update(fs.readFileSync(file));
    } catch {
      hash.update("missing");
    }
    hash.update("\0");
  }
  const signature = hash.digest("hex");
  const cache = severityFilter === "error" ? contentBlockingRulesCache : contentRulesCache;
  const cached = cache.get(ruleDir);
  if (cached?.signature === signature) return cached.rules;
  const rules = loadYamlRuleFiles(files, severityFilter);
  cache.set(ruleDir, { rules, signature });
  return rules;
}

export function getCachedRules(ruleDir: string, severityFilter?: "error"): YamlRule[] {
  if (!fs.existsSync(ruleDir)) {
    return [];
  }

  let currentMtime = 0;
  try {
    currentMtime = fs.statSync(ruleDir).mtimeMs;
  } catch {
    return [];
  }

  const cache = severityFilter === "error" ? blockingRulesCache : rulesCache;
  const cached = cache.get(ruleDir);
  if (cached && cached.mtime === currentMtime) {
    return cached.rules;
  }

  const rules = loadYamlRulesUncached(ruleDir, severityFilter);
  cache.set(ruleDir, { rules, mtime: currentMtime });
  return rules;
}

const YamlRichPatternSchema = obj(
  {
    context: str(),
    selector: opt(str()),
  },
  { open: true },
);
const isYamlRichPattern = compile(YamlRichPatternSchema).check;
const YamlRuleConditionSchema = obj(
  {
    kind: opt(str()),
    pattern: opt(union([str(), YamlRichPatternSchema])),
    regex: opt(str()),
    has: opt(obj({}, { open: true })),
    any: opt(arr(obj({}, { open: true }))),
    all: opt(arr(obj({}, { open: true }))),
    not: opt(obj({}, { open: true })),
    inside: opt(obj({}, { open: true })),
    follows: opt(obj({}, { open: true })),
    precedes: opt(obj({}, { open: true })),
    stopBy: opt(unknown()),
    field: opt(str()),
    nthChild: opt(unknown()),
  },
  { open: true },
);
const YamlRuleSchema = obj(
  {
    id: str(),
    language: opt(str()),
    severity: opt(str()),
    message: opt(str()),
    note: opt(str()),
    fix: opt(str()),
    metadata: opt(
      obj(
        {
          weight: opt(finiteNum()),
          category: opt(str()),
        },
        { open: true },
      ),
    ),
    rule: opt(YamlRuleConditionSchema),
    constraints: opt(obj({}, { open: true })),
    utils: opt(obj({}, { open: true })),
    skip_test_files: opt(bool()),
    ignore_paths: opt(arr(str())),
  },
  { open: true },
);
const isYamlRule = compile(YamlRuleSchema).check;

export function isOverlyBroadPattern(pattern: string | YamlRichPattern | undefined): boolean {
  if (!pattern) return false;
  if (!isRuntimeString(pattern)) return false;
  if (OVERLY_BROAD_PATTERNS.includes(pattern.trim())) return true;
  return /^\$[A-Z_]+$/i.test(pattern.trim());
}

export function isValidCondition(condition: YamlRuleCondition | undefined): boolean {
  if (!condition) return false;
  if (condition.all !== undefined && condition.all.length === 0) return false;
  if (condition.any !== undefined && condition.any.length === 0) return false;
  if (isOverlyBroadPattern(condition.pattern)) return false;
  return true;
}

export function isStructuredRule(rule: YamlRule): boolean {
  if (!rule.rule) return false;
  const hasRichPattern = isYamlRichPattern(rule.rule.pattern);
  return !!(
    hasRichPattern ||
    rule.rule.has ||
    rule.rule.any ||
    rule.rule.all ||
    rule.rule.not ||
    rule.rule.regex
  );
}

export function calculateRuleComplexity(condition: YamlRuleCondition | undefined): number {
  if (!condition) return 0;

  let score = 0;
  if (condition.has) score += 3;
  if (condition.not) score += 2;
  if (condition.regex) score += 2;
  if (condition.any) score += condition.any.length * 2;
  if (condition.all) score += condition.all.length * 3;

  if (condition.has) score += calculateRuleComplexity(condition.has);
  if (condition.not) score += calculateRuleComplexity(condition.not);
  if (condition.any) {
    for (const sub of condition.any) score += calculateRuleComplexity(sub);
  }
  if (condition.all) {
    for (const sub of condition.all) score += calculateRuleComplexity(sub);
  }

  return score;
}

export function parseSimpleYaml(content: string): YamlRule | null {
  let parsed;
  try {
    parsed = yaml.load(content);
  } catch {
    return null;
  }
  if (!isYamlRule(parsed)) return null;
  return parsed;
}
