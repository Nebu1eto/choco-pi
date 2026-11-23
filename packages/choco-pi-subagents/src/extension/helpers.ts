/**
 * Stateless helpers shared by the extension modules: tool results, activity tracking, and labels.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { FleetPanelUICtx } from "../ui/fleet-panel.ts";
import { type AgentDetails, formatTokens, type AgentActivity } from "../ui/agent-widget.ts";
import { type LifetimeUsage, getLifetimeTotal, addUsage } from "../usage.ts";
import type { AgentConfig } from "../types.ts";
import { BUILTIN_TOOL_NAMES } from "../agent-types.ts";

// ---- Shared helpers ----

export interface FleetPanelUIContext {
  ui: FleetPanelUICtx;
}

/** Tool execute return value for a text response. */
export function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details };
}

/** A failed tool call; `isError` lets the exec bridge raise it instead of returning text. */
/** A workflow gate key split into its provider and, when present, model id. */
export type GateKeyParts = { provider: string; modelId?: string };

/** Splits a workflow gate key (`<provider>` or `<provider>/<model id>`) at its first slash. */
export function splitGateKey(gateKey: string): GateKeyParts {
  const slash = gateKey.indexOf("/");
  if (slash <= 0 || slash === gateKey.length - 1) return { provider: gateKey };
  return { provider: gateKey.slice(0, slash), modelId: gateKey.slice(slash + 1) };
}

export function errorResult(msg: string) {
  return { ...textResult(msg), isError: true };
}

/** Format an agent's lifetime token total, or "" when zero. */
export function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by both foreground and background paths to avoid duplication.
 */
export function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) {
            state.activeTools.delete(key);
            break;
          }
        }
        state.toolUses++;
      }
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: AgentSession) => {
      state.session = session;
    },
    onAssistantUsage: (usage: { input: number; output: number; cacheWrite: number }) => {
      addUsage(state.lifetimeUsage, usage);
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}

/**
 * Format an agent's tool scope for the Agent tool description.
 *
 * This suffix describes BUILT-IN scope only — extension tools are resolved when
 * the agent runs (extensions can register asynchronously), so they cannot be
 * enumerated while the description is being built. That is why an agent with
 * `tools: "*, ext:mcp/search"` renders "*" and always has.
 *
 * Two distinctions matter, both of them capability claims the orchestrator acts on:
 *
 * - absent vs empty. `builtinToolNames: undefined` means the agent never narrowed
 *   its tools (the shipped defaults); `[]` is what `tools: none` and an `ext:`-only
 *   `tools:` parse to, and the runtime really does hand those agents no built-ins.
 *   Rendering both "*" tells the orchestrator a tool-less agent can run `bash`.
 * - empty-with-extensions vs empty-without. Zero built-ins does NOT imply zero
 *   tools: `tools: none` alongside `extensions:` still surfaces every extension
 *   tool (see test/fixtures/.pi/agents/tools-none.md, which expects three). Calling
 *   that "none" understates the agent instead of overstating it — better, but still
 *   wrong, and it would route work away from the only agent able to do it. "none"
 *   is therefore reserved for agents that genuinely can call nothing: `isolated`
 *   agents and those with `extensions: false`.
 */
export function formatToolsSuffix(cfg: AgentConfig | undefined): string {
  const tools = cfg?.builtinToolNames;
  if (!tools) return "*";
  if (tools.length === 0) {
    // `isolated` overrides extensions to false in the runner, so both mean the
    // agent has no extension tools either — and then it truly has nothing.
    const noExtensionTools = cfg?.isolated === true || cfg?.extensions === false;
    return noExtensionTools ? "none" : "no built-ins, extension tools only";
  }
  const isFullSet =
    tools.length === BUILTIN_TOOL_NAMES.length &&
    BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
  return isFullSet ? "*" : tools.join(", ");
}

export function getModelLabelFromConfig(model: string): string {
  const name = model.split("/").at(-1) ?? model;
  return name.replace(/-\d{8}$/, "");
}
