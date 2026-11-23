import type { RuntimeValue } from "../tools/runtime-values.ts";
import { isRuntimeObject } from "../tools/runtime-values.ts";
import { consumeAgentNudge } from "../clients/agent-nudge.ts";
import {
  consumeSessionStartGuidance,
  consumeTestFindings,
  consumeTurnEndFindings,
} from "../clients/runtime-context.ts";
import { classifyCurrentSessionEmission } from "../clients/session-lifecycle.ts";
import {
  logCacheUsage,
  observeCacheContext,
  observeCachePrefix,
} from "../clients/cache-observability.ts";
import type { ExtensionActivation } from "./activation.ts";
import { dbg, getStableSessionId } from "./shared.ts";

export function registerCacheUsageHook(activation: ExtensionActivation): void {
  const { pi, runtime, activationState } = activation;
  try {
    // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
    (pi as any).on?.("message_end", (event: RuntimeValue, ctx: RuntimeValue) => {
      if (!activationState.lensEnabled) return;
      try {
        const sessionId = getStableSessionId(ctx);
        // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
        logCacheUsage((event as { message?: unknown })?.message, dbg, {
          sessionId,
          sessionRole: classifyCurrentSessionEmission(ctx, sessionId),
          turnIndex: runtime.turnIndex,
        });
      } catch (err) {
        dbg(`message_end handler error: ${err}`);
      }
    });
  } catch (err) {
    dbg(`message_end subscribe failed (older pi host?): ${err}`);
  }
}

export function registerContextHook(activation: ExtensionActivation): void {
  const { pi, runtime, contextInjectionHistory, cacheManager, activationState } = activation;
  const isPlainUserPrompt = (msg: { role: string; content: unknown }): boolean => {
    if (msg.role !== "user") return false;
    if (!Array.isArray(msg.content)) return true;
    return !msg.content.some(
      (block) =>
        isRuntimeObject(block) &&
        block !== null &&
        // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
        (block as { type?: unknown }).type === "tool_result",
    );
  };
  // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
  (pi as any).on(
    "context",
    async (
      event: { messages?: Array<{ role: string; content: unknown }> } | unknown,
      ctx: { cwd?: string },
    ) => {
      const incomingMessages =
        // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
        (event as { messages?: Array<{ role: string; content: unknown }> })?.messages ?? [];
      const prefixSessionId = getStableSessionId(ctx);
      const effectiveInjectionEnabled =
        activationState.lensEnabled && activationState.contextInjectionEnabled;
      if (!effectiveInjectionEnabled) contextInjectionHistory.clear(prefixSessionId);
      const existingMessages = effectiveInjectionEnabled
        ? contextInjectionHistory.apply(prefixSessionId, incomingMessages)
        : incomingMessages;
      const sessionRole = classifyCurrentSessionEmission(ctx, prefixSessionId);
      const prefixObservation = observeCachePrefix(
        existingMessages,
        runtime.turnIndex,
        prefixSessionId,
        sessionRole,
        dbg,
      );
      let telemetryLogged = false;
      const logContextObservation = (
        resultMessages: Array<{ role: string; content: unknown }>,
        placement: "prepend" | "insert-before-final" | "append" | "none",
        injectionSources: Array<
          "session-guidance" | "turn-findings" | "test-findings" | "agent-nudge"
        >,
        injectedMessages: Array<{ role: string; content: unknown }>,
      ) => {
        if (telemetryLogged) return;
        telemetryLogged = true;
        observeCacheContext({
          existingMessages,
          resultMessages,
          sessionId: prefixSessionId,
          sessionRole,
          turnIndex: runtime.turnIndex,
          injectionEnabled: effectiveInjectionEnabled,
          injectionSources,
          injectedMessages,
          placement,
          prefixObservation,
          dbg,
        });
      };
      try {
        const cwd = ctx.cwd ?? process.cwd();

        if (!effectiveInjectionEnabled) {
          logContextObservation(existingMessages, "none", [], []);
          return;
        }

        const turnEndFindings = consumeTurnEndFindings(cacheManager, cwd, runtime);
        const sessionGuidance = consumeSessionStartGuidance(cacheManager, cwd);
        const testFindings = consumeTestFindings(cacheManager, cwd, runtime);
        const agentNudge = consumeAgentNudge(dbg);
        const sourceMessages = [
          {
            source: "session-guidance" as const,
            messages: sessionGuidance?.messages ?? [],
          },
          {
            source: "turn-findings" as const,
            messages: turnEndFindings?.messages ?? [],
          },
          {
            source: "test-findings" as const,
            messages: testFindings?.messages ?? [],
          },
          {
            source: "agent-nudge" as const,
            messages: agentNudge?.messages ?? [],
          },
        ].filter((source) => source.messages.length > 0);
        const injectedMessages = sourceMessages.flatMap((source) => source.messages);
        const injectionSources = sourceMessages.map((source) => source.source);
        if (injectedMessages.length === 0) {
          logContextObservation(existingMessages, "none", [], []);
          return existingMessages === incomingMessages ? undefined : { messages: existingMessages };
        }

        if (incomingMessages.length === 0) {
          const resultMessages = contextInjectionHistory.apply(
            prefixSessionId,
            incomingMessages,
            injectedMessages,
          );
          logContextObservation(resultMessages, "prepend", injectionSources, injectedMessages);
          return { messages: resultMessages };
        }

        const lastMessage = incomingMessages[incomingMessages.length - 1];

        if (!isPlainUserPrompt(lastMessage)) {
          const resultMessages = contextInjectionHistory.apply(
            prefixSessionId,
            incomingMessages,
            injectedMessages,
          );
          logContextObservation(resultMessages, "append", injectionSources, injectedMessages);
          return { messages: resultMessages };
        }

        const resultMessages = contextInjectionHistory.apply(
          prefixSessionId,
          incomingMessages,
          injectedMessages,
          true,
        );
        logContextObservation(
          resultMessages,
          "insert-before-final",
          injectionSources,
          injectedMessages,
        );
        return { messages: resultMessages };
      } catch (err) {
        if (!telemetryLogged) logContextObservation(existingMessages, "none", [], []);
        dbg(`context event error: ${err}`);
        return existingMessages === incomingMessages ? undefined : { messages: existingMessages };
      }
    },
  );
}
