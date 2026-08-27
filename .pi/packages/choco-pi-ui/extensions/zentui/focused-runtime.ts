import { buildCostLabel } from "./format";
import {
  type BoundaryValue,
  isBoundaryRecord,
  isCallable,
  isNumber,
  isString,
} from "./runtime-values";

const FOCUSED_AGENT_RUNTIME_SYMBOL = Symbol.for("choco-pi.subagents.focused-agent-runtime");

export type FocusedAgentRuntime = {
  modelId: string;
  modelName: string;
  provider: string;
  thinking: string;
  costTotal: number | null;
  contextPercent: number | null;
  contextWindow: number | null;
};

type FocusedAgentRuntimeRegistry = {
  [FOCUSED_AGENT_RUNTIME_SYMBOL]?: BoundaryValue;
};

export type FocusScopedUsage = {
  costLabel?: string;
  contextPercent?: number | null;
  contextWindow?: number | null;
};

function validModelString(value: BoundaryValue): value is string {
  return isString(value);
}

function validUsageNumber(value: BoundaryValue, allowZero: boolean): number | null {
  if (!isNumber(value) || !Number.isFinite(value)) return null;
  if (allowZero) return value >= 0 ? value : null;
  return value > 0 ? value : null;
}

/** Defensively consume the optional focused-agent publisher at the host boundary. */
export function readFocusedAgentRuntime(): FocusedAgentRuntime | undefined {
  try {
    // SAFETY: The optional symbol slot remains a BoundaryValue until every consumed member passes a boundary guard.
    const registry = globalThis as typeof globalThis & FocusedAgentRuntimeRegistry;
    const source = registry[FOCUSED_AGENT_RUNTIME_SYMBOL];
    if (!isBoundaryRecord(source) || !isCallable(source["current"])) return undefined;
    const value = source["current"]();
    if (!isBoundaryRecord(value)) return undefined;

    const modelId = value["modelId"];
    const modelName = value["modelName"];
    const provider = value["provider"];
    const thinking = value["thinking"];
    if (
      !validModelString(modelId) ||
      !validModelString(modelName) ||
      !validModelString(provider) ||
      !validModelString(thinking)
    ) {
      return undefined;
    }

    return {
      modelId,
      modelName,
      provider,
      thinking,
      costTotal: validUsageNumber(value["costTotal"], true),
      contextPercent: validUsageNumber(value["contextPercent"], true),
      contextWindow: validUsageNumber(value["contextWindow"], false),
    };
  } catch {
    return undefined;
  }
}

/** Select focused usage without ever falling back field-by-field to main usage. */
export function selectFocusScopedUsage(main: FocusScopedUsage): FocusScopedUsage {
  const focused = readFocusedAgentRuntime();
  if (!focused) return main;
  return {
    costLabel: focused.costTotal === null ? "" : buildCostLabel({ cost: focused.costTotal }),
    contextPercent: focused.contextPercent,
    contextWindow: focused.contextWindow,
  };
}
