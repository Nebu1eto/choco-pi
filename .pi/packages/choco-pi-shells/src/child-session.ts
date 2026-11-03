const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");

interface ChildSessionRegistryCandidate {
  isChildSessionId?: unknown;
}

/**
 * Ask the process-global subagents registry whether a session id belongs to a
 * live child session. The registry is the identity source shared across module
 * instances; an async-context marker alone can miss children whose extensions
 * load outside that context. Absent or malformed registries mean "not a child".
 */
export function isRegisteredChildSession(sessionId: string): boolean {
  const entry: unknown = Object.getOwnPropertyDescriptor(globalThis, SUBAGENTS_MANAGER_KEY)?.value;
  // Object() boxes primitives, so the identity check keeps only real objects.
  const candidate: ChildSessionRegistryCandidate = Object(entry);
  if (candidate !== entry || candidate instanceof Function || Array.isArray(candidate))
    return false;
  const probe = candidate.isChildSessionId;
  if (!(probe instanceof Function)) return false;
  return probe.call(candidate, sessionId) === true;
}
