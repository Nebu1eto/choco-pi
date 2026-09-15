import { Type } from "typebox";
import { Value } from "typebox/value";

export type WebSearchEntitlement = "unknown" | "subscription" | "pay-as-you-go";

export const SYNTHETIC_WEB_SEARCH_TOOL = "synthetic_web_search";

const PREFIX_LOCK_SYMBOL = Symbol.for("choco-pi.prefix.locked");
const PrefixLockSchema = Type.Object({
  isLocked: Type.Function([], Type.Boolean()),
});

export interface WebSearchActivationHost {
  getAllTools: () => Array<{ name: string }>;
  getActiveTools: () => string[];
  setActiveTools: (names: string[]) => void;
}

function isPrefixLocked(): boolean {
  const prefixLock = Object.getOwnPropertyDescriptor(globalThis, PREFIX_LOCK_SYMBOL)?.value;
  return Value.Check(PrefixLockSchema, prefixLock) && prefixLock.isLocked() === true;
}

export function shouldActivateWebSearch(
  enabled: boolean,
  entitlement: WebSearchEntitlement,
): boolean {
  return enabled && entitlement === "subscription";
}

export function syncToolActivation(pi: WebSearchActivationHost, active: boolean): void {
  if (isPrefixLocked()) return;
  const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
  const activeTools = new Set(pi.getActiveTools());

  if (!allToolNames.has(SYNTHETIC_WEB_SEARCH_TOOL)) return;

  if (active) {
    activeTools.add(SYNTHETIC_WEB_SEARCH_TOOL);
  } else {
    activeTools.delete(SYNTHETIC_WEB_SEARCH_TOOL);
  }

  pi.setActiveTools([...activeTools].filter((name) => allToolNames.has(name)));
}
