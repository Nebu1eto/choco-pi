/**
 * Manual follower fallback policy (D6): what a `/compact` does after its
 * native candidate did not produce a checkpoint.
 *
 * - A cancellation (branch switch, owner change, superseding request,
 *   checkpoint change, disposal, overflow or explicit cancel) stops silently:
 *   the request is gone, and a text retry would answer a request nobody made.
 * - `auth` stops with a warning (foreground parity): the text lane uses the
 *   same login and would fail again or hide the broken credential.
 * - A disabled Anthropic lane and every other classified failure retry on the
 *   text lane, but only when the text lane is enabled for this owner and the
 *   opaque-history guard lets a local summary answer; otherwise the request
 *   stops with a warning naming the blocker.
 * - "nothing to summarize" stops with an informational notice.
 *
 * Pure: the caller supplies the status, the guard verdict and the text-lane
 * eligibility, and emits the notice.
 */
import type { CoordinatorStatus, ReasonCode } from "../background/contract.ts";
import { surfacedFailureMessage } from "../foreground-failure.ts";
import { errorText } from "./notices.ts";

export type ManualOutcome =
  | {
      readonly action: "retry-text";
      /** Folded into the final notice when the text lane answers. */
      readonly notice: string;
    }
  | {
      readonly action: "stop";
      /** Undefined: stop silently (a cancellation). */
      readonly notice?: string;
      readonly level: "info" | "warning";
    };

export interface ManualPolicyInput {
  /** Status of the coordinator after the failed candidate finished. */
  readonly status: CoordinatorStatus;
  /** A thrown wait failure, or undefined when the candidate finished normally. */
  readonly failure: unknown;
  /** The opaque-history guard forbids a local summary now. */
  readonly opaqueBlocked: boolean;
  /** A text lane is available to this owner for the retry. */
  readonly textEnabled: boolean;
  /** The failed candidate already ran on the text lane: there is nothing left to retry on. */
  readonly failedOnText?: boolean;
  /** The guard's user-facing explanation, used when `opaqueBlocked` stops the request. */
  readonly opaqueNotice?: string;
}

/** Reasons that end a request instead of failing it; never retried, journaled as `cancel`. */
export const CANCELLATIONS: ReadonlySet<string> = new Set<ReasonCode>([
  "canceled",
  "stale-prefix",
  "owner-changed",
  "manual-instructions",
  "checkpoint-changed",
  "disposed",
]);

/** Classified failures the text lane may answer instead. */
const RETRYABLE: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "no-legal-cut",
  "incompatible",
  "unsupported",
  "oversized",
  "malformed",
  "timeout",
  "429",
  "529",
  "quota",
  "cooling",
]);

export const NOTHING_TO_SUMMARIZE_NOTICE =
  "nothing to compact yet; the recent turns are kept as they are";

const DISABLED_NOTICE = "the Anthropic lane is off for this session";

function failedText(reason: string, detail: string | undefined): string {
  return `manual compaction did not produce a checkpoint (${reason}${detail ? `: ${detail}` : ""}); run /compact again`;
}

/** Whether the status describes a cancellation (stop silently). */
export function isManualCancellation(status: CoordinatorStatus): boolean {
  if (status.state !== "canceled" && status.state !== "discarded-stale") return false;
  return status.reason === undefined || CANCELLATIONS.has(status.reason);
}

/** Retry on text when guard and eligibility allow it; else stop and name the blocker. */
function retryOrBlock(input: ManualPolicyInput, notice: string, reason: string): ManualOutcome {
  if (input.failedOnText === true) {
    return { action: "stop", level: "warning", notice: failedText(reason, input.status.detail) };
  }
  if (input.opaqueBlocked) {
    return {
      action: "stop",
      level: "warning",
      notice:
        input.opaqueNotice ??
        `manual compaction did not produce a checkpoint (${reason}); the latest checkpoint is an opaque server-side record a local summary cannot replace`,
    };
  }
  if (!input.textEnabled) {
    return {
      action: "stop",
      level: "warning",
      notice: `manual compaction did not produce a checkpoint (${reason}); the text lane is off, so no local summary was made`,
    };
  }
  return { action: "retry-text", notice };
}

export function manualFallbackPolicy(input: ManualPolicyInput): ManualOutcome {
  const { status, failure } = input;
  if (failure !== undefined) {
    return {
      action: "stop",
      level: "warning",
      notice: `manual compaction failed: ${errorText(failure)}; run /compact again`,
    };
  }
  if (isManualCancellation(status)) return { action: "stop", level: "info" };
  const reason = status.reason ?? status.state;
  if (status.detail === "nothing-to-summarize") {
    return { action: "stop", level: "info", notice: NOTHING_TO_SUMMARIZE_NOTICE };
  }
  if (status.reason === "auth") {
    return { action: "stop", level: "warning", notice: surfacedFailureMessage("auth") };
  }
  if (status.reason === "disabled") {
    return retryOrBlock(input, `checkpoint made by the text lane; ${DISABLED_NOTICE}`, reason);
  }
  if (status.reason !== undefined && RETRYABLE.has(status.reason)) {
    const detail = status.detail ? `: ${status.detail}` : "";
    return retryOrBlock(
      input,
      `checkpoint made by the text lane after the Anthropic lane failed (${reason}${detail})`,
      reason,
    );
  }
  return { action: "stop", level: "warning", notice: failedText(reason, status.detail) };
}
