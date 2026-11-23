import { availableParallelism } from "node:os";

export const DEFAULT_OPENGREP_JOBS = 2;

export const MAX_OPENGREP_JOBS = Math.max(DEFAULT_OPENGREP_JOBS, availableParallelism());

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
    "--no-error",
    "--quiet",
    "--disable-version-check",
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
