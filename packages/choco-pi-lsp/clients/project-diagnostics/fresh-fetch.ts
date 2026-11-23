import { type RuntimeValue, isRuntimeString } from "../../tools/runtime-values.ts";

import * as path from "node:path";
import type { BootstrapClients } from "../bootstrap.ts";
import type { CacheManager } from "../cache-manager.ts";
import type { RuntimeCoordinator } from "../runtime-coordinator.ts";
import { applyDispositionsMultiFile } from "../diagnostic-dispositions.ts";
import { isAtOrAboveHomeDir } from "../path-utils.ts";
import { reasonFromAvailabilityVerdict } from "./extractors.ts";
import { opengrepResultToProjectDiagnostics } from "./runner-adapters/opengrep.ts";
import type { TestRunnerFindingsCache } from "./runner-adapters/runner-findings.ts";
import { testRunnerFindingsToProjectDiagnostics } from "./runner-adapters/runner-findings.ts";
import type { ProjectDiagnostic } from "./types.ts";
import type { FailedProjectAnalyzer } from "./extractors.ts";

export interface FreshProjectDiagnosticsResult {
  diagnostics: ProjectDiagnostic[];
  runners: string[];
  cold: string[];
  coldReasons?: Record<string, string>;
  cachedAgeMs?: Record<string, number>;
  failed: FailedProjectAnalyzer[];
  timings: Record<string, number>;
  aborted?: boolean;
  abortedIds?: string[];
  unsafeRoot?: boolean;
  dispositionSuppressed?: number;
  dispositionSuppressedByLane?: Record<string, number>;
}

export const ANALYZER_IDS = ["opengrep", "test-runner"] as const;

function pushUnique(list: string[], id: string): void {
  if (!list.includes(id)) list.push(id);
}

export async function fetchFreshProjectDiagnostics(
  cacheManager: CacheManager,
  cwd: string,
  clients: BootstrapClients,
  signal?: AbortSignal,
  options: { homeDir?: string; runtime?: RuntimeCoordinator } = {},
): Promise<FreshProjectDiagnosticsResult> {
  const analysisRoot = path.resolve(cwd);
  const unsafeRootReason =
    "the working directory resolves at or above the home directory; heavyweight analyzers refuse to walk from there (#747)";
  if (isAtOrAboveHomeDir(analysisRoot, options.homeDir)) {
    return {
      diagnostics: [],
      runners: [],
      cold: [...ANALYZER_IDS],
      coldReasons: Object.fromEntries(ANALYZER_IDS.map((id) => [id, unsafeRootReason])),
      failed: [],
      timings: {},
      unsafeRoot: true,
    };
  }
  const diagnostics: ProjectDiagnostic[] = [];
  const runners: string[] = [];
  const cold: string[] = [];
  const coldReasons: Record<string, string> = {};
  const failed: FailedProjectAnalyzer[] = [];
  const timings: Record<string, number> = {};
  const cachedAgeMs: Record<string, number> = {};
  const settledIds = new Set<string>();
  let dispositionSuppressed = 0;
  const dispositionSuppressedByLane: Record<string, number> = {};

  function markCold(id: string, reason: string): void {
    pushUnique(cold, id);
    coldReasons[id] = reason;
  }

  function record(id: string, adapted: ProjectDiagnostic[], elapsedMs: number): void {
    timings[id] = (timings[id] ?? 0) + elapsedMs;
    const kept = applyDispositionsMultiFile(adapted, analysisRoot, (d) => d.filePath);
    const suppressedHere = adapted.length - kept.length;
    dispositionSuppressed += suppressedHere;
    if (suppressedHere > 0) {
      dispositionSuppressedByLane[id] = (dispositionSuppressedByLane[id] ?? 0) + suppressedHere;
    }
    if (kept.length > 0) {
      diagnostics.push(...kept);
      pushUnique(runners, id);
    }
  }

  interface AnalyzerFailureResult {
    summary?: RuntimeValue;
  }

  function recordFailed(id: string, result: AnalyzerFailureResult): void {
    failed.push({
      id,
      summary:
        "summary" in result && isRuntimeString(result.summary)
          ? result.summary
          : "analyzer reported an unsuccessful run",
    });
  }

  function task(id: string, run: () => Promise<void>): Promise<void> {
    return run().finally(() => settledIds.add(id));
  }

  const tasks: Promise<void>[] = [
    task("opengrep", async () => {
      if (!(await clients.opengrepClient.ensureAvailable())) {
        markCold(
          "opengrep",
          reasonFromAvailabilityVerdict(
            "opengrep",
            clients.opengrepClient.getAvailabilityVerdict?.(),
          ),
        );
        return;
      }
      const startMs = Date.now();
      const result = await clients.opengrepClient.scan(analysisRoot);
      if (!result.success) {
        recordFailed("opengrep", result);
        return;
      }
      cacheManager.writeCache("opengrep", result, analysisRoot, {
        scanDurationMs: Date.now() - startMs,
      });
      record(
        "opengrep",
        opengrepResultToProjectDiagnostics(analysisRoot, result),
        Date.now() - startMs,
      );
    }),

    task("test-runner", async () => {
      const startMs = Date.now();
      const cached = cacheManager.readCache<TestRunnerFindingsCache>(
        "test-runner-findings",
        analysisRoot,
      );
      if (!cached?.data) {
        markCold("test-runner", "no turn_end test-runner cache entry yet this session");
        return;
      }
      cachedAgeMs["test-runner"] = Date.now() - new Date(cached.meta.timestamp).getTime();
      record(
        "test-runner",
        testRunnerFindingsToProjectDiagnostics(cached.data, analysisRoot, options.runtime),
        Date.now() - startMs,
      );
    }),
  ];

  const allSettled = Promise.all(tasks)
    .then(() => "completed" as const)
    .catch(() => "completed" as const);

  const outcome = signal
    ? await Promise.race([
        allSettled,
        new Promise<"aborted">((resolve) => {
          if (signal.aborted) {
            resolve("aborted");
            return;
          }
          signal.addEventListener("abort", () => resolve("aborted"), {
            once: true,
          });
        }),
      ])
    : await allSettled;

  if (outcome === "aborted") {
    const abortedIds = ANALYZER_IDS.filter((id) => !settledIds.has(id));
    for (const id of abortedIds) pushUnique(cold, id);
    return {
      diagnostics,
      runners,
      cold,
      coldReasons,
      failed,
      timings,
      cachedAgeMs,
      aborted: true,
      abortedIds,
      dispositionSuppressed,
      dispositionSuppressedByLane,
    };
  }

  return {
    diagnostics,
    runners,
    cold,
    coldReasons,
    failed,
    timings,
    cachedAgeMs,
    dispositionSuppressed,
    dispositionSuppressedByLane,
  };
}
