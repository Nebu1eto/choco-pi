import type { FactRule } from "../fact-provider-types.ts";
import type { Diagnostic } from "../types.ts";
import type { FunctionSummary } from "../facts/function-facts.ts";
import type { TryCatchSummary } from "../facts/try-catch-facts.ts";

const IO_NAMESPACE_PREFIXES = [
  "db.",
  "prisma.",
  "knex.",
  "mongoose.",
  "sequelize.",
  "http.",
  "https.",
  "net.",
  "dns.",
  "redis.",
  "mongo.",
  "pg.",
  "mysql.",
  "s3.",
  "storage.",
  "bucket.",
  "fs.promises.",
];

const IO_EXACT_CALLEES = new Set([
  "fetch",
  "axios",
  "got",
  "request",
  "spawn",
  "exec",
  "execSync",
  "spawnSync",
  "readFile",
  "writeFile",
  "appendFile",
  "readdir",
  "mkdir",
  "unlink",
  "stat",
]);

const CC_THRESHOLD = 6;

function callsToBoundary(outgoingCalls: string[]): string | undefined {
  for (const callee of outgoingCalls) {
    const lower = callee.toLowerCase();
    if (IO_EXACT_CALLEES.has(lower)) return callee;
    if (IO_NAMESPACE_PREFIXES.some((p) => lower.startsWith(p))) return callee;
  }
  return undefined;
}

function hasCatchCoverage(fn: FunctionSummary, catches: TryCatchSummary[]): boolean {
  if (fn.outgoingCalls.some((c) => c === "resolve" || c === "reject")) return true;

  return catches.some((c) => {
    if (c.line < fn.line) return false;
    if (c.isEmpty) return false;
    if (c.hasRethrow || c.hasLogging || c.catchParam === null) return true;
    if (/\breturn\b/.test(c.bodyText)) return true;
    if (c.catchHasFallbackAssignment) return true;
    return false;
  });
}

export const unsafeBoundaryRule: FactRule = {
  id: "unsafe-boundary",
  requires: ["file.functionSummaries", "file.tryCatchSummaries"],
  appliesTo(ctx) {
    return /\.tsx?$/.test(ctx.filePath);
  },
  evaluate(ctx, store) {
    const fns = store.getFileFact<FunctionSummary[]>(ctx.filePath, "file.functionSummaries") ?? [];
    const catches =
      store.getFileFact<TryCatchSummary[]>(ctx.filePath, "file.tryCatchSummaries") ?? [];

    const diagnostics: Diagnostic[] = [];

    for (const f of fns) {
      if (!f.isAsync) continue;
      if (f.isPassThroughWrapper) continue;
      if (f.cyclomaticComplexity < CC_THRESHOLD) continue;

      const boundaryCalle = callsToBoundary(f.outgoingCalls);
      if (!boundaryCalle) continue;

      if (hasCatchCoverage(f, catches)) continue;

      diagnostics.push({
        id: `unsafe-boundary:${ctx.filePath}:${f.line}`,
        tool: "fact-rules",
        rule: "unsafe-boundary",
        filePath: ctx.filePath,
        line: f.line,
        column: f.column,
        severity: "warning",
        semantic: "warning",
        message: `'${f.name}' is async, calls '${boundaryCalle}', has complexity ${f.cyclomaticComplexity}, but no try/catch — unhandled rejection risk`,
      });
    }

    return diagnostics;
  },
};
