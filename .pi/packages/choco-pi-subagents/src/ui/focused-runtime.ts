import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../types.ts";
import { getSessionContextUsage, getSessionCost } from "../usage.ts";
import { decideSessionFastMode } from "../fast-mode-bridge.ts";

/** Loose cross-package seam read by editor chrome while a subagent owns the prompt. */
export const FOCUSED_AGENT_RUNTIME_SYMBOL = Symbol.for("choco-pi.subagents.focused-agent-runtime");

export interface FocusedAgentRuntime {
  modelId: string;
  modelName: string;
  provider: string;
  thinking: string;
  costTotal: number | null;
  contextPercent: number | null;
  contextWindow: number | null;
  sessionId: string;
  fastModeRequested: boolean;
  fastModeSupported: boolean;
  fastModeActive: boolean;
  fastModeRevision: number;
}

export interface FocusedAgentRuntimeSource {
  current: () => FocusedAgentRuntime | undefined;
}

interface FocusedAgentRuntimeRegistry {
  [FOCUSED_AGENT_RUNTIME_SYMBOL]?: FocusedAgentRuntimeSource;
}

/** Read the record's current child session so replacements and removals are reflected. */
export function focusedAgentRuntime(record: AgentRecord): FocusedAgentRuntime | undefined {
  const session: AgentSession | undefined = record.session;
  if (!session) return undefined;
  const context = getSessionContextUsage(session, session.model?.contextWindow);
  const sessionId = session.sessionManager?.getSessionId?.() ?? "";
  const fastMode = decideSessionFastMode(sessionId, session.model);
  return {
    modelId: session.model?.id ?? "",
    modelName: session.model?.name ?? "",
    provider: session.model?.provider ?? "",
    thinking: session.thinkingLevel,
    costTotal: getSessionCost(session, record.sessionCostBaseline),
    contextPercent: context.percent,
    contextWindow: context.contextWindow,
    sessionId,
    fastModeRequested: fastMode?.requested ?? record.fastModeRequested ?? false,
    fastModeSupported: fastMode?.supported ?? false,
    fastModeActive: fastMode?.active ?? false,
    fastModeRevision: fastMode?.revision ?? record.fastModeRevision ?? 0,
  };
}

/** Publish a live getter and return an ownership-safe cleanup function. */
export function publishFocusedAgentRuntime(
  current: () => FocusedAgentRuntime | undefined,
): () => void {
  const source: FocusedAgentRuntimeSource = { current };
  try {
    // SAFETY: Both packages independently declare the optional Symbol.for slot;
    // this publisher writes only the source shape declared above.
    const registry = globalThis as typeof globalThis & FocusedAgentRuntimeRegistry;
    Object.defineProperty(registry, FOCUSED_AGENT_RUNTIME_SYMBOL, {
      configurable: true,
      writable: true,
      value: source,
    });
    return () => {
      if (registry[FOCUSED_AGENT_RUNTIME_SYMBOL] === source) {
        delete registry[FOCUSED_AGENT_RUNTIME_SYMBOL];
      }
    };
  } catch {
    return () => {};
  }
}
