export type SpeedSample = {
  output: number;
  durationMs: number;
};

export type SpeedEstimate = {
  samples: number;
  tokPerSec: number;
  ttftMs: number;
  lowConfidence: boolean;
};

export const MIN_ESTIMATE_SAMPLES = 5;
export const MIN_CONFIDENT_SAMPLES = 25;
const MAX_FIT_POINTS = 450;

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

export function estimateSpeed(
  samples: readonly SpeedSample[],
  maxPoints = MAX_FIT_POINTS,
): SpeedEstimate | undefined {
  const usable = samples.filter(
    (sample) =>
      Number.isFinite(sample.output) &&
      Number.isFinite(sample.durationMs) &&
      sample.output > 0 &&
      sample.durationMs > 0,
  );
  if (usable.length < MIN_ESTIMATE_SAMPLES) return undefined;
  const step = Math.max(1, Math.floor(usable.length / Math.max(MIN_ESTIMATE_SAMPLES, maxPoints)));
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
