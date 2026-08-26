/**
 * opengrep CLI client for choco-pi-lsp — bulk/full-workspace project-diagnostics
 * extractor (#584).
 *
 * opengrep already runs as an always-on LSP auxiliary (`clients/lsp/server.ts`
 * `OpengrepServer`) for real-time per-edit feedback, and this client does NOT
 * touch that path. It exists solely so `diagnostics_report mode=full` /
 * `lsp_diagnostics` full-workspace scans can read opengrep's findings from a
 * single project-wide CLI scan instead of one LSP touch per file.
 *
 * Why: opengrep has no `workspace/diagnostic` pull support (push-only, per
 * `docs/servercapabilities.md`), and `reopenOnResync: true`
 * (`clients/lsp/wait-policy/strategies.ts`) means every LSP touch already forces a
 * full re-scan of that one file — there's no incremental efficiency lost by
 * moving bulk scans off the per-file touch loop. On a full sweep the old path
 * instead paid opengrep's full per-file wait-tier budget serially, one file at
 * a time within its server group (#387's deliberate single-flight-per-server
 * serialization) — on a real 50-file sweep this produced 49/50 files reporting
 * "unconfirmed (timed out)".
 *
 * Lifecycle mirrors gitleaks/trivy/knip:
 *   - session_start scan (via `runTask`/`runHeavyweightTask` in
 *     runtime-session.ts), cached via `cacheManager`
 *   - `diagnostics_report mode=full` reads the cache through the extractor
 *     registry (`project-diagnostics/extractors.ts`) — never launches a scan
 *   - per-edit LSP path (real-time feedback) is untouched
 *
 * Enablement mirrors the LSP server (`opengrepInitialization` in server.ts):
 * opengrep is structurally always-on — `resolveOpengrepConfig` only chooses
 * WHICH rules run (a local `.opengrep.yml`/`.semgrep.yml` rule file if
 * present, else the `auto` registry ruleset), not whether it runs at all.
 *
 * `// nosemgrep` / `# nosemgrep` suppression: unlike opengrep's LSP mode
 * (which does NOT honor it natively — that gap is exactly why
 * `isNosemgrepSuppressed`/`applyAuxiliarySuppressions` exist in
 * `clients/dispatch/auxiliary-lsp.ts`, #441/#586/#587), the CLI `scan --json`
 * path DOES suppress `nosemgrep`-annotated findings itself, before they ever
 * reach `--json` output — verified empirically against the real installed
 * opengrep 1.25.0 binary (see the captured raw JSON in
 * `tests/clients/opengrep-client.test.ts`: an annotated line's finding is
 * absent from `results` while an identical unannotated twin still appears).
 * So `opengrepResultToProjectDiagnostics` deliberately applies NO suppression
 * filtering of its own — doing so would be redundant at best.
 *
 * Scope note (#1562 class fix): the CLI scan is handed `--exclude` per shared
 * scratch/cache tree (`scratch-tree-policy.ts`) so a directory that isn't
 * gitignored (opengrep's own default exclusion) still doesn't reach the
 * agent as a finding — same `EXCLUDED_DIRS`-derived list gitleaks/trivy use.
 *
 * Refs: #584, #111 (opengrep adoption), #387 (workspace-sweep serialization), #1562
 */

import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { resolveOpengrepConfig } from "./opengrep-config.ts";
import { buildOpengrepScanArgs } from "./opengrep-runtime.ts";
import { getScratchTreeDirNames } from "./scratch-tree-policy.ts";
import { safeSpawnAsync } from "./safe-spawn.ts";
import { SecurityScanClient } from "./security-scan-client.ts";

const LspDictionaryValueSchema = Type.Unknown();
type LspDictionaryValue = Static<typeof LspDictionaryValueSchema>;

// --- Types ---

/** A single opengrep finding location (semgrep-compatible JSON schema). */
export interface OpengrepPosition {
  line: number;
  col: number;
}

/**
 * Subset of fields opengrep emits per finding in its `--json` report. Schema
 * is semgrep-compatible (opengrep is a semgrep fork) — verified against the
 * real installed binary (opengrep 1.25.0), not assumed from upstream docs.
 */
