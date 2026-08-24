import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Loose cross-package seam read by editor chrome while a subagent owns the prompt. */
export const FOCUSED_AGENT_RUNTIME_SYMBOL = Symbol.for("choco-pi.subagents.focused-agent-runtime");

export interface FocusedAgentRuntime {
  modelId: string;
  modelName: string;
  provider: string;
  thinking: string;
}

export interface FocusedAgentRuntimeSource {
  current: () => FocusedAgentRuntime;
}

interface FocusedAgentRuntimeRegistry {
  [FOCUSED_AGENT_RUNTIME_SYMBOL]?: FocusedAgentRuntimeSource;
}

/** Read the child session itself so every spawn path and later runtime change is reflected. */
export function focusedAgentRuntime(session: AgentSession): FocusedAgentRuntime {
  return {
    modelId: session.model?.id ?? "",
    modelName: session.model?.name ?? "",
    provider: session.model?.provider ?? "",
    thinking: session.thinkingLevel,
  };
}

/** Publish a live getter and return an ownership-safe cleanup function. */
export function publishFocusedAgentRuntime(current: () => FocusedAgentRuntime): () => void {
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
