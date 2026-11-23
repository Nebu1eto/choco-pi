import { arr, obj, opt, str, compile } from "@earendil-works/pi-schema";
import { finiteNum } from "../../lsp/schema-guards.ts";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { getLinterPolicyForCwd, hasSqlfluffConfig } from "../../tool-policy.ts";
import { PRIORITY } from "../priorities.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import {
  createAvailabilityChecker,
  resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.ts";

const sqlfluff = createAvailabilityChecker("sqlfluff", ".exe");

export { hasSqlfluffConfig };

const SqlfluffJsonSchema = arr(
  obj(
    {
      filepath: opt(str()),
      violations: opt(
        arr(
          obj(
            {
              code: opt(str()),
              description: opt(str()),
              line_no: opt(finiteNum()),
              line_pos: opt(finiteNum()),
            },
            { open: true },
          ),
        ),
      ),
    },
    { open: true },
  ),
);
const isSqlfluffJson = compile(SqlfluffJsonSchema).check;

const SQLFLUFF_FIXABLE_RULES = new Set<string>([
  "LT01",
  "LT02",
  "LT03",
  "LT04",
  "LT05",
  "LT06",
  "LT07",
  "LT08",
  "LT09",
  "LT10",
  "LT11",
  "LT12",
  "LT13",
  "CP01",
  "CP02",
  "CP03",
  "CP04",
  "CP05",
  "AL01",
  "AL05",
  "AL06",
  "AL07",
  "AL08",
  "AL09",
  "CV01",
  "CV02",
  "CV06",
  "CV07",
  "CV10",
  "CV11",
  "RF02",
  "RF04",
  "RF05",
  "RF06",
  "ST01",
  "ST02",
]);

function parseSqlfluffOutput(raw: string, filePath: string): Diagnostic[] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!isSqlfluffJson(parsed)) return [];

    const diagnostics: Diagnostic[] = [];
    for (const item of parsed) {
      for (const v of item.violations ?? []) {
        if (!v.description) continue;
        const code = v.code ?? "SQL";
        const fixable = SQLFLUFF_FIXABLE_RULES.has(code);
        diagnostics.push({
          id: `sqlfluff-${v.line_no ?? 1}-${v.line_pos ?? 1}-${code}`,
          message: `[${code}] ${v.description}`,
          filePath,
          line: v.line_no ?? 1,
          column: v.line_pos ?? 1,
          severity: "warning",
          semantic: "warning",
          tool: "sqlfluff",
          rule: code,
          fixable,
          fixSuggestion: fixable
            ? "Run `sqlfluff fix` to apply the deterministic auto-correction for this rule."
            : undefined,
        });
      }
    }
    return diagnostics;
  } catch {
    return [];
  }
}

export { parseSqlfluffOutput };

const sqlfluffRunner: RunnerDefinition = {
  id: "sqlfluff",
  appliesTo: ["sql"],
  priority: PRIORITY.SQL_LINT,
  enabledByDefault: true,
  skipTestFiles: false,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cwd = ctx.cwd || process.cwd();
    const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
    if (policy && !policy.preferredRunners.includes("sqlfluff")) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }
    const hasConfig = hasSqlfluffConfig(cwd);
    if (!hasConfig) {
      ctx.log("sqlfluff: no config detected, using ANSI dialect defaults");
    }

    let cmd: string | null = null;
    if (await sqlfluff.isAvailableAsync(cwd)) {
      cmd = sqlfluff.getCommand(cwd);
    } else {
      cmd = await resolveToolCommandWithInstallFallback(cwd, "sqlfluff");
    }

    if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

    const args = ["lint", "--format", "json", ctx.filePath];
    if (!hasConfig) {
      args.splice(2, 0, "--dialect", "ansi");
    }

    const result = await safeSpawnAsync(cmd, args, {
      timeout: 20000,
      cwd,
    });

    const diagnostics = parseSqlfluffOutput(result.stdout ?? "", ctx.filePath);
    if (diagnostics.length === 0) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    return {
      status: "failed",
      diagnostics,
      semantic: "warning",
    };
  },
};

export default sqlfluffRunner;
