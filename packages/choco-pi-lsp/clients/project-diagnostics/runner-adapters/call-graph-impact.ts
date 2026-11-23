import * as path from "node:path";
import { parseSymbolKey, type ImpactResult, type SymbolKey } from "../../call-graph.ts";
import { isTestRoleCollateral } from "../../collateral-test-role.ts";
import type { ProjectDiagnostic } from "../types.ts";

export interface CallGraphImpactFinding {
  calleeKey: SymbolKey;
  results: ImpactResult[];
}

function resolveImpactFile(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function displayName(key: SymbolKey): string {
  return parseSymbolKey(key).symbolName ?? key;
}

function severityFor(
  severity: ImpactResult["severity"],
): { severity: ProjectDiagnostic["severity"]; message: string } | null {
  if (severity === "WillBreak") {
    return {
      severity: "warning",
      message:
        "Direct caller of a symbol edited this turn — verify this call site still matches its new signature/behavior.",
    };
  }
  if (severity === "MayBreak") {
    return {
      severity: "info",
      message: "Indirect caller (one hop) of a symbol edited this turn — worth a quick check.",
    };
  }
  return null;
}

interface SeverityRank {
  error: number;
  warning: number;
  info: number;
  hint: number;
}

const SEVERITY_RANK: SeverityRank = {
  error: 3,
  warning: 2,
  info: 1,
  hint: 0,
};

export function callGraphImpactToProjectDiagnostics(
  cwd: string,
  findings: CallGraphImpactFinding[],
): ProjectDiagnostic[] {
  const byKey = new Map<string, ProjectDiagnostic>();

  for (const { calleeKey, results } of findings) {
    const calleeName = displayName(calleeKey);
    for (const result of results) {
      const mapped = severityFor(result.severity);
      if (!mapped) continue;

      const { filePath } = parseSymbolKey(result.symbolKey);
      if (!filePath) continue;
      const resolvedFile = resolveImpactFile(cwd, filePath);

      if (isTestRoleCollateral(resolvedFile)) continue;

      const dedupeKey = `${resolvedFile}:${result.symbolKey}`;
      const existing = byKey.get(dedupeKey);
      if (existing && SEVERITY_RANK[existing.severity] >= SEVERITY_RANK[mapped.severity]) {
        continue;
      }

      const callerName = displayName(result.symbolKey);
      byKey.set(dedupeKey, {
        filePath: resolvedFile,
        severity: mapped.severity,
        semantic: "warning",
        tool: "call-graph",
        runner: "call-graph",
        rule: `call-graph:${result.severity.toLowerCase()}`,
        message: `${mapped.message} (${callerName} calls edited symbol '${calleeName}')`,
        source: "project-scan",
      });
    }
  }

  return [...byKey.values()];
}
