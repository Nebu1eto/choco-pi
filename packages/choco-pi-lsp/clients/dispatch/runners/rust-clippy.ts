import { dirname, isAbsolute, join, resolve } from "node:path";
import { findNearestContaining } from "../../path-utils.ts";
import { RustClient } from "../../rust-client.ts";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { stripAnsi } from "../../sanitize.ts";
import { getLazyInstallAttempt, tryLazyInstall } from "./utils/lazy-installer.ts";
import { describeInstallAttempt, logAvailabilityDecision } from "./utils/availability-policy.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import { PRIORITY } from "../priorities.ts";
import { createCwdCachedProbe } from "./utils/runner-helpers.ts";

const rustClient = new RustClient();

const CLIPPY_PROBE_BUDGET_MS = 8000;

const makeClippyProbe = (cargoExe: string) =>
  createCwdCachedProbe(
    (cwd) =>
      safeSpawnAsync(cargoExe, ["clippy", "--version"], {
        timeout: CLIPPY_PROBE_BUDGET_MS,
        cwd,
      }),
    { tool: "clippy", budgetMs: CLIPPY_PROBE_BUDGET_MS },
  );

const clippyAvailabilityByCargo = new Map<string, ReturnType<typeof makeClippyProbe>>();
function getClippyProbe(cargoExe: string) {
  return clippyAvailabilityByCargo.get(cargoExe) ?? refreshClippyProbe(cargoExe);
}

function refreshClippyProbe(cargoExe: string) {
  const created = makeClippyProbe(cargoExe);
  clippyAvailabilityByCargo.set(cargoExe, created);
  return created;
}

const rustClippyRunner: RunnerDefinition = {
  id: "rust-clippy",
  appliesTo: ["rust"],
  priority: PRIORITY.SPECIALIZED_ANALYSIS,
  enabledByDefault: true,
  timeoutMs: 90_000,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cargoExe = await rustClient.findCargoPathAsync();
    if (!cargoExe) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const clippyProbe = getClippyProbe(cargoExe);
    if (!(await clippyProbe(ctx.cwd))) {
      if (clippyProbe.getVerdict(ctx.cwd).outcome === "transient") {
        return { status: "skipped", diagnostics: [], semantic: "none" };
      }
      await tryLazyInstall("rust-clippy", ctx.cwd);
      const refreshedProbe = refreshClippyProbe(cargoExe);
      if (!(await refreshedProbe(ctx.cwd))) {
        const verdict = refreshedProbe.getVerdict(ctx.cwd);
        logAvailabilityDecision({
          tool: "rust-clippy",
          verdict: "unavailable",
          outcome: verdict.outcome ?? "missing",
          cause: verdict.cause ?? "not-found",
          classifiedBy: "caller",
          evidence: describeInstallAttempt(getLazyInstallAttempt("rust-clippy", ctx.cwd)),
          elapsedMs: 0,
          latched: false,
        });
        return { status: "skipped", diagnostics: [], semantic: "none" };
      }
    }

    const cargoToml = findCargoToml(ctx.filePath);
    if (!cargoToml) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const result = await safeSpawnAsync(cargoExe, ["clippy", "--message-format=json", "-q"], {
      timeout: 60000,
      cwd: cargoToml.replace("Cargo.toml", ""),
    });

    const raw = stripAnsi(result.stdout + result.stderr);

    if (result.status === 0 && !raw.trim()) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    const cargoDir = cargoToml.replace("Cargo.toml", "");
    const allDiagnostics = parseClippyOutput(raw, ctx.filePath, cargoDir);

    if (allDiagnostics.length === 0) {
      return {
        status: "failed",
        diagnostics: [],
        semantic: "warning",
        rawOutput: raw.substring(0, 500),
      };
    }

    const absEdited = resolve(ctx.filePath);
    const diagnostics = allDiagnostics.filter((d) => resolve(d.filePath) === absEdited);

    const hasErrors = diagnostics.some((d) => d.semantic === "blocking");
    return {
      status: hasErrors ? "failed" : "succeeded",
      diagnostics,
      semantic: hasErrors ? "blocking" : diagnostics.length > 0 ? "warning" : "none",
    };
  },
};

function findCargoToml(filePath: string): string | undefined {
  const dir = findNearestContaining(dirname(filePath), ["Cargo.toml"]);
  return dir ? join(dir, "Cargo.toml") : undefined;
}

interface ClippySpan {
  file?: string;
  file_name?: string;
  line_start?: number;
  column_start?: number;
  suggested_replacement?: string;
  suggestion_applicability?:
    | "MachineApplicable"
    | "MaybeIncorrect"
    | "HasPlaceholders"
    | "Unspecified";
}

interface ClippyMessage {
  code?: { code?: string };
  message?: string;
  level?: string;
  spans?: ClippySpan[];
}

function findMachineApplicableSpan(spans: ClippySpan[]): ClippySpan | undefined {
  return spans.find(
    (s) =>
      s.suggested_replacement !== undefined && s.suggestion_applicability === "MachineApplicable",
  );
}

export function parseClippyOutput(
  raw: string,
  fallbackPath: string,
  cargoDir?: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = raw.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.reason !== "compiler-message") continue;

      const message: ClippyMessage | undefined = msg.message;
      if (!message) continue;

      const spans = message.spans ?? [];
      const span = spans[0];
      if (!span) continue;

      const fixableSpan = findMachineApplicableSpan(spans);

      const rawFile = span.file || span.file_name;
      const filePath = rawFile
        ? cargoDir && !isAbsolute(rawFile)
          ? resolve(cargoDir, rawFile)
          : rawFile
        : fallbackPath;

      diagnostics.push({
        id: `clippy-${message.code?.code || "unknown"}`,
        message: message.message || "Clippy warning",
        filePath,
        line: span.line_start || 0,
        column: span.column_start || 0,
        severity: message.level === "error" ? "error" : "warning",
        semantic: message.level === "error" ? "blocking" : "warning",
        tool: "rust-clippy",
        rule: message.code?.code,
        defectClass: "correctness",
        fixable: fixableSpan !== undefined,
        fixSuggestion: fixableSpan?.suggested_replacement,
      });
    } catch {}
  }

  return diagnostics;
}

export default rustClippyRunner;
