import * as path from "node:path";
import { arr, obj, opt, str, union, compile } from "@earendil-works/pi-schema";
import { finiteNum, isFiniteNumber } from "../../lsp/schema-guards.ts";
import { isRuntimeString } from "../../../tools/runtime-values.ts";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { pathsEqual } from "../../path-utils.ts";
import { getLinterPolicyForCwd } from "../../tool-policy.ts";
import { PRIORITY } from "../priorities.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import { createAvailabilityChecker, resolveAvailableOrInstall } from "./utils/runner-helpers.ts";
import { spawnFailedWithNoOutput } from "./utils/spawn-outcome.ts";

const terragrunt = createAvailabilityChecker("terragrunt", ".exe");

interface TerragruntDiagnostic {
  severity?: string | number;
  summary?: string;
  detail?: string;
  range?: {
    filename?: string;
    start?: { line?: number; column?: number };
  };
}

const TerragruntDiagnosticSchema = obj(
  {
    severity: opt(union([str(), finiteNum()])),
    summary: opt(str()),
    detail: opt(str()),
    range: opt(
      obj(
        {
          filename: opt(str()),
          start: opt(
            obj(
              {
                line: opt(finiteNum()),
                column: opt(finiteNum()),
              },
              { open: true },
            ),
          ),
        },
        { open: true },
      ),
    ),
  },
  { open: true },
);
const TerragruntOutputSchema = union([
  arr(TerragruntDiagnosticSchema),
  obj(
    {
      invalid_files: opt(
        arr(obj({ diagnostics: opt(arr(TerragruntDiagnosticSchema)) }, { open: true })),
      ),
    },
    { open: true },
  ),
]);
const isTerragruntOutput = compile(TerragruntOutputSchema).check;

function normalizeSeverity(raw: TerragruntDiagnostic["severity"]): "error" | "warning" {
  if (isFiniteNumber(raw)) return raw === 1 ? "error" : "warning";
  if (isRuntimeString(raw) && raw.toLowerCase() === "error") return "error";
  return "warning";
}

function toRawDiagnostics<T>(parsed: T): TerragruntDiagnostic[] {
  if (!isTerragruntOutput(parsed)) return [];
  if (Array.isArray(parsed)) return parsed;
  return (parsed.invalid_files ?? []).flatMap((file) => file.diagnostics ?? []);
}

export function parseTerragruntOutput(
  raw: string,
  filePath: string,
  absPath: string = path.resolve(filePath),
): Diagnostic[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const unitDir = path.dirname(absPath);
  const diagnostics: Diagnostic[] = [];
  for (const d of toRawDiagnostics(parsed)) {
    const diagFile = d.range?.filename;
    if (diagFile && !pathsEqual(path.resolve(unitDir, diagFile), absPath)) continue;
    const line = d.range?.start?.line ?? 1;
    const column = d.range?.start?.column ?? 1;
    const severity = normalizeSeverity(d.severity);
    const message = d.summary ?? d.detail ?? "terragrunt hcl validate error";
    const idMessage = message
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 80);
    diagnostics.push({
      id: `terragrunt-hclvalidate-${line}-${column}-${idMessage}`,
      message,
      filePath,
      line,
      column,
      severity,
      semantic: severity === "error" ? "blocking" : "warning",
      tool: "terragrunt",
      fixable: false,
    });
  }
  return diagnostics;
}

const SKIPPED: RunnerResult = {
  status: "skipped",
  diagnostics: [],
  semantic: "none",
};

const terragruntRunner: RunnerDefinition = {
  id: "terragrunt",
  appliesTo: ["terragrunt"],
  priority: PRIORITY.GENERAL_ANALYSIS,
  enabledByDefault: true,
  skipTestFiles: false,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cwd = ctx.cwd || process.cwd();
    const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
    if (policy && !policy.preferredRunners.includes("terragrunt")) return SKIPPED;

    let cmd: string | null = null;
    if (await terragrunt.isAvailableAsync(cwd)) {
      cmd = terragrunt.getCommand(cwd);
    } else {
      const managed = await resolveAvailableOrInstall(terragrunt, "terragrunt", cwd);
      if (managed) cmd = managed;
    }

    if (!cmd) return SKIPPED;

    const absPath = path.resolve(cwd, ctx.filePath);
    const fileDir = path.dirname(absPath);
    const result = await safeSpawnAsync(cmd, ["hcl", "validate", "--json", "--non-interactive"], {
      cwd: fileDir,
      timeout: 30000,
    });

    if (spawnFailedWithNoOutput(result)) return SKIPPED;

    const diagnostics = parseTerragruntOutput(result.stdout || "", ctx.filePath, absPath);
    if (diagnostics.length === 0) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    const hasErrors = diagnostics.some((d) => d.severity === "error");
    return {
      status: hasErrors ? "failed" : "succeeded",
      diagnostics,
      semantic: hasErrors ? "blocking" : "warning",
    };
  },
};

export default terragruntRunner;
