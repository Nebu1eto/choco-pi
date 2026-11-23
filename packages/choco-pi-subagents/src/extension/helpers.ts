import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { FleetPanelUICtx } from "../ui/fleet-panel.ts";
import { type AgentDetails, formatTokens, type AgentActivity } from "../ui/agent-widget.ts";
import { type LifetimeUsage, getLifetimeTotal, addUsage } from "../usage.ts";
import type { AgentConfig } from "../types.ts";
import { BUILTIN_TOOL_NAMES } from "../agent-types.ts";

export interface FleetPanelUIContext {
  ui: FleetPanelUICtx;
}

export function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details };
}

export type GateKeyParts = { provider: string; modelId?: string };

export function splitGateKey(gateKey: string): GateKeyParts {
  const slash = gateKey.indexOf("/");
  if (slash <= 0 || slash === gateKey.length - 1) return { provider: gateKey };
  return { provider: gateKey.slice(0, slash), modelId: gateKey.slice(slash + 1) };
}

export function errorResult(msg: string) {
  return { ...textResult(msg), isError: true };
}

export function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

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

export function formatToolsSuffix(cfg: AgentConfig | undefined): string {
  const tools = cfg?.builtinToolNames;
  if (!tools) return "*";
  if (tools.length === 0) {
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
