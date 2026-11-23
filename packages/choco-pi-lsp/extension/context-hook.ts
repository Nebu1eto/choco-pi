/**
 * message_end cache-usage telemetry and the context-injection hook.
 *
 * Extracted from `runtime-extension.ts` `activateExtension`; behavior is unchanged.
 */

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

/** Register message_end cache-usage telemetry. */
export function registerCacheUsageHook(activation: ExtensionActivation): void {
  const { pi, runtime, activationState } = activation;
  // --- Prompt-cache response-side usage observability (#1018) ---
  // On each assistant message_end, append ONE `cache_usage` latency record with
  // the provider-reported token/cost breakdown. `message_end` is a newer host
  // event; register defensively (clients/agent-nudge.ts pattern) — guard `pi.on`,
  // wrap in try/catch, and never throw out of the handler — so an older pi host
  // that never fires it simply produces no records rather than crashing wireup.
  try {
    // biome-ignore lint/suspicious/noExplicitAny: message_end overload absent on older host types
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

/** Register the context-injection hook. */
export function registerContextHook(activation: ExtensionActivation): void {
  const { pi, runtime, contextInjectionHistory, cacheManager, activationState } = activation;
  // --- Inject turn-end findings into next agent turn ---
  // jscpd, madge, and turn-end delta results are cached at turn_end and consumed here
  // via the context event, which fires before each provider request.
  // Delivered findings are replayed at their original positions for this agent run,
  // including native steering and tool continuations; consuming a cache entry must
  // not remove a message already sent to the provider. New findings retain placement
  // (#1016): splice choco-pi-lsp findings in IMMEDIATELY BEFORE
  // the final message rather than prepending at index 0. Prepending flipped
  // messages[0] every turn, which invalidated the entire prompt-cache prefix on
  // EVERY prefix-caching provider (Anthropic, Bedrock, AND OpenAI — all key the
  // cache on the exact token prefix). Inserting before the last message keeps
  // messages[0] (the real first user turn) byte-stable so the prior conversation
  // stays cached, AND keeps the real user prompt as the trailing message —
  // preserving the trailing-`user` cache breakpoint and the historical fe0ed5da
  // guarantee that input is never empty (existingMessages are always preserved,
  // never dropped).
  //
  // The `context` event fires before EVERY provider/LLM call, not just at turn
  // boundaries (clients/agent-nudge.ts), so mid-agentic-loop the trailing message
  // is often a `tool_result` — which MUST stay immediately adjacent to the
  // assistant message carrying its matching `tool_use`/`tool_calls`, across all of
  // Anthropic, Bedrock, and OpenAI (a 400 otherwise). The trailing-role guard
  // (isPlainUserPrompt) therefore only splices before the last message when it is a
  // plain user prompt; otherwise it APPENDS after the whole transcript, which both
  // preserves that adjacency and is still fully cache-friendly (the entire prior
  // transcript stays an untouched prefix).
  const isPlainUserPrompt = (msg: { role: string; content: unknown }): boolean => {
    if (msg.role !== "user") return false;
    // String content is a plain prompt; only an array of content blocks can
    // carry a tool_result, which must not be preceded by an injected message.
    if (!Array.isArray(msg.content)) return true;
    return !msg.content.some(
      (block) =>
        isRuntimeObject(block) &&
        block !== null &&
        // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
        (block as { type?: unknown }).type === "tool_result",
    );
  };
  // biome-ignore lint/suspicious/noExplicitAny: pi.on("context") overload has TS resolution bug
  // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
  (pi as any).on(
    "context",
    async (
      event: { messages?: Array<{ role: string; content: unknown }> } | unknown,
      ctx: { cwd?: string },
    ) => {
      // #1018: context telemetry deliberately runs even when the lens or its
      // injection toggle is off, so an A/B run has a no-injection observation.
      const incomingMessages =
        // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
        (event as { messages?: Array<{ role: string; content: unknown }> })?.messages ?? [];
      const prefixSessionId = getStableSessionId(ctx);
      const effectiveInjectionEnabled =
        activationState.lensEnabled && activationState.contextInjectionEnabled;
      if (!effectiveInjectionEnabled) contextInjectionHistory.clear(prefixSessionId);
      // Already-delivered guidance is history, not another freshly consumed advisory.
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

        // Empty transcript (no turns yet): fall back to prepend semantics —
        // there is no trailing user message to sit before, and we must never
        // emit empty input (fe0ed5da: OpenAI Responses fails on empty input).
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

        // Mid-loop the tail can be a tool_result (or assistant/tool) message;
        // inserting before it would break tool_use↔tool_result adjacency. Only
        // splice before the last message when it is a plain user prompt.
        if (!isPlainUserPrompt(lastMessage)) {
          // Append after the whole transcript — pure append preserves the
          // adjacency AND leaves the entire prior transcript as an untouched
          // cache prefix.
          const resultMessages = contextInjectionHistory.apply(
            prefixSessionId,
            incomingMessages,
            injectedMessages,
          );
          logContextObservation(resultMessages, "append", injectionSources, injectedMessages);
          return { messages: resultMessages };
        }

        // Insert the injected block just before the final message so
        // messages[0] stays stable and the real user prompt stays trailing.
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