export interface OpengrepFinding {
  checkId: string;
  path: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  message: string;
  severity: string;
  /** e.g. ["CWE-78: ..."] — carried through for the diagnostic message. */
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

// opengrep loads/compiles a full rule pack (1000+ rules for `auto`) before
// scanning; generous budget for a large tree, matching trivy's CVE-DB-fetch
// allowance rather than the lighter jscpd/gitleaks scans.
const SCAN_TIMEOUT_MS = 180_000;

// --- Client ---

export class OpengrepClient extends SecurityScanClient<OpengrepResult> {
  constructor(verbose = false) {
    super("opengrep", verbose);
  }

  /**
   * Structurally always-on (mirrors `opengrepInitialization` in
   * `clients/lsp/server.ts`) — `resolveOpengrepConfig(cwd, { enabled: true })`
   * only resolves WHICH rules to run, not whether opengrep runs at all.
   * Exported as a static so callers can gate/log without constructing.
   */
  static resolveConfig(cwd: string): ReturnType<typeof resolveOpengrepConfig> {
    return resolveOpengrepConfig(cwd, { enabled: true });
  }

  /**
   * opengrep's top-level `--version` (no `scan` subcommand) — matches the
   * installer's `checkArgs: ["--version"]` entry (`installer/index.ts`).
   */
  protected doEnsureAvailable(): Promise<boolean> {
    return this.ensureViaInstaller(["--version"]);
  }

  /**
   * Scan a directory tree with opengrep's rule set (local config or `auto`).
   * Re-entrancy safe: concurrent calls against the same root share a single
   * opengrep process (mirrors `GitleaksClient`/`JscpdClient`).
   */
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
      } catch {
        // non-fatal
      }
    }
  }
}

// --- Parser ---

/**
 * Map opengrep's `--json` report (semgrep-compatible schema: top-level
 * `results: [{ check_id, path, start:{line,col}, end:{line,col}, extra:{
 * message, severity, metadata:{cwe} } }]`) to our structured
 * `OpengrepFinding[]` shape. Exported for unit tests.
 *
 * Verified against the real installed opengrep 1.25.0 binary's own `--json`
 * output (not assumed from upstream semgrep docs — opengrep is a fork and its
 * CLI surface has drifted in places, e.g. `--files-with-matches` requires
 * `--experimental` where semgrep's doesn't).
 */
export function parseOpengrepReport(raw: string): OpengrepFinding[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!parsed || !Check(Type.Object({}), parsed)) return [];

  // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
  const results = (parsed as Record<string, LspDictionaryValue>).results;
  if (!Array.isArray(results)) return [];
  const findings: OpengrepFinding[] = [];
  for (const entry of results) {
    if (!entry || !Check(Type.Object({}), entry)) continue;

    // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
    const e = entry as Record<string, LspDictionaryValue>;

    const checkId = Check(Type.String(), e.check_id) ? e.check_id : undefined;

    const filePath = Check(Type.String(), e.path) ? e.path : undefined;

    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    const start = e.start as { line?: unknown; col?: unknown } | undefined;

    // SAFETY: The adjacent finite-number or TypeBox check establishes the numeric representation before this assertion.
    const end = e.end as { line?: unknown; col?: unknown } | undefined;

    const startLine = Check(Type.Number(), start?.line) ? start.line : undefined;
    if (!checkId || !filePath || !Number.isFinite(startLine)) continue;

    // SAFETY: The adjacent finite-number or TypeBox check establishes the numeric representation before this assertion.
    const extra = (e.extra as Record<string, LspDictionaryValue> | undefined) ?? {};

    // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
    const metadata = (extra.metadata as Record<string, LspDictionaryValue> | undefined) ?? {};
    const cwe = Array.isArray(metadata.cwe)
      ? metadata.cwe.filter((c): c is string => Check(Type.String(), c))
      : undefined;
    findings.push({
      checkId,
      path: filePath,

      // SAFETY: The adjacent finite-number or TypeBox check establishes the numeric representation before this assertion.
      startLine: startLine as number,

      startCol: Check(Type.Number(), start?.col) ? start.col : 1,

      // SAFETY: The adjacent finite-number or TypeBox check establishes the numeric representation before this assertion.
      endLine: Check(Type.Number(), end?.line) ? end.line : (startLine as number),

      endCol: Check(Type.Number(), end?.col) ? end.col : 1,

      message: Check(Type.String(), extra.message) ? extra.message : "opengrep finding",

      severity: Check(Type.String(), extra.severity) ? extra.severity : "WARNING",
      cwe,
    });
  }
  return findings;
}
