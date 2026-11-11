/** Bounds that keep the diff pane cheap on large or slow repositories. */
export type DiffLimits = {
  /** Files listed in a snapshot; the rest are counted in `omittedFiles`. */
  maxFiles: number;
  /** Largest file body `loadFile` reads; larger files report "too-large". */
  maxFileBytes: number;
  /** Untracked files read for line counts per refresh; beyond this, counts are null. */
  maxUntrackedReads: number;
  /** Deadline for every git call. */
  timeoutMs: number;
  /** Largest stdout accepted from one git call. */
  maxOutputBytes: number;
  /** Delay between a refresh request and the refresh it schedules. */
  debounceMs: number;
  /** Interval between change probes while the pane is visible. */
  pollIntervalMs: number;
  /** A refresh taking at least this long lengthens debounce and polling. */
  slowRefreshMs: number;
  /** Upper bound for the debounce and poll multiplier. */
  maxBackoffFactor: number;
};

export const DEFAULT_DIFF_LIMITS: DiffLimits = {
  maxFiles: 500,
  maxFileBytes: 1024 * 1024,
  maxUntrackedReads: 200,
  timeoutMs: 5_000,
  maxOutputBytes: 32 * 1024 * 1024,
  debounceMs: 150,
  pollIntervalMs: 3_000,
  slowRefreshMs: 1_000,
  maxBackoffFactor: 8,
};

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Apply defaults, ignoring negative or non-finite overrides. */
export function resolveDiffLimits(overrides: Partial<DiffLimits> = {}): DiffLimits {
  return {
    maxFiles: Math.floor(positive(overrides.maxFiles, DEFAULT_DIFF_LIMITS.maxFiles)),
    maxFileBytes: positive(overrides.maxFileBytes, DEFAULT_DIFF_LIMITS.maxFileBytes),
    maxUntrackedReads: Math.floor(
      positive(overrides.maxUntrackedReads, DEFAULT_DIFF_LIMITS.maxUntrackedReads),
    ),
    timeoutMs: positive(overrides.timeoutMs, DEFAULT_DIFF_LIMITS.timeoutMs),
    maxOutputBytes: positive(overrides.maxOutputBytes, DEFAULT_DIFF_LIMITS.maxOutputBytes),
    debounceMs: positive(overrides.debounceMs, DEFAULT_DIFF_LIMITS.debounceMs),
    pollIntervalMs: positive(overrides.pollIntervalMs, DEFAULT_DIFF_LIMITS.pollIntervalMs),
    slowRefreshMs: positive(overrides.slowRefreshMs, DEFAULT_DIFF_LIMITS.slowRefreshMs),
    maxBackoffFactor: Math.max(
      1,
      positive(overrides.maxBackoffFactor, DEFAULT_DIFF_LIMITS.maxBackoffFactor),
    ),
  };
}
