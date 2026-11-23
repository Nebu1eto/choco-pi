import { normalizeRuleId } from "./rule-id-normalize.ts";

export interface SuppressibleDiagnostic {
  line?: number;
  rule?: string;
  id?: string;
}

const SUPPRESS_RE = /(?:\/\/|#)\s*choco-pi-lsp-ignore:\s*(.+)/;

export function applyInlineSuppressions<T extends SuppressibleDiagnostic>(
  diagnostics: T[],
  content: string,
): T[] {
  if (!content || !diagnostics.length) return diagnostics;

  const suppressed = new Set<string>();
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = SUPPRESS_RE.exec(lines[i]);
    if (!m) continue;
    const rules = m[1]
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    const suppressedLine = i + 1;
    const nextLine = i + 2;
    for (const ruleId of rules) {
      for (const key of new Set([ruleId, normalizeRuleId(ruleId)])) {
        suppressed.add(`${suppressedLine}:${key}`);
        suppressed.add(`${nextLine}:${key}`);
      }
    }
  }

  if (suppressed.size === 0) return diagnostics;

  return diagnostics.filter((d) => {
    const rawId = d.rule ?? d.id ?? "";
    const line = d.line ?? 1;
    if (suppressed.has(`${line}:${rawId}`)) return false;
    const normId = normalizeRuleId(rawId);
    return normId === rawId || !suppressed.has(`${line}:${normId}`);
  });
}
