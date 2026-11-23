import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { incrementDegradationCount } from "../../degradation-ledger.ts";
import { safeSpawnAsync, type SpawnResult } from "../../safe-spawn.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import { PRIORITY } from "../priorities.ts";
import {
  type AvailabilityCause,
  type AvailabilityOutcome,
  classifyProbeFailure,
  createAvailabilityLatch,
  isLatchingOutcome,
  logAvailabilityDecision,
  startHostStallSampler,
} from "./utils/availability-policy.ts";

interface PSAnalyzerResult {
  RuleName?: string;
  Severity?: string;
  Line?: number;
  Column?: number;
  Message?: string;
}

const PS_SCRIPT = `
param([string]$FilePath)
Import-Module PSScriptAnalyzer -ErrorAction Stop
$results = @(Invoke-ScriptAnalyzer -Path $FilePath | Select-Object RuleName,@{N='Severity';E={$_.Severity.ToString()}},Line,Column,Message)
if ($results.Count -eq 0) { Write-Output '[]'; exit 0 }
$results | ConvertTo-Json -Depth 3 -Compress
`.trim();

const PS_TIMEOUT_MS = 30000;

function spawnPs(cmd: string, args: string[], timeoutMs = PS_TIMEOUT_MS): Promise<SpawnResult> {
  return safeSpawnAsync(cmd, args, {
    timeout: timeoutMs,
    resourceLabel: "psscriptanalyzer",
  });
}

interface AvailabilityClassification {
  outcome: AvailabilityOutcome;
  cause: AvailabilityCause;
}

const psCmdLatch = createAvailabilityLatch();
const psAnalyzerLatchByCmd = new Map<string, ReturnType<typeof createAvailabilityLatch>>();
const psExecLatchByCmd = new Map<string, ReturnType<typeof createAvailabilityLatch>>();
let psCmd: string | null = null;

function notePsDecision(
  latch: ReturnType<typeof createAvailabilityLatch>,
  tool: string,
  verdict:
    | { available: true; elapsedMs: number; hostStallMs: number }
    | {
        available: false;
        outcome: AvailabilityOutcome;
        cause: AvailabilityCause;
        elapsedMs: number;
        hostStallMs: number;
      },
): void {
  let retryAfterMs: number | undefined;
  if (verdict.available) {
    latch.noteAvailable();
  } else {
    const delay = latch.noteUnavailable(verdict.outcome, verdict.cause);
    if (delay > 0) retryAfterMs = delay;
  }
  logAvailabilityDecision({
    tool,
    verdict: verdict.available ? "available" : "unavailable",
    outcome: verdict.available ? "success" : verdict.outcome,
    cause: verdict.available ? "ok" : verdict.cause,
    elapsedMs: verdict.elapsedMs,
    latched: verdict.available || isLatchingOutcome(verdict.outcome),
    hostStallMs: verdict.hostStallMs,
    ...(retryAfterMs !== undefined && { retryAfterMs }),
    budgetMs: PS_TIMEOUT_MS,
  });
}

export function resetPsScriptAnalyzerAvailability(): void {
  psCmdLatch.reset();
  psAnalyzerLatchByCmd.clear();
  psExecLatchByCmd.clear();
  psCmd = null;
}

