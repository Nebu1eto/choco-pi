import {
  isFiniteNumber,
  isObjectRecord,
  isString,
  type LspDictionaryValue,
} from "./runtime-guards.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { resolveOpengrepConfig } from "./opengrep-config.ts";
import { buildOpengrepScanArgs } from "./opengrep-runtime.ts";
import { getScratchTreeDirNames } from "./scratch-tree-policy.ts";
import { safeSpawnAsync } from "./safe-spawn.ts";
import { SecurityScanClient } from "./security-scan-client.ts";

export interface OpengrepPosition {
  line: number;
  col: number;
}

export interface OpengrepFinding {
  checkId: string;
  path: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  message: string;
  severity: string;
  cwe?: string[];
}

export interface OpengrepResult {
  success: boolean;
  findings: OpengrepFinding[];
  scannedAt: string;
  summary?: string;
}

const EMPTY_RESULT: Omit<OpengrepResult, "scannedAt"> = {
  success: false,
  findings: [],
};

const SCAN_TIMEOUT_MS = 180_000;

export class OpengrepClient extends SecurityScanClient<OpengrepResult> {
  constructor(verbose = false) {
    super("opengrep", verbose);
  }

  static resolveConfig(cwd: string): ReturnType<typeof resolveOpengrepConfig> {
    return resolveOpengrepConfig(cwd, { enabled: true });
  }

  protected doEnsureAvailable(): Promise<boolean> {
    return this.ensureViaInstaller(["--version"]);
  }

  async scan(cwd: string): Promise<OpengrepResult> {
    const targetDir = path.resolve(cwd);
    const scannedAt = new Date().toISOString();

    if (!(await this.ensureAvailable())) {
      return {
        ...EMPTY_RESULT,
        scannedAt,
        summary: "opengrep not installed",
      };
    }

    return this.dedupeScan(targetDir, () => this.runScan(targetDir));
  }

  private async runScan(cwd: string): Promise<OpengrepResult> {
    const scannedAt = new Date().toISOString();
    const bin = this.binaryPath ?? "opengrep";
    const resolved = OpengrepClient.resolveConfig(cwd);
    const outDir = mkdtempSync(path.join(os.tmpdir(), "choco-pi-lsp-opengrep-"));
    const reportPath = path.join(outDir, "opengrep-report.json");
    try {
      const result = await safeSpawnAsync(
        bin,
        buildOpengrepScanArgs({
          configArg: resolved.configArg ?? "auto",
          reportPath,
          cwd,
          excludeNames: getScratchTreeDirNames(),
        }),
        { cwd, timeout: SCAN_TIMEOUT_MS },
      );

      if (result.error) {
        this.log(`Scan error: ${result.error.message}`);
        return {
          ...EMPTY_RESULT,
          scannedAt,
          summary: result.error.message.slice(0, 200),
        };
      }

      if (!fs.existsSync(reportPath)) {
        return {
          ...EMPTY_RESULT,
          scannedAt,
          summary: (result.stderr ?? "").trim().split("\n")[0] || "no report produced",
        };
      }

      const findings = parseOpengrepReport(fs.readFileSync(reportPath, "utf-8"));
      return {
        success: true,
        findings,
        scannedAt,
      };
    } catch (err) {
      return {
        ...EMPTY_RESULT,
        scannedAt,
        summary: err instanceof Error ? err.message.slice(0, 200) : String(err),
      };
    } finally {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

export function parseOpengrepReport(raw: string): OpengrepFinding[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!parsed || !isObjectRecord(parsed)) return [];

  // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
  const results = (parsed as Record<string, LspDictionaryValue>).results;
  if (!Array.isArray(results)) return [];
  const findings: OpengrepFinding[] = [];
  for (const entry of results) {
    if (!entry || !isObjectRecord(entry)) continue;

    // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
    const e = entry as Record<string, LspDictionaryValue>;

    const checkId = isString(e.check_id) ? e.check_id : undefined;

    const filePath = isString(e.path) ? e.path : undefined;

    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    const start = e.start as { line?: unknown; col?: unknown } | undefined;

    // SAFETY: The adjacent finite-number or TypeBox check establishes the numeric representation before this assertion.
    const end = e.end as { line?: unknown; col?: unknown } | undefined;

    const startLine = isFiniteNumber(start?.line) ? start.line : undefined;
    if (!checkId || !filePath || !Number.isFinite(startLine)) continue;

    // SAFETY: The adjacent finite-number or TypeBox check establishes the numeric representation before this assertion.
    const extra = (e.extra as Record<string, LspDictionaryValue> | undefined) ?? {};

    // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
    const metadata = (extra.metadata as Record<string, LspDictionaryValue> | undefined) ?? {};
    const cwe = Array.isArray(metadata.cwe)
      ? metadata.cwe.filter((c): c is string => isString(c))
      : undefined;
    findings.push({
      checkId,
      path: filePath,

      // SAFETY: The adjacent finite-number or TypeBox check establishes the numeric representation before this assertion.
      startLine: startLine as number,

      startCol: isFiniteNumber(start?.col) ? start.col : 1,

      // SAFETY: The adjacent finite-number or TypeBox check establishes the numeric representation before this assertion.
      endLine: isFiniteNumber(end?.line) ? end.line : (startLine as number),

      endCol: isFiniteNumber(end?.col) ? end.col : 1,

      message: isString(extra.message) ? extra.message : "opengrep finding",

      severity: isString(extra.severity) ? extra.severity : "WARNING",
      cwe,
    });
  }
  return findings;
}
