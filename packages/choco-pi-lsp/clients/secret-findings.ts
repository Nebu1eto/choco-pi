import { isFiniteNumber } from "./runtime-guards.ts";
import type { ActionableWarningRecord } from "./actionable-warnings.ts";
import { normalizeFilePath } from "./path-utils.ts";

export type SecretSource = "gitleaks" | "trivy" | "ast-grep";

export interface TrivySecretFinding {
  ruleId: string;
  file: string;
  line: number;
  title?: string;
}

export interface SecretFinding {
  file: string;
  line: number;
  sources: SecretSource[];
  rule: string;
  description?: string;
}

const SECRET_RULE_PATTERN = /hardcoded|secret|password|credential/i;

export function isSecretWarning(warning: ActionableWarningRecord): boolean {
  const id = `${warning.rule ?? ""} ${warning.code ?? ""}`;
  return SECRET_RULE_PATTERN.test(id);
}

export function secretLocationKey(file: string, line: number): string {
  return `${normalizeFilePath(file)}:${line}`;
}

export function fromAstGrepWarnings(warnings: ActionableWarningRecord[]): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const w of warnings) {
    if (!isSecretWarning(w) || !isFiniteNumber(w.line)) continue;
    out.push({
      file: w.filePath,
      line: w.line,
      sources: ["ast-grep"],
      rule: w.rule ?? w.code ?? "hardcoded-secret",
      description: w.message,
    });
  }
  return out;
}

interface SOURCEPRIORITYValues extends Record<SecretSource, number> {}
const SOURCE_PRIORITY: SOURCEPRIORITYValues = {
  gitleaks: 0,
  trivy: 1,
  "ast-grep": 2,
};

function sortSources(sources: SecretSource[]): SecretSource[] {
  return [...new Set(sources)].sort((a, b) => SOURCE_PRIORITY[a] - SOURCE_PRIORITY[b]);
}

export function dedupeSecretFindings(findings: SecretFinding[]): SecretFinding[] {
  const byKey = new Map<string, SecretFinding>();
  for (const f of findings) {
    const key = secretLocationKey(f.file, f.line);
    const incoming = sortSources(f.sources);
    const existed = byKey.get(key);
    if (!existed) {
      byKey.set(key, { ...f, sources: incoming });
      continue;
    }
    const existingTop = SOURCE_PRIORITY[existed.sources[0]];
    existed.sources = sortSources([...existed.sources, ...incoming]);
    if (SOURCE_PRIORITY[incoming[0]] < existingTop) {
      existed.rule = f.rule;
    }
    existed.description ??= f.description;
  }
  return [...byKey.values()];
}
