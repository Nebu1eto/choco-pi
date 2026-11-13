import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { copyTextToClipboard, type ClipboardCopyResult } from "./clipboard.ts";
import { formatGoalSummary } from "./format.ts";
import type { GoalStartTurnStrategy } from "./recovery-machine.ts";
import { compactContinuationPrompt, goalObjectivePrompt } from "./prompts.ts";
import { updateGoalStatus } from "./state.ts";
import type { GoalEntrySource, ThreadGoal } from "./types.ts";

export interface CommandHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: GoalCommandContext): void;
  clearGoal(source: GoalEntrySource, ctx: GoalCommandContext): void;
  cancelProviderLimitAutoResume(goalId: string, ctx: GoalCommandContext): void;
  getGoalStartTurnStrategy(): GoalStartTurnStrategy;
  resumeGoalWithContinuation(
    goalId: string,
    source: GoalEntrySource,
    ctx: GoalCommandContext,
  ): { ok: boolean; message: string; goal: ThreadGoal | null };
}

const COMMANDS = ["pause", "resume", "resume cancel", "clear", "copy"] as const;

type CopyText = (text: string) => Promise<ClipboardCopyResult>;
type IsCurrentGeneration = () => boolean;

export type GoalCommandPi = Pick<ExtensionAPI, "on" | "registerCommand" | "sendUserMessage">;

export interface GoalCommandContext {
  ui: Pick<ExtensionCommandContext["ui"], "confirm" | "notify" | "setStatus">;
}

function completions(prefix: string) {
  return COMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
    value: command,
    label: command,
    description: `goal ${command}`,
  }));
}

function queueGoalUserTurn(pi: GoalCommandPi, goal: ThreadGoal): void {
  pi.sendUserMessage(compactContinuationPrompt(goal), { deliverAs: "followUp" });
}

/**
 * Hands the objective to the agent instead of storing the typed words as the
 * goal. `/goal <objective>` absorbed the retired `/create-goal` prompt, so the
 * agent drafts the full completion contract and calls the goal creation tool.
 */
function queueGoalDrafting(pi: GoalCommandPi, task: string): void {
  pi.sendUserMessage(goalObjectivePrompt(task), { deliverAs: "followUp" });
}

export async function handleGoalCommand(
  pi: GoalCommandPi,
  host: CommandHost,
  args: string,
  ctx: GoalCommandContext,
  copyText: CopyText = copyTextToClipboard,
  isCurrentGeneration: IsCurrentGeneration = () => true,
): Promise<void> {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    ctx.ui.notify(formatGoalSummary(host.getGoal()));
    return;
  }

  if (trimmed === "clear") {
    const goal = host.getGoal();
    if (!goal) {
      ctx.ui.notify("No goal is set.", "warning");
      return;
    }
    host.clearGoal("command", ctx);
    ctx.ui.notify("Goal cleared.");
    return;
  }

  if (trimmed === "copy") {
    const goal = host.getGoal();
    if (!goal) {
      ctx.ui.notify("No goal is set.", "warning");
      return;
    }
    const result = await copyText(goal.objective);
    if (!isCurrentGeneration()) return;
    if (!result.ok) {
      ctx.ui.notify(
        result.message
          ? `Could not copy goal objective: ${result.message}`
          : "Could not copy goal objective.",
        "error",
      );
      return;
    }
    ctx.ui.notify("Goal objective copied.");
    return;
  }

  if (trimmed === "resume cancel") {
    const current = host.getGoal();
    if (!current) {
      ctx.ui.notify("No goal is set.", "warning");
      return;
    }
    host.cancelProviderLimitAutoResume(current.goalId, ctx);
    ctx.ui.notify("Provider-limit auto-resume canceled. Use /goal resume when ready.");
    return;
  }

  if (trimmed === "pause" || trimmed === "resume") {
    const current = host.getGoal();
    if (
      trimmed === "resume" &&
      current?.status === "active" &&
      host.getGoalStartTurnStrategy() === "userFollowUp"
    ) {
      queueGoalUserTurn(pi, current);
      ctx.ui.notify("Goal already active; queued a continuation.");
      return;
    }

    if (trimmed === "resume" && current?.status === "paused") {
      const result = host.resumeGoalWithContinuation(current.goalId, "command", ctx);
      ctx.ui.notify(result.message, result.ok ? undefined : "warning");
      return;
    }

    const result = updateGoalStatus(current, trimmed === "pause" ? "paused" : "active");
    if (!result.ok || !result.goal) {
      ctx.ui.notify(result.message, "warning");
      return;
    }
    host.setGoal(result.goal, "command", ctx);
    ctx.ui.notify(result.message);
    return;
  }

  queueGoalDrafting(pi, trimmed);
}

export function registerGoalCommand(
  pi: GoalCommandPi,
  host: CommandHost,
  copyText: CopyText = copyTextToClipboard,
): void {
  let generation = 0;
  let activeGeneration: number | undefined;

  pi.on("session_start", () => {
    activeGeneration = ++generation;
  });
  pi.on("session_shutdown", () => {
    activeGeneration = undefined;
  });

  pi.registerCommand("goal", {
    description:
      "Show or manage the current choco-pi goal; /goal <objective> drafts and creates one.",
    getArgumentCompletions(argumentPrefix) {
      return completions(argumentPrefix.trim());
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      const commandGeneration = activeGeneration;
      await handleGoalCommand(pi, host, args, ctx, copyText, () => {
        return commandGeneration !== undefined && commandGeneration === activeGeneration;
      });
    },
  });
}
