const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");

interface ChildSessionRegistryCandidate {
  isChildSessionId?: unknown;
}

export function isRegisteredChildSession(sessionId: string): boolean {
  const entry: unknown = Object.getOwnPropertyDescriptor(globalThis, SUBAGENTS_MANAGER_KEY)?.value;
  const candidate: ChildSessionRegistryCandidate = Object(entry);
  if (candidate !== entry || candidate instanceof Function || Array.isArray(candidate))
    return false;
  const probe = candidate.isChildSessionId;
  if (!(probe instanceof Function)) return false;
  return probe.call(candidate, sessionId) === true;
}
