import { Type } from "typebox";
import { Check } from "typebox/value";

/**
 * Process-global registry published by choco-pi-subagents. Its
 * `isChildSessionContext()` reports whether the current async context is
 * building a subagent child session, which is where that child's extension
 * factories run.
 */
const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");
const ChildContextRegistrySchema = Type.Object({
  isChildSessionContext: Type.Function([], Type.Boolean()),
});

/**
 * True while a subagent child loads its extensions in this process. Absent or
 * malformed registries mean "not a child".
 */
export function inSubagentChildLoad(): boolean {
  const entry: unknown = Object.getOwnPropertyDescriptor(globalThis, SUBAGENTS_MANAGER_KEY)?.value;
  if (!Check(ChildContextRegistrySchema, entry)) return false;
  return entry.isChildSessionContext() === true;
}
