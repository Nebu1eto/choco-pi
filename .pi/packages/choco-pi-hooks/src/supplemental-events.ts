import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { HookEventName, JsonObject, MergedHookResult } from "./types.ts";
import {
  isFunctionValue,
  isStringValue,
  parseRuntimeRecord,
  type RuntimeValue,
} from "./validation.ts";
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

interface ElicitationResponse {
  action: string;
  content?: JsonObject;
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
): SupplementalLifecycle {
  let context: ExtensionContext | undefined;
  const loadedInstructions = new Set<string>();
  const unsubscribers: Array<() => void> = [];
  const backgroundTasks = new Map<string, JsonObject>();
  let displayOriginal = "";
  let displayRendered = "";
  let displayIndex = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let generation = 0;

  const isGenerationCurrent = (token: number): boolean => !disposed && generation === token;
  const runDetached = (promise: Promise<unknown>): void => {
    void promise.catch(rethrowUnlessStaleContext);
  };

  pi.on("agent_settled", (_event, ctx) => {
    if (disposed) return;
    context = ctx;
    const generationToken = generation;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!isGenerationCurrent(generationToken)) return;
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
    displayIndex = 0;
  });

  pi.on("turn_end", async (event, ctx) => {
    if (disposed) return;
    context = ctx;
    await dispatch("PostToolBatch", ctx, { tool_calls: toolCalls(event) });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (disposed) return;
    context = ctx;
    const generationToken = generation;
    for (const file of event.systemPromptOptions.contextFiles ?? []) {
      if (loadedInstructions.has(file.path)) continue;
      loadedInstructions.add(file.path);
      await dispatch("InstructionsLoaded", ctx, {
        file_path: file.path,
        memory_type: file.path.includes("/.claude/") ? "Project" : "User",
        load_reason: "session_start",
      });
      if (!isGenerationCurrent(generationToken)) return;
    }
  });

  pi.on("message_update", async (event, ctx) => {
    if (disposed) return;
    context = ctx;
    const generationToken = generation;
    const streamEvent = parseRuntimeRecord(event.assistantMessageEvent);
    const delta = isStringValue(streamEvent?.delta) ? streamEvent.delta : undefined;
    if (!delta) return;
    const result = await dispatch("MessageDisplay", ctx, {
      turn_id: String(event.message.timestamp),
      message_id: String(event.message.timestamp),
      index: displayIndex++,
      final: false,
      delta,
    });
    if (!isGenerationCurrent(generationToken)) return;
    displayOriginal += delta;
    displayRendered += result.displayContent ?? delta;
  });

  pi.on("message_end", async (event, ctx) => {
    if (disposed) return;
    if (event.message.role !== "assistant") return;
    context = ctx;
    const generationToken = generation;
    const result = await dispatch("MessageDisplay", ctx, {
      turn_id: String(event.message.timestamp),
      message_id: String(event.message.timestamp),
      index: displayIndex++,
      final: true,
      delta: "",
    });
    if (!isGenerationCurrent(generationToken)) return;
    if (result.displayContent) displayRendered += result.displayContent;
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
    runDetached(
      dispatch("SubagentStart", ctx, {
        agent_id: isStringValue(data.id) ? data.id : undefined,
        agent_type: isStringValue(data.type) ? data.type : undefined,
      }),
    );
  };
  const onSubagentStopped = <Value>(payload: Value): void => {
    const ctx = context;
    const generationToken = generation;
    const data = parseRuntimeRecord(payload);
    if (!ctx || !data) return;
    const agentId = isStringValue(data.id) ? data.id : undefined;
    const agentType = isStringValue(data.type) ? data.type : undefined;
    let lastAssistantMessage = "";
    if (isStringValue(data.result)) lastAssistantMessage = data.result;
    else if (isStringValue(data.error)) lastAssistantMessage = data.error;
    if (agentId) backgroundTasks.delete(agentId);
    runDetached(
      (async () => {
        const idle = await dispatch("TeammateIdle", ctx, {
          teammate_name: agentId,
          team_name: isStringValue(data.workflowId) ? data.workflowId : undefined,
        });
        if (!isGenerationCurrent(generationToken)) return;
        let completion: MergedHookResult | undefined;
        const workflowStep = isStringValue(data.workflowStepId) ? data.workflowStepId : undefined;
        if (workflowStep)
          completion = await dispatch("TaskCompleted", ctx, {
            task_id: workflowStep,
            task_subject: isStringValue(data.description) ? data.description : workflowStep,
            teammate_name: agentId,
            team_name: isStringValue(data.workflowId) ? data.workflowId : undefined,
          });
        if (!isGenerationCurrent(generationToken)) return;
        const stopped = await dispatch("SubagentStop", ctx, {
          stop_hook_active: false,
          agent_id: agentId,
          agent_type: agentType,
          agent_transcript_path: isStringValue(data.agentTranscriptPath)
            ? data.agentTranscriptPath
            : "",
          last_assistant_message: lastAssistantMessage,
          background_tasks: [...backgroundTasks.values()],
          session_crons: [],
        });
        if (!isGenerationCurrent(generationToken)) return;
        const blocked = [idle, completion, stopped].find((result) => result?.blocked);
        if (blocked?.reason && agentId)
          pi.events.emit("choco-pi-hooks:subagent-continue", {
            id: agentId,
            reason: blocked.reason,
          });
      })(),
    );
  };
  const onSubagentNotification = <Value>(payload: Value): void => {
    const ctx = context;
    const data = parseRuntimeRecord(payload);
    if (!ctx || !data) return;
    let message = "Subagent completed";
    if (isStringValue(data.result)) message = data.result;
    else if (isStringValue(data.error)) message = data.error;
    runDetached(
      dispatch("Notification", ctx, {
        notification_type: "agent_completed",
        message,
        title: isStringValue(data.description) ? data.description : undefined,
      }),
    );
  };
  const onElicitation = async <Value>(payload: Value): Promise<void> => {
    const ctx = context;
    const generationToken = generation;
    const data = parseRuntimeRecord(payload);
    const claim = data?.claim;
    const resolve = data?.resolve;
    const event = data?.event;
    if (!ctx || !data || !isFunctionValue(claim) || !isFunctionValue(resolve)) return;
    if (event !== "Elicitation" && event !== "ElicitationResult") return;
    // SAFETY: isFunctionValue established the zero-argument claim callback supplied by the MCP bridge.
    const claimRequest = claim as () => void;
    // SAFETY: isFunctionValue established the elicitation result callback supplied by the MCP bridge.
    const resolveRequest = resolve as (value: ElicitationResponse | undefined) => void;
    claimRequest();
    let resolved = false;
    const resolveOnce = (value: ElicitationResponse | undefined): void => {
      if (resolved) return;
      resolved = true;
      resolveRequest(value);
    };
    const params = parseRuntimeRecord(data.params) ?? {};
    const current = parseRuntimeRecord(data.current);
    // SAFETY: MCP elicitation schemas and result content are JSON protocol property bags.
    const requestedSchema = (parseRuntimeRecord(params.requestedSchema) ?? {}) as JsonObject;
    const extra: JsonObject = {
      mcp_server_name: isStringValue(data.serverName) ? data.serverName : "",
      message: isStringValue(params.message) ? params.message : "",
      mode: isStringValue(params.mode) ? params.mode : undefined,
      url: isStringValue(params.url) ? params.url : undefined,
      elicitation_id: isStringValue(params.elicitationId) ? params.elicitationId : undefined,
      requested_schema: requestedSchema,
    };
    if (event === "ElicitationResult") {
      extra.action = isStringValue(current?.action) ? current.action : undefined;
      const content = parseRuntimeRecord(current?.content);
      if (content) {
        // SAFETY: MCP elicitation result content is a JSON protocol property bag.
        extra.content = content as JsonObject;
      }
    }
    try {
      const result = await dispatch(event, ctx, extra);
      if (!isGenerationCurrent(generationToken)) {
        resolveOnce(undefined);
        return;
      }
      if (!result.elicitationAction) {
        resolveOnce(undefined);
        return;
      }
      const response: ElicitationResponse = {
        action: result.elicitationAction,
      };
      if (result.elicitationContent) response.content = result.elicitationContent;
      resolveOnce(response);
    } catch (error: unknown) {
      resolveOnce(undefined);
      // SAFETY: The caught value is only passed to the runtime-value stale-error discriminator.
      rethrowUnlessStaleContext(error as RuntimeValue);
    }
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
  unsubscribers.push(pi.events.on("subagents:completed", onSubagentNotification));
  unsubscribers.push(pi.events.on("subagents:failed", onSubagentNotification));
  unsubscribers.push(pi.events.on("choco-pi-hooks:elicitation", onElicitation));
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
