import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { PRIORITY } from "../priorities.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import {
  createAvailabilityChecker,
  resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.ts";

const actionlint = createAvailabilityChecker("actionlint", ".exe");

type ActionlintIssue = {
  message?: string;
  filepath?: string;
  line?: number;
  column?: number;
  kind?: string;
  snippet?: string;
  end_line?: number;
  end_column?: number;
};

const ActionlintIssueSchema = Type.Object(
  {
    message: Type.Optional(Type.String()),
    filepath: Type.Optional(Type.String()),
    line: Type.Optional(Type.Number()),
    column: Type.Optional(Type.Number()),
    kind: Type.Optional(Type.String()),
    snippet: Type.Optional(Type.String()),
    end_line: Type.Optional(Type.Number()),
    end_column: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);
const ActionlintOutputSchema = Type.Union([
  ActionlintIssueSchema,
  Type.Array(ActionlintIssueSchema),
]);

export function isGitHubWorkflowFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(normalized);
}

function toDiagnostic(issue: ActionlintIssue, filePath: string): Diagnostic {
  const line = issue.line && issue.line > 0 ? issue.line : 1;
  const column = issue.column && issue.column > 0 ? issue.column : 1;
  const rule = issue.kind || "actionlint";
  const message = issue.message || "GitHub Actions workflow issue";
  const idMessage = message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 80);

  return {
    id: `actionlint-${rule}-${line}-${column}-${idMessage}`,
    message,
    filePath,
    line,
    column,
    severity: "error",
    semantic: "blocking",
    tool: "actionlint",
    rule,
    defectClass: "correctness",
    matchedText: issue.snippet,
  };
}

export function parseActionlintJson(raw: string, filePath: string): Diagnostic[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (!Value.Check(ActionlintOutputSchema, parsed)) return [];
    const issues = Array.isArray(parsed) ? parsed : [parsed];
    return issues.map((issue) => toDiagnostic(issue, filePath));
  } catch {
    // Some actionlint versions or wrappers may emit one JSON object per line.
    const diagnostics: Diagnostic[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (Value.Check(ActionlintIssueSchema, parsed)) {
          diagnostics.push(toDiagnostic(parsed, filePath));
        }
      } catch {
        // Ignore non-JSON chatter; the caller will synthesize a generic diagnostic
        // if actionlint failed and no structured diagnostics were parsed.
      }
    }
    return diagnostics;
  }
}

const actionlintRunner: RunnerDefinition = {
  id: "actionlint",
  appliesTo: ["yaml"],
  priority: PRIORITY.YAML_LINT + 1,
  enabledByDefault: true,
  skipTestFiles: false,

  when(ctx: DispatchContext): boolean {
    return isGitHubWorkflowFile(ctx.filePath);
  },

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cwd = ctx.cwd || process.cwd();
    let cmd: string | null = null;

    if (await actionlint.isAvailableAsync(cwd)) {
      cmd = actionlint.getCommand(cwd);
    } else {
      cmd = await resolveToolCommandWithInstallFallback(cwd, "actionlint");
    }

    if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

    const relativeFilePath = path.relative(cwd, ctx.filePath) || ctx.filePath;
    const result = await safeSpawnAsync(cmd, ["-format", "{{json .}}", relativeFilePath], {
      cwd,
      timeout: 15000,
    });

    const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    let diagnostics = parseActionlintJson(raw, ctx.filePath);

    if (diagnostics.length === 0 && result.status !== 0 && raw.trim()) {
      diagnostics = [
        {
          id: `actionlint-${path.basename(ctx.filePath)}-failure`,
          message: raw.trim().split(/\r?\n/)[0] || "actionlint failed",
          filePath: ctx.filePath,
          line: 1,
          column: 1,
          severity: "error",
          semantic: "blocking",
          tool: "actionlint",
          rule: "actionlint",
          defectClass: "correctness",
        },
      ];
    }

    if (diagnostics.length === 0) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    return {
      status: "failed",
      diagnostics,
      semantic: "blocking",
    };
  },
};

export default actionlintRunner;
