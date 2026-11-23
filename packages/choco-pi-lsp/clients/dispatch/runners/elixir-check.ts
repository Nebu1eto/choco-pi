import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "../../file-utils.ts";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { PRIORITY } from "../priorities.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import { createAvailabilityChecker } from "./utils/runner-helpers.ts";

const mix = createAvailabilityChecker("mix", ".bat");
const elixirc = createAvailabilityChecker("elixirc", ".bat");

function hasMixExs(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, "mix.exs"));
}

const ELIXIR_SNIPPET_LOCATION = /└─\s+(.+?):(\d+)(?::(\d+))?(?::|$)/;

function parseElixirOutput(
  raw: string,
  filePath: string,
  cwd: string = process.cwd(),
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const resolvedTarget = path.resolve(cwd, filePath);
  const lines = raw.split(/\r?\n/);

  const matchesTarget = (sourcePath: string): boolean => {
    const resolved = path.resolve(cwd, sourcePath.trim());
    return process.platform === "win32"
      ? resolved.toLowerCase() === resolvedTarget.toLowerCase()
      : resolved === resolvedTarget;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.length > 2000) continue;

    const syntax = line.match(/^\*\* \(([^)]+)\)\s+(.+?):(\d+):(?:(\d+):)?\s*(.+)$/);
    if (syntax) {
      const [, kind, sourcePath, lineStr, colStr, message] = syntax;
      if (!matchesTarget(sourcePath)) continue;
      diagnostics.push({
        id: `elixir-check-${kind}-${lineStr}-${colStr || "1"}`,
        message: `[${kind}] ${message.trim()}`,
        filePath,
        line: Number.parseInt(lineStr, 10) || 1,
        column: Number.parseInt(colStr || "1", 10) || 1,
        severity: "error",
        semantic: "blocking",
        tool: "elixir-check",
        rule: kind,
        fixable: false,
      });
      continue;
    }

    const header = line.match(/^\s*(error|warning):\s+(.+)$/);
    if (!header) continue;
    const [, severityLabel, message] = header;
    const severity = severityLabel === "error" ? "error" : "warning";

    let located = false;
    for (
      let lookahead = index + 1;
      lookahead < lines.length && lookahead <= index + 12;
      lookahead++
    ) {
      const next = lines[lookahead];
      if (/^\s*(error|warning):\s+/.test(next)) break;
      const snippet = next.match(ELIXIR_SNIPPET_LOCATION);
      if (snippet) {
        const [, sourcePath, lineStr, colStr] = snippet;
        if (matchesTarget(sourcePath)) {
          diagnostics.push({
            id: `elixir-check-${severity}-${lineStr}-${colStr || "1"}`,
            message: severity === "error" ? `[error] ${message.trim()}` : message.trim(),
            filePath,
            line: Number.parseInt(lineStr, 10) || 1,
            column: Number.parseInt(colStr || "1", 10) || 1,
            severity,
            semantic: severity === "error" ? "blocking" : "warning",
            tool: "elixir-check",
            rule: severity === "error" ? "error" : "warning",
            fixable: false,
          });
        }
        located = true;
        break;
      }
    }
    if (located) continue;

    const location = lines[index + 1]?.match(/^\s+(.+?):(\d+):(?:(\d+):)?$/);
    if (!location) continue;
    const [, sourcePath, lineStr, colStr] = location;
    if (!matchesTarget(sourcePath)) continue;
    diagnostics.push({
      id: `elixir-check-${severity}-${lineStr}-${colStr || "1"}`,
      message: severity === "error" ? `[error] ${message.trim()}` : message.trim(),
      filePath,
      line: Number.parseInt(lineStr, 10) || 1,
      column: Number.parseInt(colStr || "1", 10) || 1,
      severity,
      semantic: severity === "error" ? "blocking" : "warning",
      tool: "elixir-check",
      rule: severity === "error" ? "error" : "warning",
      fixable: false,
    });
  }
  return diagnostics;
}

function firstOutputLine(result: { stdout?: string; stderr?: string }): string {
  return `${result.stderr || ""}\n${result.stdout || ""}`.trim().split(/\r?\n/, 1)[0].slice(0, 200);
}

const elixirCheckRunner: RunnerDefinition = {
  id: "elixir-check",
  appliesTo: ["elixir"],
  priority: PRIORITY.GENERAL_ANALYSIS,
  enabledByDefault: true,
  skipTestFiles: false,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cwd = ctx.cwd || process.cwd();
    const absPath = path.resolve(cwd, ctx.filePath);

    let command: string | undefined;
    let args: string[] = [];
    if (hasMixExs(cwd) && (await mix.isAvailableAsync(cwd))) {
      command = "mix";
      args = ["compile", "--warnings-as-errors"];
    } else if (await elixirc.isAvailableAsync(cwd)) {
      const outDir = path.join(getProjectDataDir(cwd), "elixir-check");
      fs.mkdirSync(outDir, { recursive: true });
      command = "elixirc";
      args = ["-o", outDir, absPath];
    }

    if (!command) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const result = await safeSpawnAsync(command, args, {
      cwd,
      timeout: 30000,
    });
    if (result.error && !result.stdout && !result.stderr) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const raw = `${result.stderr || ""}\n${result.stdout || ""}`;
    const diagnostics = parseElixirOutput(raw, ctx.filePath, cwd);
    if (diagnostics.length === 0) {
      if (result.status && result.status !== 0) {
        return {
          status: "failed",
          diagnostics: [
            {
              id: "elixir-check-nonzero-no-diagnostics",
              message:
                firstOutputLine(result) ||
                `${command} exited non-zero without structured diagnostics`,
              filePath: ctx.filePath,
              severity: "error",
              semantic: "blocking",
              tool: "elixir-check",
              rule: command,
              fixable: false,
            },
          ],
          semantic: "blocking",
        };
      }
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

export default elixirCheckRunner;
export { parseElixirOutput };
