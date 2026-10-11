import { conditionalProperties } from "../adapter/runtime-values.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdapterState } from "../adapter/activation/state.ts";
import type { CodexRuntimePlan } from "../adapter/activation/runtime-plan.ts";
import { STATUS_KEY, buildStatusText } from "../adapter/activation/tool-set.ts";
import {
  isCanonicalCodexSubscriptionModel,
  isResponsesContext,
} from "../adapter/prompt/codex-model.ts";
import { snapshotCodexFastModeDecision } from "../providers/openai-codex/fast-mode-decision.ts";
import { snapshotCodexDaybreakDecision } from "../providers/openai-codex/daybreak-decision.ts";
import type { CodexDaybreakDecision } from "../providers/openai-codex/daybreak-types.ts";
import { isOpenAISubscriptionSignInModel } from "../adapter/openai-sign-in.ts";

export function formatDaybreakStatus(
  decision: Pick<CodexDaybreakDecision, "requested" | "outcome" | "reason">,
): string {
  if (!decision.requested) return "Daybreak off";
  if (decision.reason) return `Daybreak unavailable (${decision.reason})`;
  switch (decision.outcome) {
    case "off":
    case "pending":
      return "Daybreak pending (checking)";
    case "blue":
      return "Daybreak on";
    case "red":
      return "Daybreak on";
    case "not-granted":
      return "Daybreak requested (not granted)";
    case "model-not-supported":
      return "Daybreak unavailable (model unsupported)";
    case "auth-not-eligible":
      return "Daybreak requested (auth not eligible)";
    case "lookup-failed":
      return "Daybreak requested (lookup failed)";
  }
}

/** Disabled Fast note for status; empty unless Fast is requested but disabled with a reason. */
export function formatFastModeUnavailableStatus(decision: {
  readonly requested: boolean;
  readonly active: boolean;
  readonly reason?: string | undefined;
}): string {
  return decision.requested && !decision.active && decision.reason
    ? `Fast unavailable (${decision.reason})`
    : "";
}

export function renderCodexStatus(
  ctx: ExtensionContext,
  state: AdapterState,
  plan: Extract<CodexRuntimePlan, { kind: "normal" | "code" | "notebook" }>,
): void {
  const config = state.config;
  const signIn = isOpenAISubscriptionSignInModel(ctx.model, ctx.modelRegistry);
  const daybreak = snapshotCodexDaybreakDecision(
    ctx.sessionManager.getSessionId(),
    ctx.model,
    signIn,
  );
  const fast = ctx.model
    ? snapshotCodexFastModeDecision(
        ctx.sessionManager.getSessionId(),
        ctx.model,
        config.openai.fast === true,
        signIn,
      )
    : undefined;
  const fastActive = fast?.active ?? false;
  const fastNote = fast ? formatFastModeUnavailableStatus(fast) : "";
  // Sign-in Daybreak is shown only while requested, so an unrequested toggle adds no noise.
  const daybreakNote = isCanonicalCodexSubscriptionModel(ctx.model)
    ? formatDaybreakStatus(daybreak)
    : daybreak.reason
      ? formatDaybreakStatus(daybreak)
      : "";
  if (!ctx.hasUI) return;
  if (!state.config.ui.statusLine) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  ctx.ui.setStatus(
    STATUS_KEY,
    buildStatusText(
      {
        mode: plan.kind,
        useOnAllModels: config.scope.allProviders === "on",
        additionalProvider: plan.configuredProvider,
        fast: fastActive,
        webSearch: plan.toolNames.includes("web_run"),
        imageGeneration: plan.toolNames.includes("imagegen"),
        compaction: plan.nativeCompaction,
        weeklyUsageLeft: state.weeklyUsageLeft,
        ...conditionalProperties(Boolean(isResponsesContext(ctx)), {
          verbosity: config.openai.verbosity,
        }),
      },
      ctx.ui.theme,
    ) +
      (fastNote ? ctx.ui.theme.fg("dim", ` • ${fastNote}`) : "") +
      (daybreakNote ? ctx.ui.theme.fg("dim", ` • ${daybreakNote}`) : ""),
  );
}
