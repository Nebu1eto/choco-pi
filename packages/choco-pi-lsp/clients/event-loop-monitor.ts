import { logExtension } from "./extension-log.ts";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

const NS_PER_MS = 1e6;
const US_PER_MS = 1e3;

let histogram: IntervalHistogram | undefined;
let monitorUnavailable = false;

let windowStartWallMs = 0;
let windowStartCpuMs = 0;

const cpuTotalMs = (): number => {
  const c = process.cpuUsage();
  return (c.user + c.system) / US_PER_MS;
};

export function startEventLoopMonitor(resolutionMs = 20): void {
  if (histogram || monitorUnavailable) return;
  try {
    const h = monitorEventLoopDelay({ resolution: resolutionMs });
    h.enable();
    histogram = h;
    windowStartWallMs = Date.now();
    windowStartCpuMs = cpuTotalMs();
  } catch (err) {
    monitorUnavailable = true;
    logExtension({
      subsystem: "event-loop-monitor",
      message: `event-loop occupancy telemetry disabled (runtime lacks monitorEventLoopDelay): ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

export interface EventLoopStats {
  maxMs: number;
  p99Ms: number;
  meanMs: number;
  windowWallMs: number;
  windowCpuMs: number;
  suspectSystemStall: boolean;
}

const safeMs = (ns: number): number =>
  Number.isFinite(ns) ? Math.round((ns / NS_PER_MS) * 10) / 10 : 0;

export function isSuspendSuspectedBlock(
  maxMs: number,
  windowCpuMs: number,
  floorMs = 20000,
  slopMs = 1000,
): boolean {
  if (maxMs < floorMs) return false;
  return windowCpuMs + slopMs < maxMs;
}

export function getEventLoopStats(): EventLoopStats | undefined {
  if (!histogram) return undefined;
  const maxMs = safeMs(histogram.max);
  const windowWallMs = Math.max(0, Date.now() - windowStartWallMs);
  const windowCpuMs = Math.max(0, cpuTotalMs() - windowStartCpuMs);
  return {
    maxMs,
    p99Ms: safeMs(histogram.percentile(99)),
    meanMs: safeMs(histogram.mean),
    windowWallMs: Math.round(windowWallMs),
    windowCpuMs: Math.round(windowCpuMs),
    suspectSystemStall: isSuspendSuspectedBlock(maxMs, windowCpuMs),
  };
}

export function resetEventLoopMonitor(): void {
  histogram?.reset();
  windowStartWallMs = Date.now();
  windowStartCpuMs = cpuTotalMs();
}

export function shouldLogWorstBlock(
  maxMs: number,
  lastLoggedMs: number,
  minMs = 60,
  deltaMs = 25,
): boolean {
  return maxMs >= minMs && maxMs > lastLoggedMs + deltaMs;
}

export function shouldLogLoopBlock(maxMs: number, minMs = 60): boolean {
  return maxMs >= minMs;
}

export function _stopEventLoopMonitorForTest(): void {
  histogram?.disable();
  histogram = undefined;
  monitorUnavailable = false;
  windowStartWallMs = 0;
  windowStartCpuMs = 0;
}
