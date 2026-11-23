import * as path from "node:path";
import * as fs from "node:fs";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import { PRIORITY } from "../priorities.ts";
import { createCwdCachedProbe } from "./utils/runner-helpers.ts";

const CREDO_PROBE_BUDGET_MS = 10_000;

const probeCredo = createCwdCachedProbe(
  (cwd) =>
    safeSpawnAsync("mix", ["credo", "--version"], {
      timeout: CREDO_PROBE_BUDGET_MS,
      cwd,
    }),
  { tool: "credo", budgetMs: CREDO_PROBE_BUDGET_MS },
);

interface CredoIssue {
  filename: string;
  line_no: number;
  column: number | null;
  message: string;
  category: string;
  check: string;
  priority: number;
}

interface CredoOutput {
  issues: CredoIssue[];
}

export function parseCredoJson(raw: string, fallbackPath: string, cwd: string): Diagnostic[] {
  try {
    const output: CredoOutput = JSON.parse(raw);
    return (output.issues ?? []).map((issue) => ({
      id: `credo:${issue.check}:${issue.line_no}`,
      message: `[${issue.check}] ${issue.message}`,
      filePath:
        issue.filename && issue.filename.trim()
          ? path.isAbsolute(issue.filename)
            ? issue.filename
            : path.resolve(cwd, issue.filename)
          : fallbackPath,
      line: issue.line_no,
      column: issue.column ?? 1,
      severity: issue.priority <= 10 ? ("error" as const) : ("warning" as const),
      semantic: issue.priority <= 10 ? ("blocking" as const) : ("warning" as const),
      tool: "credo",
      rule: issue.check,
      fixable: false,
    }));
  } catch {
    return [];
  }
}

function hasMixExs(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, "mix.exs"));
}

const credoRunner: RunnerDefinition = {
  id: "credo",
  appliesTo: ["elixir"],
  priority: PRIORITY.GENERAL_ANALYSIS,
  enabledByDefault: true,
  skipTestFiles: false,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cwd = ctx.cwd || process.cwd();

    if (!hasMixExs(cwd)) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    if (!(await probeCredo(cwd))) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const absPath = path.resolve(cwd, ctx.filePath);
    const result = await safeSpawnAsync("mix", ["credo", "--format", "json", "--strict", absPath], {
      timeout: 30000,
      cwd,
    });

    if (result.status === null || result.status > 1) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const diagnostics = parseCredoJson(result.stdout ?? "", ctx.filePath, cwd);
    if (diagnostics.length === 0) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
    return {
      status: hasBlocking ? "failed" : "succeeded",
      diagnostics,
      semantic: hasBlocking ? "blocking" : "warning",
    };
  },
};

export default credoRunner;
