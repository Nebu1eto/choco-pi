import { availableParallelism } from "node:os";

/** Keep always-on Opengrep scans responsive unless the user opts in to more work. */
export const DEFAULT_OPENGREP_JOBS = 2;

/**
 * Cap explicit overrides at the host's available parallelism, never below the
 * two-worker default. The CLI previously inherited Opengrep's detected core
 * count (14 on the review host), while the LSP path explicitly requested 16.
 */
export const MAX_OPENGREP_JOBS = Math.max(DEFAULT_OPENGREP_JOBS, availableParallelism());

/**
 * CHOCO_PI_LSP_OPENGREP_JOBS accepts decimal digits with optional surrounding
 * whitespace. Invalid and non-positive values use the default; larger values
 * are clamped to the host's available parallelism. This sets the built-in
 * CLI/LSP value only, so a serverOverrides initializationOptions value still
 * wins when the LSP configuration is merged.
 */
export function resolveOpengrepJobs(env: NodeJS.ProcessEnv = process.env): number {
  const rawJobs = env.CHOCO_PI_LSP_OPENGREP_JOBS?.trim() ?? "";
  if (!/^[0-9]+$/.test(rawJobs)) return DEFAULT_OPENGREP_JOBS;
  const jobs = Number(rawJobs);
  if (!Number.isSafeInteger(jobs) || jobs <= 0) return DEFAULT_OPENGREP_JOBS;
  return Math.min(jobs, MAX_OPENGREP_JOBS);
}

export function buildOpengrepScanArgs(options: {
  configArg: string;
  reportPath: string;
  cwd: string;
  excludeNames: readonly string[];
  jobs?: number;
}): string[] {
  return [
    "scan",
    "--config",
    options.configArg,
    "--jobs",
    String(options.jobs ?? resolveOpengrepJobs()),
    "--json",
    "--json-output",
    options.reportPath,
    // Never fail the scan on findings — this is a read, not a gate
    // (matches gitleaks's `--exit-code 0` intent).
    "--no-error",
    "--quiet",
    "--disable-version-check",
    // Opengrep's own `.gitignore` respect does not cover an unignored scratch
    // tree. Callers pass the shared EXCLUDED_DIRS-derived names so the security
    // scanners cannot drift apart.
    ...options.excludeNames.flatMap((name) => ["--exclude", name]),
    options.cwd,
  ];
}

export type OpengrepInitialization = {
  scan: { configuration: string[]; onlyGitDirty: false; jobs: number };
  metrics: { enabled: false };
  doHover: false;
};

export function buildOpengrepInitialization(
  configArg: string,
  jobs = resolveOpengrepJobs(),
): OpengrepInitialization {
  return {
    scan: {
      configuration: [configArg],
      onlyGitDirty: false,
      jobs,
    },
    metrics: { enabled: false },
    doHover: false,
  };
}