async function resolvePowerShellCmd(): Promise<string | null> {
  const memo = psCmdLatch.read();
  if (memo !== null) return memo ? psCmd : null;

  let transient: AvailabilityClassification | null = null;
  let rejected: AvailabilityClassification | null = null;
  let elapsedTotalMs = 0;
  let stallTotalMs = 0;
  for (const candidate of ["pwsh", "powershell"]) {
    const sampler = startHostStallSampler();
    const startedAt = Date.now();
    const result = await spawnPs(candidate, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "exit 0",
    ]);
    const hostStallMs = sampler.stop();
    const elapsedMs = Date.now() - startedAt;
    elapsedTotalMs += elapsedMs;
    stallTotalMs += hostStallMs;
    if (!result.error && result.status === 0) {
      psCmd = candidate;
      notePsDecision(psCmdLatch, "powershell", {
        available: true,
        elapsedMs,
        hostStallMs,
      });
      return candidate;
    }
    const classified = classifyProbeFailure(result, { hostStallMs });
    if (classified.outcome === "transient") transient ??= classified;
    else if (classified.outcome !== "missing") rejected ??= classified;
  }

  psCmd = null;
  const unavailable: AvailabilityClassification = {
    outcome: "missing",
    cause: "not-found",
  };
  const verdict = transient ?? rejected ?? unavailable;
  notePsDecision(psCmdLatch, "powershell", {
    available: false,
    outcome: verdict.outcome,
    cause: verdict.cause,
    elapsedMs: elapsedTotalMs,
    hostStallMs: stallTotalMs,
  });
  return null;
}

async function checkModuleAvailable(cmd: string): Promise<boolean> {
  let latch = psAnalyzerLatchByCmd.get(cmd);
  if (!latch) {
    latch = createAvailabilityLatch();
    psAnalyzerLatchByCmd.set(cmd, latch);
  }
  const memo = latch.read();
  if (memo !== null) return memo;

  const sampler = startHostStallSampler();
  const startedAt = Date.now();
  const result = await spawnPs(cmd, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "if (Get-Module -ListAvailable PSScriptAnalyzer) { exit 0 } else { exit 1 }",
  ]);
  const hostStallMs = sampler.stop();
  const elapsedMs = Date.now() - startedAt;
  if (!result.error && result.status === 0) {
    notePsDecision(latch, "psscriptanalyzer", {
      available: true,
      elapsedMs,
      hostStallMs,
    });
    return true;
  }
  const moduleAbsent = result.status === 1 && !result.failure && !result.error;
  const classified = classifyProbeFailure(result, {
    hostStallMs,
    ...(moduleAbsent && { unclassifiedFailureOutcome: "missing" as const }),
  });
  let { outcome, cause } = classified;
  if (!moduleAbsent && outcome !== "transient") {
    outcome = "transient";
    cause = "probe-rejected";
  }
  notePsDecision(latch, "psscriptanalyzer", {
    available: false,
    outcome,
    cause,
    elapsedMs,
    hostStallMs,
  });
  return false;
}

function parsePSAnalyzerOutput(raw: string, filePath: string): Diagnostic[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === "[]") return [];
  let parsed: PSAnalyzerResult | PSAnalyzerResult[];
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items
    .filter((item) => item.Message && item.Line)
    .map((item) => {
      const sev = (item.Severity ?? "Warning").toLowerCase();
      const severity: "error" | "warning" | "info" =
        sev === "error" || sev === "parseerror"
          ? "error"
          : sev === "information"
            ? "info"
            : "warning";
      const rule = item.RuleName ?? "PSScriptAnalyzer";
      return {
        id: `psscriptanalyzer-${rule}-${item.Line}`,
        message: `[${rule}] ${item.Message}`,
        filePath,
        line: item.Line!,
        column: item.Column ?? 1,
        severity,
        semantic: severity === "error" ? "blocking" : "warning",
        tool: "psscriptanalyzer",
        rule,
        fixable: false,
      };
    });
}

