import type { FactRule } from "../fact-provider-types.ts";
import type { Diagnostic } from "../types.ts";
import type { FunctionSummary } from "../facts/function-facts.ts";
import { isTestFrameworkNoiseCall, isTestSuiteOrganizer } from "./framework-call-noise.ts";

export const DEFAULT_HIGH_FAN_OUT_THRESHOLD = 20;
let fanOutThreshold = DEFAULT_HIGH_FAN_OUT_THRESHOLD;

export function setHighFanOutThreshold(n: number): void {
  if (Number.isFinite(n) && n > 0) fanOutThreshold = n;
}

export function resetHighFanOutThreshold(): void {
  fanOutThreshold = DEFAULT_HIGH_FAN_OUT_THRESHOLD;
}

export const highFanOutRule: FactRule = {
  id: "high-fan-out",
  requires: ["file.functionSummaries"],
  appliesTo(ctx) {
    return /\.tsx?$/.test(ctx.filePath);
  },
  evaluate(ctx, store) {
    const fns = store.getFileFact<FunctionSummary[]>(ctx.filePath, "file.functionSummaries") ?? [];

    const diagnostics: Diagnostic[] = [];
    const configuredFanOutThreshold = ctx.projectConfig?.rules["high-fan-out"]?.threshold;
    const activeFanOutThreshold = configuredFanOutThreshold ?? fanOutThreshold;

    for (const f of fns) {
      if (isTestSuiteOrganizer(f.outgoingCalls)) continue;

      const meaningful = f.outgoingCalls.filter((c) => {
        const lower = c.toLowerCase();
        return (
          !lower.startsWith("console.") &&
          !lower.startsWith("math.") &&
          !lower.startsWith("json.") &&
          !lower.startsWith("object.") &&
          !lower.startsWith("array.") &&
          !lower.startsWith("string(") &&
          !lower.startsWith("number(") &&
          !lower.startsWith("boolean(") &&
          !lower.startsWith("error(") &&
          c !== "resolve" &&
          c !== "reject" &&
          c !== "next" &&
          c !== "done" &&
          !isTestFrameworkNoiseCall(c)
        );
      });

      if (meaningful.length < activeFanOutThreshold) continue;

      diagnostics.push({
        id: `high-fan-out:${ctx.filePath}:${f.line}`,
        tool: "fact-rules",
        rule: "high-fan-out",
        filePath: ctx.filePath,
        line: f.line,
        column: f.column,
        severity: "warning",
        semantic: "warning",
        message: `'${f.name}' calls ${meaningful.length} distinct functions — coordination smell, consider splitting responsibilities`,
      });
    }

    return diagnostics;
  },
};
