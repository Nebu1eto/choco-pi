import type { FactRule } from "../fact-provider-types.ts";
import type { Diagnostic } from "../types.ts";
import type { FunctionSummary } from "../facts/function-facts.ts";
import type { TryCatchSummary } from "../facts/try-catch-facts.ts";

export const missingErrorPropagationRule: FactRule = {
  id: "missing-error-propagation",
  requires: ["file.functionSummaries", "file.tryCatchSummaries"],
  appliesTo(ctx) {
    return /\.tsx?$/.test(ctx.filePath);
  },
  evaluate(ctx, store) {
    const fns = store.getFileFact<FunctionSummary[]>(ctx.filePath, "file.functionSummaries") ?? [];
    const catches =
      store.getFileFact<TryCatchSummary[]>(ctx.filePath, "file.tryCatchSummaries") ?? [];

    const diagnostics: Diagnostic[] = [];

    const asyncFns = fns.filter((f) => f.isAsync && !f.isPassThroughWrapper);

    for (const f of asyncFns) {
      const nextFnLine = fns
        .filter((g) => g.line > f.line)
        .reduce((min, g) => Math.min(min, g.line), Infinity);

      const relevantCatches = catches.filter((c) => c.line >= f.line && c.line < nextFnLine);

      for (const c of relevantCatches) {
        if (c.isEmpty || c.hasRethrow) continue;
        if (!c.hasLogging) continue;
        if (c.catchReturnsDefault) continue;
        if (c.catchReturnsStructuredError) continue;
        if (c.isDocumentedLocalFallback) continue;
        if (c.isFilesystemExistenceProbe) continue;
        if (/\b(serverFailed|failed|error)\s*=/.test(c.bodyText)) continue;

        diagnostics.push({
          id: `missing-error-propagation:${ctx.filePath}:${c.line}`,
          tool: "fact-rules",
          rule: "missing-error-propagation",
          filePath: ctx.filePath,
          line: c.line,
          column: c.column,
          severity: "warning",
          semantic: "warning",
          message: `Catch block in async '${f.name}' logs the error but doesn't rethrow — callers receive undefined and assume success`,
        });
      }
    }

    return diagnostics;
  },
};
