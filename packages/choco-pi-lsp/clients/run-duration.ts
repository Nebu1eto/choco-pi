import { isFiniteNumber } from "./runtime-guards.ts";

export function isMeasuredDuration(duration: number | null | undefined): duration is number {
  return isFiniteNumber(duration) && Number.isFinite(duration) && duration >= 0;
}

export function toMeasuredDurationMs(duration: number): number | undefined {
  return isMeasuredDuration(duration) ? Math.round(duration) : undefined;
}

export function formatRunDurationMs(duration: number | null | undefined): string {
  return isMeasuredDuration(duration) ? `${Math.round(duration)}ms` : "unmeasured";
}
