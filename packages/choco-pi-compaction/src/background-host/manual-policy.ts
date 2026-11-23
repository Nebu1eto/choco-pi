import type { CoordinatorStatus, ReasonCode } from "../background/contract.ts";
import { surfacedFailureMessage } from "../foreground-failure.ts";
import { errorText } from "./notices.ts";

export type ManualOutcome =
  | {
      readonly action: "retry-text";
      readonly notice: string;
    }
  | {
      readonly action: "stop";
      readonly notice?: string;
      readonly level: "info" | "warning";
    };

export interface ManualPolicyInput {
  readonly status: CoordinatorStatus;
  readonly failure: unknown;
  readonly opaqueBlocked: boolean;
  readonly textEnabled: boolean;
  readonly failedOnText?: boolean;
  readonly opaqueNotice?: string;
}

export const CANCELLATIONS: ReadonlySet<string> = new Set<ReasonCode>([
  "canceled",
  "stale-prefix",
  "owner-changed",
  "manual-instructions",
  "checkpoint-changed",
  "disposed",
]);

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

export function isManualCancellation(status: CoordinatorStatus): boolean {
  if (status.state !== "canceled" && status.state !== "discarded-stale") return false;
  return status.reason === undefined || CANCELLATIONS.has(status.reason);
}

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
