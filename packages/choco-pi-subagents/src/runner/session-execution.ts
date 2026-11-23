import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getChildCompactionBridge } from "../child-compaction-bridge.ts";
import { trackSessionCompaction } from "../compaction-activity.ts";
import type { SubagentType } from "../types.ts";
import {
  buildEffectivePrompt,
  type PreparedChildSession,
  type RunOptions,
  type RunResult,
  type ToolActivity,
} from "./loader-setup.ts";
import {
  assistantUsage,
  collectResponseText,
  finalTurnError,
  getLastAssistantText,
} from "./result-collection.ts";
import {
  forwardAbortSignal,
  installRunnerTurnLimit,
  normalizeMaxTurns,
  resolveAgentMaxTurns,
} from "./turn-limit.ts";

export async function executeChildSession(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
  prepared: PreparedChildSession,
): Promise<RunResult> {
  const { session, childCompaction, scratchNotice } = prepared;
  const maxTurns = resolveAgentMaxTurns(type, options.maxTurns);

  let currentMessageText = "";
  const turnLimit = installRunnerTurnLimit(session, {
    maxTurns,
    signal: options.signal,
    onTurnEnd: options.onTurnEnd,
    onFinishAttempt: options.onFinishAttempt,
  });
  const unsubEvents = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = assistantUsage(event.message);
      if (usage) options.onAssistantUsage?.(usage);
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  const effectivePrompt = buildEffectivePrompt(ctx, prompt, options);
  const promptWithNotice = scratchNotice
    ? `${scratchNotice}\n\n${effectivePrompt}`
    : effectivePrompt;

  const startLen = session.messages.length;
  const stopChildAdoptions = childCompaction?.onAdoption((info) => options.onCompaction?.(info));
  const stopCompactionTracking = trackSessionCompaction(session);
  try {
    if (!options.signal?.aborted) await session.prompt(promptWithNotice);
    await turnLimit.settleCorrections();
  } finally {
    turnLimit.unsubscribe();
    unsubEvents();
    collector.unsubscribe();
    cleanupAbort();
    stopChildAdoptions?.();
    stopCompactionTracking();
    childCompaction?.settle({
      canceled: options.signal?.aborted === true,
      timedOut: turnLimit.getAborted(),
    });
  }

  const responseText = collector.getText().trim() || getLastAssistantText(session, startLen);
  return {
    responseText,
    session,
    aborted: turnLimit.getAborted(),
    steered: turnLimit.getSteered(),
    failure: turnLimit.getFailure() ?? finalTurnError(session, startLen),
  };
}

export interface ResumeResult {
  text: string;
  failure?: string;
  aborted?: boolean;
  steered?: boolean;
}

export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: {
    onFinishAttempt?: RunOptions["onFinishAttempt"];
    maxTurns?: number;
    onToolActivity?: (activity: ToolActivity) => void;
    onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
    onCompaction?: (info: {
      reason: "manual" | "threshold" | "overflow";
      tokensBefore: number;
    }) => void;
    signal?: AbortSignal;
  } = {},
): Promise<ResumeResult> {
  const startLen = session.messages.length;
  const maxTurns = normalizeMaxTurns(options.maxTurns);
  const turnLimit =
    maxTurns === undefined && options.onFinishAttempt === undefined
      ? undefined
      : installRunnerTurnLimit(session, {
          maxTurns,
          signal: options.signal,
          onFinishAttempt: options.onFinishAttempt,
        });
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  const unsubEvents =
    options.onToolActivity || options.onAssistantUsage || options.onCompaction
      ? session.subscribe((event: AgentSessionEvent) => {
          if (event.type === "tool_execution_start")
            options.onToolActivity?.({ type: "start", toolName: event.toolName });
          if (event.type === "tool_execution_end")
            options.onToolActivity?.({ type: "end", toolName: event.toolName });
          if (event.type === "message_end" && event.message.role === "assistant") {
            const usage = assistantUsage(event.message);
            if (usage) options.onAssistantUsage?.(usage);
          }
          if (event.type === "compaction_end" && !event.aborted && event.result) {
            options.onCompaction?.({
              reason: event.reason,
              tokensBefore: event.result.tokensBefore,
            });
          }
        })
      : () => {};
  const childCompaction = getChildCompactionBridge(session);
  const stopChildAdoptions = childCompaction?.onAdoption((info) => options.onCompaction?.(info));
  const stopCompactionTracking = trackSessionCompaction(session);

  try {
    if (!options.signal?.aborted && session.isCompacting) await session.waitForIdle();
    if (!options.signal?.aborted) await childCompaction?.reattach();
    if (!options.signal?.aborted && session.isCompacting) await session.waitForIdle();
    if (!options.signal?.aborted) await session.prompt(prompt);
    await turnLimit?.settleCorrections();
  } finally {
    turnLimit?.unsubscribe();
    collector.unsubscribe();
    unsubEvents();
    cleanupAbort();
    stopChildAdoptions?.();
    stopCompactionTracking();
    childCompaction?.settle({
      canceled: options.signal?.aborted === true,
      timedOut: turnLimit?.getAborted() === true,
    });
  }

  const result: ResumeResult = {
    text: collector.getText().trim() || getLastAssistantText(session, startLen),
    failure: turnLimit?.getFailure() ?? finalTurnError(session, startLen),
  };
  if (turnLimit) {
    result.aborted = turnLimit.getAborted();
    result.steered = turnLimit.getSteered();
  }
  return result;
}

export async function steerAgent(session: AgentSession, message: string): Promise<void> {
  await session.steer(message);
}
