import type { FactRule } from "../fact-provider-types.ts";
import type { Diagnostic } from "../types.ts";
import type { FunctionSummary } from "../facts/function-facts.ts";
import { isTestSuiteOrganizer } from "./framework-call-noise.ts";

export const DEFAULT_HIGH_COMPLEXITY_THRESHOLD = 15;
export const DEFAULT_HIGH_COMPLEXITY_DEPTH_THRESHOLD = 6;
let ccThreshold = DEFAULT_HIGH_COMPLEXITY_THRESHOLD;
let depthThreshold = DEFAULT_HIGH_COMPLEXITY_DEPTH_THRESHOLD;

function isPositiveFiniteThreshold(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function setHighComplexityThresholds(cc: number, depth: number): void {
  if (isPositiveFiniteThreshold(cc)) ccThreshold = cc;
  if (isPositiveFiniteThreshold(depth)) depthThreshold = depth;
}

export function resetHighComplexityThresholds(): void {
  ccThreshold = DEFAULT_HIGH_COMPLEXITY_THRESHOLD;
  depthThreshold = DEFAULT_HIGH_COMPLEXITY_DEPTH_THRESHOLD;
}

export const highComplexityRule: FactRule = {
  id: "high-complexity",
  requires: ["file.functionSummaries"],
  appliesTo(ctx) {
    return /\.tsx?$/.test(ctx.filePath);
  },
  evaluate(ctx, store) {
    const fns = store.getFileFact<FunctionSummary[]>(ctx.filePath, "file.functionSummaries") ?? [];

    const diagnostics: Diagnostic[] = [];
    const configuredCcThreshold = ctx.projectConfig?.rules["high-complexity"]?.threshold;
    const activeCcThreshold = configuredCcThreshold ?? ccThreshold;

    for (const f of fns) {
      if (isTestSuiteOrganizer(f.outgoingCalls)) continue;

      const ccBreached = f.cyclomaticComplexity >= activeCcThreshold;
      const depthBreached = f.maxNestingDepth >= depthThreshold;
      if (!ccBreached && !depthBreached) continue;

      const parts: string[] = [];
      if (ccBreached) parts.push(`cyclomatic complexity ${f.cyclomaticComplexity}`);
      if (depthBreached) parts.push(`nesting depth ${f.maxNestingDepth}`);

      diagnostics.push({
        id: `high-complexity:${ctx.filePath}:${f.line}`,
        tool: "fact-rules",
        rule: "high-complexity",
        filePath: ctx.filePath,
        line: f.line,
        column: f.column,
        severity: "warning",
        semantic: "warning",
        message: `'${f.name}' has ${parts.join(" and ")} — consider breaking it up`,
      });
    }

    return diagnostics;
  },
};
