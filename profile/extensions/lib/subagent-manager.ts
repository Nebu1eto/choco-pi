import { isFunction, reinterpretHostValue, type RuntimeValue } from "./runtime-values.ts";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

type SubagentManagerEntry = { hasRunning?: () => RuntimeValue };

type ManagerRegistry = { [key: symbol]: SubagentManagerEntry | undefined };

function managerEntry(): SubagentManagerEntry | undefined {
  const registry = reinterpretHostValue<ManagerRegistry>(globalThis);
  return registry[MANAGER_KEY];
}

export function hasRunningSubagents(): boolean {
  const entry = managerEntry();
  if (!entry) return false;
  const hasRunning = entry.hasRunning;
  if (!isFunction(hasRunning)) return false;
  try {
    return hasRunning.call(entry) === true;
  } catch {
    return false;
  }
}
