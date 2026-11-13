/**
 * Process-global registry published by choco-pi-subagents. Its
 * `isChildSessionContext()` reports whether the current async context is
 * building a subagent child session, which is where that child's extension
 * factories run.
 */
const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");

type ChildContextRegistry = { isChildSessionContext: () => boolean };

type RegistryCandidate = {} | null | undefined;

/** Open object (extra keys allowed, like the former schema) whose `isChildSessionContext` is callable. */
function isChildContextRegistry(entry: RegistryCandidate): entry is ChildContextRegistry {
  const boxed: { isChildSessionContext?: RegistryCandidate } = Object(entry);
  if (boxed !== entry || boxed instanceof Function) return false;
  return boxed.isChildSessionContext instanceof Function;
}

/**
 * True while a subagent child loads its extensions in this process. Absent or
 * malformed registries mean "not a child".
 */
export function inSubagentChildLoad(): boolean {
  const entry: RegistryCandidate = Object.getOwnPropertyDescriptor(
    globalThis,
    SUBAGENTS_MANAGER_KEY,
  )?.value;
  if (!isChildContextRegistry(entry)) return false;
  return entry.isChildSessionContext() === true;
}
