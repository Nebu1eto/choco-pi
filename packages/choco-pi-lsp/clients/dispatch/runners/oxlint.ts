import * as fs from "node:fs";
import * as path from "node:path";
import { arr, obj, opt, str, compile } from "@earendil-works/pi-schema";
import { finiteNum } from "../../lsp/schema-guards.ts";
import { walkUpDirs } from "../../path-utils.ts";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { getJstsLintPolicyForCwd, hasVitePlusConfig } from "../../tool-policy.ts";
import { PRIORITY } from "../priorities.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import {
  resolveToolCommand,
  resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.ts";

function resolveLocalVp(cwd: string): string | null {
  const isWin = process.platform === "win32";
  for (const dir of walkUpDirs(cwd)) {
    const candidates = isWin
      ? [
          path.join(dir, "node_modules", ".bin", "vp.cmd"),
          path.join(dir, "node_modules", ".bin", "vp"),
        ]
      : [path.join(dir, "node_modules", ".bin", "vp")];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function resolveVitePlusCommand(cwd: string): Promise<string | null> {
  const local = resolveLocalVp(cwd);
  if (local) return local;
  const version = await safeSpawnAsync("vp", ["--version"], {
    timeout: 5000,
    cwd,
  });
  return !version.error && version.status === 0 ? "vp" : null;
}

const oxlintRunner: RunnerDefinition = {
  id: "oxlint",
  appliesTo: ["jsts"],
  priority: PRIORITY.LINT_SECONDARY,
  enabledByDefault: true,
  skipTestFiles: false,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cwd = ctx.cwd || process.cwd();
    const policy = getJstsLintPolicyForCwd(cwd);
    if (!policy.preferredRunners.includes("oxlint")) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    let cmd: string | null = null;
    let args: string[];
    if (hasVitePlusConfig(cwd)) {
      cmd = await resolveVitePlusCommand(cwd);
    }
    if (cmd) {
      args = ["lint", "--format", "json", ctx.filePath];
    } else {
      const oxlintCmd = resolveToolCommand(cwd, "oxlint") ?? "oxlint";
      cmd = (await ctx.hasTool(oxlintCmd))
        ? oxlintCmd
        : await resolveToolCommandWithInstallFallback(cwd, "oxlint");
      args = ["--format", "json", ctx.filePath];
    }
    if (!cmd) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const result = await safeSpawnAsync(cmd, args, {
      timeout: 30000,
    });

    if (result.status === 0) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    let diagnostics = parseOxlintJson(stdout, ctx.filePath);
    if (diagnostics.length === 0 && stdout.length > 0) {
      diagnostics = parseOxlintUnix(stdout + stderr, ctx.filePath);
    }

    if (diagnostics.length === 0) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
    return {
      status: "failed",
      diagnostics,
      semantic: hasBlocking ? "blocking" : "warning",
    };
  },
};

interface OxlintLabel {
  span?: { offset?: number; length?: number; line?: number; column?: number };
}

interface OxlintJsonDiagnostic {
  message?: string;
  code?: string;
  severity?: string;
  help?: string;
  filename?: string;
  labels?: OxlintLabel[];
}

interface OxlintJsonReport {
  diagnostics?: OxlintJsonDiagnostic[];
}

const OxlintJsonReportSchema = obj(
  {
    diagnostics: opt(
      arr(
        obj(
          {
            message: opt(str()),
            code: opt(str()),
            severity: opt(str()),
            help: opt(str()),
            filename: opt(str()),
            labels: opt(
              arr(
                obj(
                  {
                    span: opt(
                      obj(
                        {
                          offset: opt(finiteNum()),
                          length: opt(finiteNum()),
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
            ),
          },
          { open: true },
        ),
      ),
    ),
  },
  { open: true },
);
const isOxlintJsonReport = compile(OxlintJsonReportSchema).check;

function extractOxlintRule(code: string | undefined): string {
  if (!code) return "unknown";
  const open = code.indexOf("(");
  if (open === -1) return code;
  const close = code.indexOf(")", open + 1);
  if (close === -1 || close === open + 1) return code;
  return code.slice(open + 1, close);
}

function parseOxlintJson(raw: string, filePath: string): Diagnostic[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return [];
  let parsed: OxlintJsonReport;
  try {
    const value = JSON.parse(trimmed);
    if (!isOxlintJsonReport(value)) return [];
    parsed = value;
  } catch {
    return [];
  }
  const diagnostics: Diagnostic[] = [];
  for (const d of parsed.diagnostics ?? []) {
    const rule = extractOxlintRule(d.code);
    const label = d.labels?.[0]?.span;
    const lineNum = label?.line ?? 1;
    const colNum = label?.column ?? 1;
    const severity = d.severity === "error" ? "error" : "warning";
    const help = d.help?.trim();
    diagnostics.push({
      id: `oxlint-${rule}-${lineNum}`,
      message: `${d.message ?? "oxlint issue"} (${rule})`,
      filePath,
      line: lineNum,
      column: colNum,
      severity,
      semantic: severity === "error" ? "blocking" : "warning",
      tool: "oxlint",
      rule,
      fixSuggestion: help && help.length > 0 ? help : undefined,
    });
  }
  return diagnostics;
}

function parseOxlintUnix(raw: string, filePath: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of raw.split("\n")) {
    const match = line.match(/^(.+):(\d+):(\d+):\s*(.+?)\s*\(([^)]+)\)$/);
    if (match) {
      const [, _file, lineStr, _col, message, rule] = match;
      diagnostics.push({
        id: `oxlint-${rule}-${lineStr}`,
        message: `${message} (${rule})`,
        filePath,
        line: parseInt(lineStr, 10),
        severity: "warning",
        semantic: "warning",
        tool: "oxlint",
        rule,
      });
    }
  }
  return diagnostics;
}

export default oxlintRunner;
