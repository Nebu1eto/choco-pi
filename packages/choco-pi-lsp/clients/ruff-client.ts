import { createSubsystemLogger } from "./extension-log.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createAvailabilityChecker,
  resolveAvailableOrInstall,
} from "./dispatch/runners/utils/runner-helpers.ts";
import { isFileKind } from "./file-kinds.ts";
import { safeSpawnAsync } from "./safe-spawn.ts";
import { ruffConfigArgs } from "./tool-policy.ts";

export interface RuffDiagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: "error" | "warning";
  message: string;
  rule: string;
  file: string;
  fixable: boolean;
}

interface RuffJsonDiagnostic {
  code: string | null;
  message: string;
  location: { row: number; column: number };
  end_location: { row: number; column: number };
  fix: { applicability: string } | null;
  filename: string;
}

const ruffAvailability = createAvailabilityChecker("ruff", ".exe");

export class RuffClient {
  private ruffCommand = "ruff";
  private log: (msg: string) => void;

  constructor(verbose = false) {
    this.log = verbose ? createSubsystemLogger("ruff") : () => {};
  }

  async ensureAvailable(): Promise<boolean> {
    const resolved = await resolveAvailableOrInstall(ruffAvailability, "ruff", process.cwd());
    if (!resolved) return false;
    this.ruffCommand = resolved;
    return true;
  }

  isPythonFile(filePath: string): boolean {
    return isFileKind(filePath, "python");
  }

  async fixFileAsync(
    filePath: string,
    cwd?: string,
  ): Promise<{
    success: boolean;
    changed: boolean;
    fixed: number;
    error?: string;
  }> {
    if (!(await this.ensureAvailable())) {
      return {
        success: false,
        changed: false,
        fixed: 0,
        error: "Ruff not available",
      };
    }

    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      return {
        success: false,
        changed: false,
        fixed: 0,
        error: "File not found",
      };
    }

    try {
      const before = await fs.promises.readFile(absolutePath, "utf-8");

      const configArgs = ruffConfigArgs(cwd ?? path.dirname(absolutePath));
      const spawnOpts = { timeout: 10000, cwd: cwd ?? path.dirname(absolutePath) };

      const pre = await safeSpawnAsync(
        this.ruffCommand,
        [
          "check",
          "--output-format",
          "json",
          "--target-version",
          "py310",
          ...configArgs,
          absolutePath,
        ],
        spawnOpts,
      );
      const beforeDiags = pre.stdout?.trim() ? this.parseOutput(pre.stdout, absolutePath) : [];
      const fixableCount = beforeDiags.filter((d) => d.fixable).length;

      const fix = await safeSpawnAsync(
        this.ruffCommand,
        ["check", "--fix", ...configArgs, absolutePath],
        { timeout: 15000, cwd: cwd ?? path.dirname(absolutePath) },
      );

      if (fix.error) {
        return {
          success: false,
          changed: false,
          fixed: 0,
          error: fix.error.message,
        };
      }

      const after = await fs.promises.readFile(absolutePath, "utf-8");
      const changed = before !== after;

      if (changed) {
        this.log(`Fixed ${fixableCount} issue(s) in ${path.basename(filePath)}`);
      }

      return { success: true, changed, fixed: fixableCount };
    } catch (err: any) {
      return { success: false, changed: false, fixed: 0, error: err.message };
    }
  }

  private parseOutput(output: string, filterFile?: string): RuffDiagnostic[] {
    if (!output.trim()) return [];

    try {
      const items: RuffJsonDiagnostic[] = JSON.parse(output);
      const diagnostics: RuffDiagnostic[] = [];

      for (const item of items) {
        if (filterFile && path.resolve(item.filename) !== filterFile) continue;

        diagnostics.push({
          line: item.location.row - 1,
          column: item.location.column - 1,
          endLine: item.end_location.row - 1,
          endColumn: item.end_location.column - 1,
          severity: item.code?.startsWith("E") ? "error" : "warning",
          message: item.message,
          rule: item.code || "unknown",
          file: item.filename,
          fixable: item.fix !== null,
        });
      }

      return diagnostics;
    } catch (err) {
      void err;
      this.log("Failed to parse ruff JSON output");
      return [];
    }
  }
}
