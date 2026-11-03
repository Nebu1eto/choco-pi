import * as path from "node:path";
import { arr, lit, obj, str, union, compile } from "@earendil-works/pi-schema";
import { finiteNum } from "../../lsp/schema-guards.ts";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { getLinterPolicyForCwd } from "../../tool-policy.ts";
import { PRIORITY } from "../priorities.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import {
  createAvailabilityChecker,
  resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.ts";
import { spawnFailedWithNoOutput } from "./utils/spawn-outcome.ts";

const hadolint = createAvailabilityChecker("hadolint", ".exe");

const HadolintOutputSchema = arr(
  obj(
    {
      line: finiteNum(),
      code: str(),
      message: str(),
      column: finiteNum(),
      file: str(),
      level: union([lit("error"), lit("warning"), lit("info"), lit("style")]),
    },
    { open: true },
  ),
);
const isHadolintOutput = compile(HadolintOutputSchema).check;

function parseHadolintOutput(raw: string, filePath: string): Diagnostic[] {
  try {
    const parsed = JSON.parse(raw);
    if (!isHadolintOutput(parsed)) return [];

    return parsed.map((item) => {
      const severity = item.level === "error" ? "error" : "warning";
      return {
        id: `hadolint-${item.code}-${item.line}`,
        message: `[${item.code}] ${item.message}`,
        filePath,
        line: item.line,
        column: item.column ?? 1,
        severity,
        semantic: severity === "error" ? "blocking" : "warning",
        tool: "hadolint",
        rule: item.code,
        fixable: false,
      };
    });
  } catch {
    return [];
  }
}

const hadolintRunner: RunnerDefinition = {
  id: "hadolint",
  appliesTo: ["docker"],
  priority: PRIORITY.GENERAL_ANALYSIS,
  enabledByDefault: true,
  skipTestFiles: false,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cwd = ctx.cwd || process.cwd();
    const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
    if (policy && !policy.preferredRunners.includes("hadolint")) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    let cmd: string | null = null;
    if (await hadolint.isAvailableAsync(cwd)) {
      cmd = hadolint.getCommand(cwd);
    } else {
      cmd = await resolveToolCommandWithInstallFallback(cwd, "hadolint");
    }

    if (!cmd) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const result = await safeSpawnAsync(
      cmd,
      ["--format", "json", "--no-fail", path.resolve(cwd, ctx.filePath)],
      { cwd },
    );

    if (spawnFailedWithNoOutput(result)) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const output = result.stdout || "";
    const diagnostics = parseHadolintOutput(output, ctx.filePath);

    if (diagnostics.length === 0) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    const hasErrors = diagnostics.some((d) => d.severity === "error");
    return {
      status: "failed",
      diagnostics,
      semantic: hasErrors ? "blocking" : "warning",
    };
  },
};

export default hadolintRunner;
