import { isFunction, reinterpretHostValue, type RuntimeValue } from "./runtime-values.ts";

/**
 * Read-only access to the running sub-agent manager.
 *
 * choco-pi-subagents publishes itself on a process-global symbol slot, matched
 * by literal string, and that published entry is the only seam other extensions
 * may use. `waitForAll`, `spawn`, and `getRecord` are also on it; nothing here
 * needs them, and none of them would answer "what did this session cost" — the
 * entry offers no roster, and records are evicted minutes after an agent ends.
 * So the live manager is consulted for one thing only: whether work is still in
 * flight, which tells the reader that a transcript-derived total is still moving.
 */
const MANAGER_KEY = Symbol.for("pi-subagents:manager");

type SubagentManagerEntry = { hasRunning?: () => RuntimeValue };

type ManagerRegistry = { [key: symbol]: SubagentManagerEntry | undefined };

function managerEntry(): SubagentManagerEntry | undefined {
  const registry = reinterpretHostValue<ManagerRegistry>(globalThis);
  return registry[MANAGER_KEY];
}

/** True when at least one sub-agent is queued or running right now. */
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
