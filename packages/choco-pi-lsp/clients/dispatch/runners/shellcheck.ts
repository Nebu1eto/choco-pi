import * as fs from "node:fs";
import * as path from "node:path";
import { arr, compile, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { finiteNum } from "../../lsp/schema-guards.ts";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { PRIORITY } from "../priorities.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import {
  createAvailabilityChecker,
  lspPrimaryCoversFile,
  resolveAvailableOrInstall,
} from "./utils/runner-helpers.ts";

const shellcheck = createAvailabilityChecker("shellcheck", ".exe");

function findShellcheckConfig(cwd: string): string | undefined {
  const local = path.join(cwd, ".shellcheckrc");
  if (fs.existsSync(local)) return local;

  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, ".shellcheckrc");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

const ShellcheckJsonSchema = arr(
  obj(
    {
      file: opt(str()),
      line: opt(finiteNum()),
      endLine: opt(finiteNum()),
      column: opt(finiteNum()),
      endColumn: opt(finiteNum()),
      level: opt(str()),
      code: opt(finiteNum()),
      message: opt(str()),
      fix: opt(unknown()),
    },
    { open: true },
  ),
);
const isShellcheckJson = compile(ShellcheckJsonSchema).check;

interface SeverityMap {
  [severity: string]: "error" | "warning" | "info";
}

function parseShellcheckOutput(raw: string, filePath: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (!raw.trim()) {
    return diagnostics;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isShellcheckJson(parsed)) {
      return diagnostics;
    }

    for (const item of parsed) {
      if (!item.message || !item.line) continue;

      const severityMap: SeverityMap = {
        error: "error",
        warning: "warning",
        info: "info",
        style: "info",
      };
      const severity = severityMap[item.level || "warning"] || "warning";

      const ruleCode = item.code ? `SC${item.code}` : "unknown";

      diagnostics.push({
        id: `shellcheck-${item.line}-${ruleCode}`,
        message: `[${ruleCode}] ${item.message}`,
        filePath,
        line: item.line,
        column: item.column || 1,
        severity,
        semantic: severity === "error" ? "blocking" : "warning",
        tool: "shellcheck",
        rule: ruleCode,
        fixable: !!item.fix,
        autoFixAvailable: false,
        fixKind: item.fix ? "suggestion" : undefined,
      });
    }
  } catch {
    return diagnostics;
  }

  return diagnostics;
}

const shellcheckRunner: RunnerDefinition = {
  id: "shellcheck",
  appliesTo: ["shell"],
  priority: PRIORITY.GENERAL_ANALYSIS,
  enabledByDefault: true,
  skipTestFiles: false,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cwd = ctx.cwd || process.cwd();

    if (
      lspPrimaryCoversFile(ctx, "bash") &&
      (await ctx.hasTool("bash-language-server")) &&
      (await ctx.hasTool("shellcheck"))
    ) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    let cmd: string | null = null;
    if (await shellcheck.isAvailableAsync(cwd)) {
      cmd = shellcheck.getCommand(cwd);
    } else {
      const managed = await resolveAvailableOrInstall(shellcheck, "shellcheck", cwd);
      if (managed) cmd = managed;
    }
    if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

    const shellDialect = "bash";

    const args: string[] = ["--format", "json", "--shell", shellDialect];

    const configPath = findShellcheckConfig(ctx.cwd);
    if (!configPath) {
      args.push("--severity", "info");
    }

    args.push(ctx.filePath);

    const result = await safeSpawnAsync(cmd, args, { timeout: 15000 });

    if (result.status === 0 && !result.stdout?.trim()) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    const raw = result.stdout + result.stderr;
    const diagnostics = parseShellcheckOutput(raw, ctx.filePath);

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

export default shellcheckRunner;
