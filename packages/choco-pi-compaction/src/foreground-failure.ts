import type { SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";

import type { FailureReason } from "./background/contract.ts";

export type SurfacedForegroundFailure = Extract<FailureReason, "canceled" | "auth">;

export function surfacesForegroundFailure(
  reason: FailureReason | "no-capture",
): reason is SurfacedForegroundFailure {
  return reason === "canceled" || reason === "auth";
}

export const SURFACED_FAILURE_RESULT: SessionBeforeCompactResult = Object.freeze({
  cancel: true,
});

export function surfacedFailureMessage(reason: SurfacedForegroundFailure): string {
  return reason === "canceled"
    ? "compaction was cancelled; no local summary was made."
    : "the provider rejected or could not resolve the credentials (auth); compaction failed instead of falling back to the local summarizer, which uses the same login.";
}
