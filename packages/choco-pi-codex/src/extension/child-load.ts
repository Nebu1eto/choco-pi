import { isJsonObject, type BoundaryValue } from "@choco-pi/code-mode/runtime-values";

interface ChildContextRegistry {
  isChildSessionContext(): BoundaryValue;
}

function isChildContextRegistry<T>(value: T): value is T & ChildContextRegistry {
  return isJsonObject(value) && value["isChildSessionContext"] instanceof Function;
}

const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");

export function inSubagentChildLoad(): boolean {
  const entry: unknown = Object.getOwnPropertyDescriptor(globalThis, SUBAGENTS_MANAGER_KEY)?.value;
  if (!isChildContextRegistry(entry)) return false;
  return entry.isChildSessionContext() === true;
}
