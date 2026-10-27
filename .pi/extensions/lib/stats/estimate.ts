/**
 * Throughput estimated from request timing alone.
 *
 * Pi persists each assistant message's request duration and output tokens but
 * (until this profile's timing recorder ran) not when the first token arrived.
 * Over many calls of one model, duration = TTFT + output / tok/s, so a robust
 * line fit recovers both: the slope is seconds per token, the intercept the
 * time to first token. Theil-Sen (median of pairwise slopes) is used because
 * tool-heavy sessions carry outliers that would drag a least-squares fit.
 */

export type SpeedSample = {
  /** Output tokens of the call. */
  output: number;
  /** Whole-request duration in ms. */
  durationMs: number;
};

export type SpeedEstimate = {
  /** Calls the fit used. */
  samples: number;
  tokPerSec: number;
  ttftMs: number;
  /** Fewer than MIN_CONFIDENT_SAMPLES calls: the figures are indicative only. */
  lowConfidence: boolean;
};

/** Fewer calls than this give no estimate at all. */
export const MIN_ESTIMATE_SAMPLES = 5;
/** Fewer calls than this mark the estimate low confidence. */
export const MIN_CONFIDENT_SAMPLES = 25;
/** Pairwise slopes are quadratic in the sample; larger samples are thinned to about this many points. */
const MAX_FIT_POINTS = 450;

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * Fit duration = ttft + output * slope. Undefined when the sample is too
 * small, has no two distinct output counts, or the slope is not positive
 * (durations that do not grow with output carry no throughput signal).
 */
export function estimateSpeed(samples: readonly SpeedSample[]): SpeedEstimate | undefined {
  const usable = samples.filter(
    (sample) =>
      Number.isFinite(sample.output) &&
      Number.isFinite(sample.durationMs) &&
      sample.output > 0 &&
      sample.durationMs > 0,
  );
  if (usable.length < MIN_ESTIMATE_SAMPLES) return undefined;
  const step = Math.max(1, Math.floor(usable.length / MAX_FIT_POINTS));
  const thinned = usable.filter((_, index) => index % step === 0);
  const slopes: number[] = [];
  for (let i = 0; i < thinned.length; i += 1) {
    const a = thinned[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < thinned.length; j += 1) {
      const b = thinned[j];
      if (b === undefined || b.output === a.output) continue;
      slopes.push((b.durationMs - a.durationMs) / (b.output - a.output));
    }
  }
  const slope = median(slopes);
  if (slope === undefined || !(slope > 0)) return undefined;
  const ttft = median(usable.map((sample) => sample.durationMs - slope * sample.output));
  if (ttft === undefined) return undefined;
  return {
    samples: usable.length,
    tokPerSec: 1000 / slope,
    ttftMs: Math.max(0, ttft),
    lowConfidence: usable.length < MIN_CONFIDENT_SAMPLES,
  };
}
