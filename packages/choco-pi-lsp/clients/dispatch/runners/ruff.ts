import { arr, compile, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { finiteNum } from "../../lsp/schema-guards.ts";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { stripAnsi } from "../../sanitize.ts";
import { getAutofixCapability, getLinterPolicyForCwd, ruffConfigArgs } from "../../tool-policy.ts";
import { PRIORITY } from "../priorities.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import { parseRuffOutput } from "./utils/diagnostic-parsers.ts";
import { createAvailabilityChecker, resolveAvailableOrInstall } from "./utils/runner-helpers.ts";

const ruff = createAvailabilityChecker("ruff", ".exe");

const RuffJsonSchema = arr(
  obj(
    {
      code: opt(str()),
      message: opt(str()),
      filename: opt(str()),
      location: opt(
        obj(
          {
            row: opt(finiteNum()),
            column: opt(finiteNum()),
          },
          { open: true },
        ),
      ),
      severity: opt(str()),
      fix: opt(unknown()),
    },
    { open: true },
  ),
);
const isRuffJson = compile(RuffJsonSchema).check;

function parseRuffJson(raw: string, filePath: string): Diagnostic[] {
  try {
    const parsed = JSON.parse(raw);
    if (!isRuffJson(parsed)) return [];

    const autofix = getAutofixCapability("ruff");
    return parsed.map((item, index) => {
      const severity = item.severity === "error" ? "error" : "warning";
      const code = item.code || "ruff";
      const toolFixable = Boolean(item.fix);
      return {
        id: `ruff-${code}-${item.location?.row ?? index + 1}`,
        message: item.message || code,
        filePath: item.filename || filePath,
        line: item.location?.row ?? 1,
        column: item.location?.column ?? 1,
        severity,
        semantic: severity === "error" ? "blocking" : "warning",
        tool: "ruff",
        rule: code,
        fixable: toolFixable,
        autoFixAvailable: toolFixable && (autofix?.safePipelineAutofix ?? false),
        fixKind: toolFixable && autofix?.fixKind !== "none" ? autofix?.fixKind : undefined,
      };
    });
  } catch {
    return [];
  }
}

const ruffRunner: RunnerDefinition = {
  id: "ruff-lint",
  appliesTo: ["python"],
  priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
  enabledByDefault: true,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cwd = ctx.cwd || process.cwd();
    const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
    if (policy && !policy.preferredRunners.includes("ruff-lint")) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }
    const cmd = await resolveAvailableOrInstall(ruff, "ruff", cwd);
    if (!cmd) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const configArgs = ruffConfigArgs(cwd);

    const checkResult = await safeSpawnAsync(
      cmd,
      ["check", "--output-format", "json", ...configArgs, ctx.filePath],
      { timeout: 30000 },
    );

    const raw = stripAnsi(checkResult.stdout + checkResult.stderr);
    const diagnostics = parseRuffJson(checkResult.stdout || "", ctx.filePath);
    const parsedDiagnostics =
      diagnostics.length > 0 ? diagnostics : parseRuffOutput(raw, ctx.filePath);

    if (checkResult.status === 0 && parsedDiagnostics.length === 0) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    if (parsedDiagnostics.length === 0) {
      return {
        status: "failed",
        diagnostics: [],
        semantic: "warning",
        rawOutput: raw.slice(0, 500),
      };
    }

    const hasErrors = parsedDiagnostics.some((d) => d.severity === "error");

    return {
      status: hasErrors ? "failed" : "succeeded",
      diagnostics: parsedDiagnostics,
      semantic: hasErrors ? "blocking" : "warning",
    };
  },
};

export default ruffRunner;
