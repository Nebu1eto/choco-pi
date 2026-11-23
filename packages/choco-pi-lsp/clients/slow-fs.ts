import { BoundedLruCache } from "./bounded-cache.ts";

import * as fs from "node:fs";
import * as path from "node:path";
import { toPositiveFinite } from "./env-utils.ts";
import { normalizeFilePath } from "./path-utils.ts";

export const DEFAULT_SLOW_FS_THRESHOLD_US = 500;

const PROBE_SAMPLE_CAP = 15;

export interface SlowFsProbeResult {
  slow: boolean;
  medianStatMicros: number;
  samples: number;
}

function resolveThresholdMicros(): number {
  const envValue = toPositiveFinite(process.env.CHOCO_PI_LSP_SLOW_FS_THRESHOLD_US);
  return envValue > 0 ? envValue : DEFAULT_SLOW_FS_THRESHOLD_US;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function probeSlowFs(rootDir: string): SlowFsProbeResult {
  try {
    const resolvedRoot = path.resolve(rootDir);
    const entries = fs.readdirSync(resolvedRoot).slice(0, PROBE_SAMPLE_CAP);
    if (entries.length === 0) {
      return { slow: false, medianStatMicros: 0, samples: 0 };
    }

    const samplesMicros: number[] = [];
    for (const entry of entries) {
      const fullPath = path.join(resolvedRoot, entry);
      const startedAt = process.hrtime.bigint();
      try {
        fs.statSync(fullPath);
      } catch {
        continue;
      }
      const elapsedNs = process.hrtime.bigint() - startedAt;
      samplesMicros.push(Number(elapsedNs) / 1000);
    }

    if (samplesMicros.length === 0) {
      return { slow: false, medianStatMicros: 0, samples: 0 };
    }

    const medianStatMicros = median(samplesMicros);
    const threshold = resolveThresholdMicros();
    return {
      slow: medianStatMicros > threshold,
      medianStatMicros,
      samples: samplesMicros.length,
    };
  } catch {
    return { slow: false, medianStatMicros: 0, samples: 0 };
  }
}

const slowFsVerdictCache = new BoundedLruCache<string, SlowFsProbeResult>(32);

export function getSlowFsVerdict(cwd: string): SlowFsProbeResult {
  if (process.env.CHOCO_PI_LSP_ALLOW_SLOW_FS_SCAN === "1") {
    return { slow: false, medianStatMicros: 0, samples: 0 };
  }
  if (process.env.CHOCO_PI_LSP_FORCE_SLOW_FS === "1") {
    return { slow: true, medianStatMicros: 0, samples: 0 };
  }

  const key = normalizeFilePath(path.resolve(cwd));
  const cached = slowFsVerdictCache.get(key);
  if (cached) return cached;

  const result = probeSlowFs(cwd);
  slowFsVerdictCache.set(key, result);
  return result;
}

export function isSlowFs(cwd: string): boolean {
  return getSlowFsVerdict(cwd).slow;
}

export function _resetSlowFsForTests(): void {
  slowFsVerdictCache.clear();
}

export const SLOW_FS_REDUCED_MAX_FILES = 500;

export function slowFsDegradationNotice(): string {
  return "slow filesystem detected (set CHOCO_PI_LSP_ALLOW_SLOW_FS_SCAN=1 to override)";
}
