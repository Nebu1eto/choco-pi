import crypto from "node:crypto";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { HookEventName, JsonObject, MergedHookResult } from "./types.ts";
import { isStringValue, parseRuntimeRecord } from "./validation.ts";
import { rethrowUnlessStaleContext } from "./lifecycle.ts";

export type HookDispatch = (
  event: HookEventName,
  ctx: ExtensionContext,
  extra?: JsonObject,
) => Promise<MergedHookResult>;

interface SupplementalLifecycle {
  setContext(ctx: ExtensionContext): void;
  getContext(): ExtensionContext | undefined;
  captureGeneration(): number;
  isCurrentGeneration(token: number): boolean;
  getBackgroundTasks(): JsonObject[];
  dispose(): void;
}

export interface SupplementalOptions {
  /** Whether this is a subagent session, which fires no session-level or display events. */
  isSubagentSession?: () => boolean;
}

/** InstructionsLoaded `memory_type` for a loaded instruction file. */
function memoryType(filePath: string, cwd: string): string {
  if (filePath.includes(`${path.sep}ClaudeCode${path.sep}`)) return "Managed";
  const relative = path.relative(cwd, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "User";
  return path.basename(filePath).includes(".local.") ? "Local" : "Project";
}

function toolCalls(event: TurnEndEvent): JsonObject[] {
  // SAFETY: Pi turn-end tool result content is JSON-serializable provider data.
  return event.toolResults.map((result) => ({
    tool_name: result.toolName,
    tool_use_id: result.toolCallId,
    tool_response: result.content as never,
  }));
}

export function registerSupplementalEvents(
  pi: ExtensionAPI,
  dispatch: HookDispatch,
  options: SupplementalOptions = {},
): SupplementalLifecycle {
  let context: ExtensionContext | undefined;
  const loadedInstructions = new Set<string>();
  const unsubscribers: Array<() => void> = [];
  const backgroundTasks = new Map<string, JsonObject>();
  let displayOriginal = "";
  let displayRendered = "";
  let displayPending = "";
  let displayIndex = 0;
  let displayMessageId = "";
  let displayTurnId: string = crypto.randomUUID();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let generation = 0;
  const isSubagent = (): boolean => options.isSubagentSession?.() === true;

  const isGenerationCurrent = (token: number): boolean => !disposed && generation === token;
  const runDetached = (promise: Promise<unknown>): void => {
    void promise.catch(rethrowUnlessStaleContext);
  };

  pi.on("agent_settled", (_event, ctx) => {
    if (disposed) return;
    context = ctx;
    if (isSubagent()) return;
    const generationToken = generation;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!isGenerationCurrent(generationToken)) return;
      // No idle notification while a background subagent is still running.
      if (backgroundTasks.size) return;
      runDetached(
        dispatch("Notification", ctx, {
          notification_type: "idle_prompt",
          message: "Claude is waiting for your input",
        }),
      );
    }, 60_000);
    idleTimer.unref?.();
  });
  pi.on("input", () => {
    if (disposed) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  });

  pi.registerMarkdownTransformer((markdown, renderContext) => {
    if (
      renderContext.messageType === "assistant" &&
      displayOriginal.length > 0 &&
      markdown === displayOriginal
    )
      return displayRendered;
    return markdown;
  });

  pi.on("message_start", (event) => {
    if (disposed) return;
    if (event.message.role !== "assistant") return;
    displayOriginal = "";
    displayRendered = "";
    displayPending = "";
    displayIndex = 0;
    displayMessageId = crypto.randomUUID();
  });
  pi.on("turn_start", () => {
    if (disposed) return;
    displayTurnId = crypto.randomUUID();
  });

  pi.on("turn_end", async (event, ctx) => {
    if (disposed) return;
    context = ctx;
    // PostToolBatch follows a batch of tool calls, before the next model request.
    if (!event.toolResults.length) return;
    const generationToken = generation;
    const hasUI = ctx.hasUI;
    const ui = ctx.ui;
    const result = await dispatch("PostToolBatch", ctx, { tool_calls: toolCalls(event) });
    if (!isGenerationCurrent(generationToken)) return;
    if (result.blocked || !result.continue) {
      if (hasUI && result.reason) ui.notify(result.reason, "warning");
      ctx.abort();
      return;
    }
    if (result.additionalContext.length)
      pi.sendMessage(
        {
          customType: "choco-pi-hooks",
          content: result.additionalContext.join("\n"),
          display: false,
        },
        { deliverAs: "steer" },
      );
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (disposed) return;
    context = ctx;
    const generationToken = generation;
    const cwd = ctx.cwd;
    const files = (event.systemPromptOptions.contextFiles ?? []).filter(
      (file) => !loadedInstructions.has(file.path),
    );
    for (const file of files) loadedInstructions.add(file.path);
    // InstructionsLoaded is observational and runs without delaying the run.
    runDetached(
      (async () => {
        for (const file of files) {
          await dispatch("InstructionsLoaded", ctx, {
            file_path: file.path,
            memory_type: memoryType(file.path, cwd),
            load_reason: "session_start",
          });
          if (!isGenerationCurrent(generationToken)) return;
        }
      })(),
    );
  });

  /** Run MessageDisplay for one batch of displayed text and record what to render. */
  const displayBatch = async (ctx: ExtensionContext, delta: string, final: boolean) => {
    const generationToken = generation;
    const result = await dispatch("MessageDisplay", ctx, {
      turn_id: displayTurnId,
      message_id: displayMessageId,
      index: displayIndex++,
      final,
      delta,
    });
    if (!isGenerationCurrent(generationToken)) return;
    displayOriginal += delta;
    displayRendered += result.displayContent ?? delta;
  };

  // MessageDisplay sees assistant text in batches of completed lines; a
  // subagent's messages are never displayed.
  pi.on("message_update", async (event, ctx) => {
    if (disposed || isSubagent()) return;
    context = ctx;
    const streamEvent = parseRuntimeRecord(event.assistantMessageEvent);
    if (streamEvent?.type !== "text_delta" || !isStringValue(streamEvent.delta)) return;
    displayPending += streamEvent.delta;
    const cut = displayPending.lastIndexOf("\n");
    if (cut < 0) return;
    const batch = displayPending.slice(0, cut + 1);
    displayPending = displayPending.slice(cut + 1);
    await displayBatch(ctx, batch, false);
  });

  pi.on("message_end", async (event, ctx) => {
    if (disposed || isSubagent()) return;
    if (event.message.role !== "assistant") return;
    context = ctx;
    // A message without text, such as a tool-call-only response, is not displayed.
    if (displayIndex === 0 && !displayPending) return;
    const rest = displayPending;
    displayPending = "";
    await displayBatch(ctx, rest, true);
  });

  const onSubagentStarted = <Value>(payload: Value): void => {
    const ctx = context;
    const data = parseRuntimeRecord(payload);
    if (!ctx || !data) return;
    const id = isStringValue(data.id) ? data.id : undefined;
    if (id)
      backgroundTasks.set(id, {
        id,
        type: "subagent",
        status: "running",
        description: isStringValue(data.description) ? data.description : "",
        agent_type: isStringValue(data.type) ? data.type : undefined,
      });
  };
  // SubagentStart and SubagentStop fire inside the subagent session itself, where
  // SubagentStart can add context and SubagentStop can keep the subagent working.
  // Here the parent only tracks background work and, for workflow members (the
  // agent-team analog), runs TeammateIdle and TaskCompleted.
  const onSubagentStopped = <Value>(payload: Value): void => {
    const ctx = context;
    const generationToken = generation;
    const data = parseRuntimeRecord(payload);
    if (!ctx || !data) return;
    const agentId = isStringValue(data.id) ? data.id : undefined;
    if (agentId) backgroundTasks.delete(agentId);
    const workflowId = isStringValue(data.workflowId) ? data.workflowId : undefined;
    if (!workflowId) return;
    runDetached(
      (async () => {
        const idle = await dispatch("TeammateIdle", ctx, {
          teammate_name: agentId,
          team_name: workflowId,
        });
        if (!isGenerationCurrent(generationToken)) return;
        let completion: MergedHookResult | undefined;
        const workflowStep = isStringValue(data.workflowStepId) ? data.workflowStepId : undefined;
        if (workflowStep)
          completion = await dispatch("TaskCompleted", ctx, {
            task_id: workflowStep,
            task_subject: isStringValue(data.description) ? data.description : workflowStep,
            teammate_name: agentId,
            team_name: workflowId,
          });
        if (!isGenerationCurrent(generationToken)) return;
        const blocked = [idle, completion].find((result) => result?.blocked);
        if (blocked?.reason && agentId)
          pi.events.emit("choco-pi-hooks:subagent-continue", {
            id: agentId,
            reason: blocked.reason,
          });
      })(),
    );
  };
  const onInstructionsLoaded = <Value>(payload: Value): void => {
    const ctx = context;
    const data = parseRuntimeRecord(payload);
    const filePath = isStringValue(data?.filePath) ? data.filePath : undefined;
    if (!ctx || !data || !filePath || loadedInstructions.has(filePath)) return;
    loadedInstructions.add(filePath);
    runDetached(
      dispatch("InstructionsLoaded", ctx, {
        file_path: filePath,
        memory_type: isStringValue(data.memoryType) ? data.memoryType : "Project",
        load_reason: isStringValue(data.loadReason) ? data.loadReason : "nested_traversal",
        trigger_file_path: isStringValue(data.triggerFilePath) ? data.triggerFilePath : undefined,
        parent_file_path: isStringValue(data.parentFilePath) ? data.parentFilePath : undefined,
      }),
    );
  };
  unsubscribers.push(pi.events.on("subagents:started", onSubagentStarted));
  unsubscribers.push(pi.events.on("subagents:completed", onSubagentStopped));
  unsubscribers.push(pi.events.on("subagents:failed", onSubagentStopped));
  unsubscribers.push(pi.events.on("choco-pi-hooks:instructions-loaded", onInstructionsLoaded));

  return {
    setContext(ctx) {
      if (disposed) return;
      context = ctx;
    },
    getContext() {
      return context;
    },
    captureGeneration() {
      return generation;
    },
    isCurrentGeneration(token) {
      return !disposed && generation === token;
    },
    getBackgroundTasks() {
      return [...backgroundTasks.values()];
    },
    dispose() {
      if (disposed) return;
      generation += 1;
      disposed = true;
      context = undefined;
      clearTimeout(idleTimer);
      idleTimer = undefined;
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
}
