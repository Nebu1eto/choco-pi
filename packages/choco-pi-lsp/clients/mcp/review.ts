import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nodeExecutable } from "@choco-pi/shared/node-runtime";
import {
  type NodePackageManager,
  pmBinary,
  resolveNodePackageManager,
  runScriptArgs,
} from "../package-manager.ts";
import { safeSpawnAsync } from "../safe-spawn.ts";
import type { AnalyzeFileOptions, McpAnalyzeResult } from "./analyze.ts";

export function resolveRebuildScript(serverFilePath: string): "build" | "build:dist" {
  return serverFilePath.replace(/\\/g, "/").includes("/dist/") ? "build:dist" : "build";
}

export interface FreshAnalyzeOutcome {
  result?: McpAnalyzeResult;
  error?: string;
}

export function analyzeFileFresh(
  workerPath: string,
  file: string,
  cwd: string,
  options: AnalyzeFileOptions = {},
  timeoutMs = 120_000,
): Promise<FreshAnalyzeOutcome> {
  return new Promise((resolve) => {
    const args = [workerPath, `--file=${file}`, `--cwd=${cwd}`];
    if (options.flags) args.push(`--flags=${JSON.stringify(options.flags)}`);

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(nodeExecutable(), args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        error: `failed to fork worker: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (outcome: FreshAnalyzeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ error: `fresh analyze timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (err) => finish({ error: `failed to fork worker: ${err.message}` }));
    child.on("close", (code) => {
      if (code !== 0) {
        finish({
          error: `worker exited ${code}: ${stderr.trim() || "(no stderr)"}`,
        });
        return;
      }
      try {
        // SAFETY: The parsed value is consumed only through the optional fields declared here and each field is validated before use.
        finish({ result: JSON.parse(stdout) as McpAnalyzeResult });
      } catch {
        finish({
          error: `worker produced invalid JSON (${stderr.trim() || stdout.slice(0, 200)})`,
        });
      }
    });
  });
}

export interface RebuildOutcome {
  ok: boolean;
  script: string;
  packageManager?: NodePackageManager;
  durationMs: number;
  output: string;
}

export function canRebuildPiLens(repoRoot: string): boolean {
  const inNodeModules = /(^|[\\/])node_modules([\\/]|$)/i.test(repoRoot);
  return !inNodeModules && existsSync(join(repoRoot, "tsconfig.dist.json"));
}

export const REBUILD_UNAVAILABLE_MESSAGE =
  "pilens_rebuild is unavailable in an installed choco-pi-lsp package. Rebuilding is only safe from a source checkout containing tsconfig.dist.json; reinstall or update choco-pi-lsp through your package manager instead.";

export async function runRebuild(
  repoRoot: string,
  script: "build" | "build:dist",
  timeoutMs = 300_000,
): Promise<RebuildOutcome> {
  const start = Date.now();
  if (!canRebuildPiLens(repoRoot)) {
    return {
      ok: false,
      script,
      durationMs: Date.now() - start,
      output: REBUILD_UNAVAILABLE_MESSAGE,
    };
  }
  const packageManager = await resolveNodePackageManager(repoRoot);
  const res = await safeSpawnAsync(pmBinary(packageManager), runScriptArgs(script), {
    cwd: repoRoot,
    timeout: timeoutMs,
    ignoreAmbientSignal: true,
  });
  const output = `${res.stdout}\n${res.stderr}`.trim();
  return {
    ok: !res.error && res.status === 0,
    script,
    packageManager,
    durationMs: Date.now() - start,
    output: output.slice(-2000),
  };
}

export type ScanDiagnostic = {
  filePath: string;
  line?: number;
  column?: number;
  rule?: string;
  runner?: string;
  tool?: string;
};

export function summarizeScan(diagnostics: readonly ScanDiagnostic[]) {
  const seen = new Set<string>();
  const deduped: ScanDiagnostic[] = [];
  const byRule: Record<string, number> = {};
  const byFile: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    const ruleId = diagnostic.rule ?? diagnostic.runner ?? diagnostic.tool ?? "unknown";
    const key = `${diagnostic.filePath}|${diagnostic.line ?? "?"}|${diagnostic.column ?? "?"}|${ruleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(diagnostic);
    byRule[ruleId] = (byRule[ruleId] ?? 0) + 1;
    byFile[diagnostic.filePath] = (byFile[diagnostic.filePath] ?? 0) + 1;
  }
  return { deduped, byRule, byFile };
}
