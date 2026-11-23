import * as fs from "node:fs";
import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { PRIORITY } from "../priorities.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import { createAvailabilityChecker, resolveAvailableOrInstall } from "./utils/runner-helpers.ts";

const shfmt = createAvailabilityChecker("shfmt", ".exe");

function hasEditorConfig(cwd: string): boolean {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".editorconfig"))) return true;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

const shfmtRunner: RunnerDefinition = {
  id: "shfmt",
  appliesTo: ["shell"],
  priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
  enabledByDefault: true,
  skipTestFiles: false,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cwd = ctx.cwd || process.cwd();

    let cmd: string | null = null;
    if (await shfmt.isAvailableAsync(cwd)) {
      cmd = shfmt.getCommand(cwd);
    } else {
      const installed = await resolveAvailableOrInstall(shfmt, "shfmt", cwd);
      if (!installed) {
        return { status: "skipped", diagnostics: [], semantic: "none" };
      }
      cmd = installed;
    }

    if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

    const result = await safeSpawnAsync(cmd, ["--diff", ctx.filePath], {
      timeout: 10000,
      cwd,
    });

    if (result.status === 0) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    if ((result.status ?? 2) > 1) {
      const errMsg = (result.stderr ?? "").split("\n")[0].trim();
      const diagnostics: Diagnostic[] = [
        {
          id: `shfmt-parse-${ctx.filePath}`,
          message: errMsg ? `shfmt parse error: ${errMsg}` : "shfmt: failed to parse shell script",
          filePath: ctx.filePath,
          line: 1,
          column: 1,
          severity: "error",
          semantic: "blocking",
          tool: "shfmt",
          rule: "shfmt-parse-error",
        },
      ];
      return { status: "failed", diagnostics, semantic: "blocking" };
    }

    if (!hasEditorConfig(cwd)) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    const diffOutput = result.stdout ?? result.stderr ?? "";
    let line = 1;
    const lineMatch = diffOutput.match(/^@@\s+-(\d+)/m);
    if (lineMatch) line = Number(lineMatch[1]);

    const diagnostics: Diagnostic[] = [
      {
        id: `shfmt-format-${ctx.filePath}`,
        message: "Shell script is not formatted — run `shfmt -w` to fix",
        filePath: ctx.filePath,
        line,
        column: 1,
        severity: "warning",
        semantic: "warning",
        tool: "shfmt",
        rule: "shfmt-unformatted",
        fixable: true,
        autoFixAvailable: false,
        fixKind: "manual",
      },
    ];
    return { status: "succeeded", diagnostics, semantic: "warning" };
  },
};

export default shfmtRunner;
