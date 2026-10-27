import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateSpeed,
  MIN_CONFIDENT_SAMPLES,
  MIN_ESTIMATE_SAMPLES,
  type SpeedSample,
} from "../.pi/extensions/lib/stats/estimate.ts";

/** Deterministic pseudo-random numbers so the fixture is stable across runs. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function synthetic(
  count: number,
  ttftMs: number,
  tokPerSec: number,
  jitterMs: number,
  seed = 7,
): SpeedSample[] {
  const random = lcg(seed);
  return Array.from({ length: count }, () => {
    const output = 20 + Math.floor(random() * 2000);
    const noise = (random() - 0.5) * 2 * jitterMs;
    return { output, durationMs: ttftMs + (output / tokPerSec) * 1000 + noise };
  });
}

test("the fit recovers a known TTFT and tok/s within tolerance", () => {
  const estimate = estimateSpeed(synthetic(200, 1500, 80, 150));
  assert.ok(estimate);
  assert.equal(estimate.samples, 200);
  assert.equal(estimate.lowConfidence, false);
  assert.ok(Math.abs(estimate.tokPerSec - 80) / 80 < 0.05, `tok/s ${estimate.tokPerSec}`);
  assert.ok(Math.abs(estimate.ttftMs - 1500) < 150, `ttft ${estimate.ttftMs}`);
});

test("outliers do not drag the fit", () => {
  const samples = synthetic(120, 1000, 100, 50);
  // A fifth of the calls stalled for minutes (tool-heavy turns, rate limits).
  const polluted = samples.map((sample, index) =>
    index % 5 === 0 ? { ...sample, durationMs: sample.durationMs + 120_000 } : sample,
  );
  const estimate = estimateSpeed(polluted);
  assert.ok(estimate);
  assert.ok(Math.abs(estimate.tokPerSec - 100) / 100 < 0.1, `tok/s ${estimate.tokPerSec}`);
  assert.ok(Math.abs(estimate.ttftMs - 1000) < 300, `ttft ${estimate.ttftMs}`);
});

test("no estimate when the slope is not positive, the sample is tiny, or outputs never differ", () => {
  const flat = Array.from({ length: 40 }, (_, i) => ({ output: 10 + i * 10, durationMs: 3000 }));
  assert.equal(estimateSpeed(flat), undefined, "a constant duration carries no throughput");
  const falling = Array.from({ length: 40 }, (_, i) => ({
    output: 10 + i * 10,
    durationMs: 5000 - i * 50,
  }));
  assert.equal(estimateSpeed(falling), undefined, "a negative slope is not a rate");
  assert.equal(estimateSpeed(synthetic(MIN_ESTIMATE_SAMPLES - 1, 1000, 50, 0)), undefined);
  const same = Array.from({ length: 30 }, () => ({ output: 100, durationMs: 2000 }));
  assert.equal(estimateSpeed(same), undefined, "one output count gives no slope");
});

test("small samples are marked low confidence and bad samples are dropped", () => {
  const few = synthetic(MIN_CONFIDENT_SAMPLES - 1, 800, 60, 0);
  const estimate = estimateSpeed([
    ...few,
    { output: 0, durationMs: 100 },
    { output: 50, durationMs: 0 },
    { output: Number.NaN, durationMs: 100 },
  ]);
  assert.ok(estimate);
  assert.equal(estimate.samples, MIN_CONFIDENT_SAMPLES - 1);
  assert.equal(estimate.lowConfidence, true);
  assert.ok(Math.abs(estimate.tokPerSec - 60) < 0.5);
  assert.ok(Math.abs(estimate.ttftMs - 800) < 1);
});

test("large samples are thinned for the pairwise slopes but still fit", () => {
  const estimate = estimateSpeed(synthetic(3000, 1200, 120, 100, 11));
  assert.ok(estimate);
  assert.equal(estimate.samples, 3000);
  assert.ok(Math.abs(estimate.tokPerSec - 120) / 120 < 0.05);
  assert.ok(Math.abs(estimate.ttftMs - 1200) < 100);
});
