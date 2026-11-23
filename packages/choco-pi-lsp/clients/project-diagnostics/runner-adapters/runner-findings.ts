import { includePropertiesWhen } from "../../optional-properties.ts";
import type { TestFailure, TestResult } from "../../test-runner-client.ts";
import type { ProjectDiagnostic } from "../types.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeCoordinator } from "../../runtime-coordinator.ts";
import {
  advisoryPathKey,
  validateAdvisoryProvenance,
  type AdvisoryProvenance,
} from "../../advisory-provenance.ts";

export interface TestRunnerFindingsCache {
  content: string;
  stale?: boolean;
  results?: TestResult[];
  testRunGeneration?: number;
  launchedFrom?: AdvisoryProvenance;
  publishedAgainst?: AdvisoryProvenance;
  provenance?: AdvisoryProvenance;
  superseded?: boolean;
}

function failureMessage(failure: TestFailure): string {
  const firstLine = failure.message.split("\n")[0]?.slice(0, 300) ?? "";
  return firstLine ? `${failure.name}: ${firstLine}` : failure.name;
}

const LOCATION_LINE_COL_RE = /:(\d+)(?::(\d+))?$/;

function parseLocation(location: string | undefined) {
  if (!location) return {};
  const match = LOCATION_LINE_COL_RE.exec(location);
  if (!match) return {};
  return {
    line: Number.parseInt(match[1], 10),
    ...includePropertiesWhen(match[2], () => ({ column: Number.parseInt(match[2], 10) })),
  };
}

export function testResultToProjectDiagnostics(
  result: TestResult,
  stale = false,
): ProjectDiagnostic[] {
  if (result.failed === 0 && !result.error) return [];
  const stalePrefix = stale ? "[stale — from a prior turn] " : "";

  if (result.failures.length > 0) {
    return result.failures.map((failure) => ({
      filePath: result.file,
      ...parseLocation(failure.location),
      severity: "error",
      semantic: "blocking",
      tool: "test-runner",
      runner: result.runner,
      rule: `test:${result.runner}`,
      message: `${stalePrefix}${failureMessage(failure)}`,
      source: "project-scan",
    }));
  }

  return [
    {
      filePath: result.file,
      severity: "error",
      semantic: "blocking",
      tool: "test-runner",
      runner: result.runner,
      rule: `test:${result.runner}`,
      message: `${stalePrefix}${
        result.error ? `Test run error: ${result.error}` : `${result.failed} test(s) failed`
      }`,
      source: "project-scan",
    },
  ];
}

export function testRunnerFindingsToProjectDiagnostics(
  cache: TestRunnerFindingsCache,
  cwd?: string,
  runtime?: RuntimeCoordinator,
): ProjectDiagnostic[] {
  if (!cache.results || cache.results.length === 0) return [];
  const validation = cwd
    ? validateAdvisoryProvenance(cache, cwd, runtime)
    : { status: "unknown" as const, reasons: ["validation-context-missing"] };
  const root = cwd ?? process.cwd();
  const missingKeys = new Set(
    (cache.provenance?.files ?? [])
      .filter((file) => !fs.existsSync(path.resolve(root, file.path)))
      .map((file) => advisoryPathKey(file.path, root)),
  );
  const historical =
    cache.superseded === true || cache.stale === true || validation.status !== "current";
  return cache.results
    .filter((result) => !missingKeys.has(advisoryPathKey(result.file, root)))
    .flatMap((result) => testResultToProjectDiagnostics(result, historical))
    .map((diagnostic) =>
      historical
        ? {
            ...diagnostic,
            severity: "info" as const,
            semantic: "none" as const,
            message: diagnostic.message.startsWith("[stale")
              ? diagnostic.message
              : `[historical — re-run to confirm] ${diagnostic.message}`,
          }
        : diagnostic,
    );
}