const psScriptAnalyzerRunner: RunnerDefinition = {
  id: "psscriptanalyzer",
  appliesTo: ["powershell"],
  priority: PRIORITY.GENERAL_ANALYSIS,
  enabledByDefault: true,
  skipTestFiles: false,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cmd = await resolvePowerShellCmd();
    if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

    if (!(await checkModuleAvailable(cmd))) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    let execLatch = psExecLatchByCmd.get(cmd);
    if (!execLatch) {
      execLatch = createAvailabilityLatch();
      psExecLatchByCmd.set(cmd, execLatch);
    }
    if (execLatch.read() === false) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const cwd = ctx.cwd || process.cwd();
    const absPath = path.resolve(cwd, ctx.filePath);

    const tmpScript = path.join(os.tmpdir(), `choco-pi-lsp-psa-${process.pid}.ps1`);
    await fs.writeFile(tmpScript, PS_SCRIPT, "utf-8");

    try {
      const sampler = startHostStallSampler();
      const startedAt = Date.now();
      const result = await spawnPs(cmd, [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        tmpScript,
        "-FilePath",
        absPath,
      ]);
      const hostStallMs = sampler.stop();
      const elapsedMs = Date.now() - startedAt;

      if (result.status === null) {
        const classified = classifyProbeFailure(result, { hostStallMs });
        let { outcome, cause } = classified;
        if (outcome !== "transient") {
          outcome = "transient";
          cause = "probe-rejected";
        }
        notePsDecision(execLatch, "psscriptanalyzer-exec", {
          available: false,
          outcome,
          cause,
          elapsedMs,
          hostStallMs,
        });
        incrementDegradationCount({
          kind: "grammar-blocked",
          subject: "psscriptanalyzer",
          reason: `PowerShell (${cmd}) -File analysis exited with no status -- crash or signal-killed process`,
        });
        return { status: "skipped", diagnostics: [], semantic: "none" };
      }

      if (result.status !== 0) {
        const stderrText = result.stderr ?? "";
        const policyDenied =
          /securityerror/i.test(stderrText) &&
          (/execution polic(y|ies)/i.test(stderrText) ||
            /running scripts is disabled/i.test(stderrText) ||
            /unauthorizedaccess/i.test(stderrText));
        const classified = classifyProbeFailure(result, { hostStallMs });
        let { outcome, cause } = classified;
        if (policyDenied) {
          outcome = "non-installable";
          cause = "policy-denied";
        } else if (outcome !== "transient") {
          outcome = "transient";
          cause = "probe-rejected";
        }
        notePsDecision(execLatch, "psscriptanalyzer-exec", {
          available: false,
          outcome,
          cause,
          elapsedMs,
          hostStallMs,
        });
        incrementDegradationCount({
          kind: "grammar-blocked",
          subject: "psscriptanalyzer",
          reason: policyDenied
            ? `PowerShell execution policy blocked -File analysis for ${cmd}: ${stderrText.trim().split("\n")[0] || "SecurityError"}`
            : `PowerShell -File analysis for ${cmd} exited ${result.status}: ${stderrText.trim().slice(0, 200) || "no stderr"}`,
        });
        return { status: "skipped", diagnostics: [], semantic: "none" };
      }

      if (execLatch.read() === null) {
        notePsDecision(execLatch, "psscriptanalyzer-exec", {
          available: true,
          elapsedMs,
          hostStallMs,
        });
      }

      const diagnostics = parsePSAnalyzerOutput(result.stdout, ctx.filePath);

      if (diagnostics === null) {
        const unreadableReason = result.stdout.trim() ? "unparseable" : "empty";
        logAvailabilityDecision({
          tool: "psscriptanalyzer-stdout",
          verdict: "unavailable",
          outcome: "transient",
          cause: "empty-result",
          elapsedMs,
          latched: false,
          hostStallMs,
          budgetMs: PS_TIMEOUT_MS,
        });
        incrementDegradationCount({
          kind: "grammar-blocked",
          subject: "psscriptanalyzer",
          reason: `PowerShell -File analysis for ${cmd} exited 0 but stdout was ${unreadableReason}`,
        });
        return { status: "skipped", diagnostics: [], semantic: "none" };
      }

      if (diagnostics.length === 0) {
        return { status: "succeeded", diagnostics: [], semantic: "none" };
      }

      const hasErrors = diagnostics.some((d) => d.severity === "error");
      return {
        status: hasErrors ? "failed" : "succeeded",
        diagnostics,
        semantic: hasErrors ? "blocking" : "warning",
      };
    } finally {
      await fs.unlink(tmpScript).catch(() => {});
    }
  },
};

export default psScriptAnalyzerRunner;
