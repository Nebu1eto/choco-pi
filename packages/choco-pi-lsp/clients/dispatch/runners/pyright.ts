import { logExtension } from "../../extension-log.ts";
import { getLSPService } from "../../lsp/index.ts";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { PRIORITY } from "../priorities.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import { createAvailabilityChecker, resolveAvailableOrInstall } from "./utils/runner-helpers.ts";

const pyright = createAvailabilityChecker("pyright", ".exe");

const pyrightRunner: RunnerDefinition = {
  id: "pyright",
  appliesTo: ["python"],
  priority: PRIORITY.LSP_FALLBACK,
  enabledByDefault: true,
  timeoutMs: 75_000,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    if (!ctx.pi.getFlag("no-lsp")) {
      const lspService = getLSPService();
      await lspService.getClientForFile(ctx.filePath);
    }

    const cwd = ctx.cwd || process.cwd();

    let cmd: string | null = null;

    if (await pyright.isAvailableAsync(cwd)) {
      cmd = pyright.getCommand(cwd);
    }

    if (!cmd) {
      const installedPath = await resolveAvailableOrInstall(pyright, "pyright", cwd);
      if (installedPath) cmd = installedPath;
    }

    if (!cmd) {
      const { findCommandAsync } = await import("../../safe-spawn.ts");
      const foundCmd: string | null = await findCommandAsync("pyright");
      if (foundCmd) cmd = foundCmd;
    }

    if (!cmd) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const result = await safeSpawnAsync(cmd, ["--outputjson", ctx.filePath], {
      timeout: 60000,
      cwd,
    });

    if (result.error) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const output = (result.stdout || "").trim();
    if (!output) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    try {
      const data = JSON.parse(output);
      const diagnostics = parsePyrightOutput(data, ctx.filePath);

      if (diagnostics.length === 0) {
        return { status: "succeeded", diagnostics: [], semantic: "none" };
      }

      const hasErrors = diagnostics.some((d) => d.severity === "error");

      return {
        status: hasErrors ? "failed" : "succeeded",
        diagnostics,
        semantic: hasErrors ? "blocking" : diagnostics.length > 0 ? "warning" : "none",
      };
    } catch {
      logExtension({
        subsystem: "runner:pyright",
        message: `JSON parse failed for ${ctx.filePath} — raw output: ${output.slice(0, 200)}`,
        metadata: { filePath: ctx.filePath },
      });
      return {
        status: "failed",
        diagnostics: [],
        semantic: "none",
        rawOutput: output.slice(0, 500),
      };
    }
  },
};

function parsePyrightOutput(data: any, _filePath: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  const generalDiags = data.generalDiagnostics || [];

  for (const diag of generalDiags) {
    diagnostics.push({
      id: `pyright-${diag.rule || diag.start?.line || "unknown"}`,
      message: diag.message || "Type error",
      filePath: diag.file || _filePath,
      line: diag.start?.line || 0,
      column: diag.start?.column || 0,
      severity: diag.severity === "error" ? "error" : "warning",
      semantic: diag.severity === "error" ? "blocking" : "warning",
      tool: "pyright",
      rule: diag.rule,
    });
  }

  return diagnostics;
}

export default pyrightRunner;
