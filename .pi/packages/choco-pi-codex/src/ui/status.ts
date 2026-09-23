import { conditionalProperties } from "../adapter/runtime-values.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdapterState } from "../adapter/activation/state.ts";
import type { CodexRuntimePlan } from "../adapter/activation/runtime-plan.ts";
import { STATUS_KEY, buildStatusText } from "../adapter/activation/tool-set.ts";
import { isResponsesContext } from "../adapter/prompt/codex-model.ts";
import { snapshotCodexFastModeDecision } from "../providers/openai-codex/fast-mode-decision.ts";

export function renderCodexStatus(
  ctx: ExtensionContext,
  state: AdapterState,
  plan: Extract<CodexRuntimePlan, { kind: "normal" | "code" | "notebook" }>,
): void {
  const config = state.config;
  const fastActive = ctx.model
    ? snapshotCodexFastModeDecision(
        ctx.sessionManager.getSessionId(),
        ctx.model,
        config.openai.fast === true,
      ).active
    : false;
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
    ),
  );
}
