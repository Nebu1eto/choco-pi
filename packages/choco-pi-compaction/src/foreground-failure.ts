/**
 * Which failures of a provider-native foreground compaction (Anthropic or xAI
 * server-side) surface to the host instead of falling through to the local
 * summarizer.
 *
 * Falling through is right when the native path cannot represent this
 * compaction but the local summarizer can: not configured, not admitted
 * (unsupported model, endpoint or auth mode), the capability gate cooling
 * down, no usable capture or legal cut, or a provider-side refusal or outage
 * the session model may still answer.
 *
 * Two classes must not be papered over by a local summary:
 *
 * - `canceled`: the host aborted this compaction (`abortCompaction`, Escape).
 *   Summarizing anyway would ignore the user's cancellation.
 * - `auth`: the provider rejected or could not resolve the credentials. The
 *   local summarizer calls the same provider with the same credentials, so a
 *   silent fallback either fails again or hides the broken login.
 *
 * A surfaced failure answers `session_before_compact` with `{ cancel: true }`.
 * The host then fails the compaction ("Compaction cancelled") and emits
 * `session_compact_failed`; a thrown error would not, because the extension
 * runner contains handler errors and runs Pi's default summarizer instead.
 */
import type { SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";

import type { FailureReason } from "./background/contract.ts";

export type SurfacedForegroundFailure = Extract<FailureReason, "canceled" | "auth">;

export function surfacesForegroundFailure(
  reason: FailureReason | "no-capture",
): reason is SurfacedForegroundFailure {
  return reason === "canceled" || reason === "auth";
}

/** The host-visible answer for a surfaced failure. */
export const SURFACED_FAILURE_RESULT: SessionBeforeCompactResult = Object.freeze({
  cancel: true,
});

/** User-facing description of a surfaced failure. */
export function surfacedFailureMessage(reason: SurfacedForegroundFailure): string {
  return reason === "canceled"
    ? "compaction was cancelled; no local summary was made."
    : "the provider rejected or could not resolve the credentials (auth); compaction failed instead of falling back to the local summarizer, which uses the same login.";
}
