import * as fs from "node:fs";
import * as path from "node:path";

export interface ProjectRule {
  source: string;
  name: string;
  filePath: string;
  relativePath: string;
}

export interface RuleScanResult {
  rules: ProjectRule[];
  hasCustomRules: boolean;
}

const RULE_DIRS = [
  { dir: ".claude/rules", source: ".claude/rules" },
  { dir: ".agents/rules", source: ".agents/rules" },
];

const RULE_FILES = [
  { file: "CLAUDE.md", source: "root" },
  { file: "AGENTS.md", source: "root" },
  { file: ".cursorrules", source: "root" },
];

const PROMPT_RULES_MAX_TOTAL = 12;
const PROMPT_RULES_MAX_PER_SOURCE = 4;
const PROMPT_RULES_MAX_CHARS = 900;

const RULES_SCAN_MAX_DEPTH = 8;
const RULES_SCAN_MAX_FILES = 500;

function findMarkdownFiles(
  dir: string,
  baseDir: string,
  depth = 0,
  collected: { count: number } = { count: 0 },
): ProjectRule[] {
  const results: ProjectRule[] = [];

  if (depth > RULES_SCAN_MAX_DEPTH) return results;
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (collected.count >= RULES_SCAN_MAX_FILES) break;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMarkdownFiles(fullPath, baseDir, depth + 1, collected));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      collected.count += 1;
      results.push({
        source: path.relative(baseDir, dir) || path.basename(baseDir),
        name: entry.name,
        filePath: fullPath,
        relativePath: path.relative(baseDir, fullPath).replace(/\\/g, "/"),
      });
    }
  }
  return results;
}

export function scanProjectRules(cwd: string): RuleScanResult {
  const rules: ProjectRule[] = [];

  for (const { dir, source } of RULE_DIRS) {
    const dirPath = path.join(cwd, dir);
    if (fs.existsSync(dirPath)) {
      const found = findMarkdownFiles(dirPath, path.join(cwd, dir));
      for (const rule of found) {
        rules.push({
          source,
          name: rule.name,
          filePath: rule.filePath,
          relativePath: `${dir}/${rule.relativePath}`,
        });
      }
    }
  }

  for (const { file, source } of RULE_FILES) {
    const filePath = path.join(cwd, file);
    if (fs.existsSync(filePath)) {
      rules.push({
        source,
        name: file,
        filePath,
        relativePath: file,
      });
    }
  }

  return {
    rules,
    hasCustomRules: rules.length > 0,
  };
}

export function formatRulesForPrompt(result: RuleScanResult): string {
  if (!result.hasCustomRules) return "";

  const bySource = new Map<string, ProjectRule[]>();
  for (const rule of result.rules) {
    const existing = bySource.get(rule.source) ?? [];
    existing.push(rule);
    bySource.set(rule.source, existing);
  }

  const sections: string[] = [];
  let emittedTotal = 0;

  const sortedSources = [...bySource.keys()].sort((a, b) => a.localeCompare(b));
  for (const source of sortedSources) {
    if (emittedTotal >= PROMPT_RULES_MAX_TOTAL) break;
    const rules = bySource.get(source) ?? [];
    const sortedRules = [...rules].sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    const remainingBudget = PROMPT_RULES_MAX_TOTAL - emittedTotal;
    const shown = sortedRules.slice(0, Math.min(PROMPT_RULES_MAX_PER_SOURCE, remainingBudget));
    emittedTotal += shown.length;

    const list = shown.map((r) => `- \`${r.relativePath}\``);
    if (sortedRules.length > shown.length) {
      list.push(`- ... and ${sortedRules.length - shown.length} more in ${source}`);
    }
    sections.push(`From ${source}/:\n${list.join("\n")}`);
  }

  const hidden = result.rules.length - emittedTotal;
  if (hidden > 0) {
    sections.push(`... and ${hidden} additional rule file(s) not listed.`);
  }

  const full = sections.join("\n\n");
  if (full.length <= PROMPT_RULES_MAX_CHARS) return full;
  return `${full.slice(0, PROMPT_RULES_MAX_CHARS)}\n... (truncated)`;
}
