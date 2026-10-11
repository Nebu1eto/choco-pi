import { Type } from "typebox";
import { Value } from "typebox/value";

const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");
const ChildSessionRegistrySchema = Type.Object({
  isChildSessionId: Type.Function([Type.String()], Type.Boolean()),
});

/**
 * Ask the process-global subagents registry whether a session id belongs to a
 * live child session. The registry is the identity source shared across module
 * instances; an async-context marker alone can miss children whose extensions
 * load outside that context. Absent or malformed registries mean "not a child".
 */
export function isRegisteredChildSession(sessionId: string): boolean {
  const entry: unknown = Object.getOwnPropertyDescriptor(globalThis, SUBAGENTS_MANAGER_KEY)?.value;
  if (!Value.Check(ChildSessionRegistrySchema, entry)) return false;
  return entry.isChildSessionId(sessionId) === true;
}
