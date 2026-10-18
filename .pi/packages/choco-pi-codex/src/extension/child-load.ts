import { Type } from "typebox";
import { Value } from "typebox/value";

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
 * malformed registries mean "not a child". Process-global slots that serve the
 * main session must not be replaced from here: the child's runtime is disposed
 * long before the main session stops calling into the slot.
 */
export function inSubagentChildLoad(): boolean {
  const entry: unknown = Object.getOwnPropertyDescriptor(globalThis, SUBAGENTS_MANAGER_KEY)?.value;
  if (!Value.Check(ChildContextRegistrySchema, entry)) return false;
  return entry.isChildSessionContext() === true;
}
