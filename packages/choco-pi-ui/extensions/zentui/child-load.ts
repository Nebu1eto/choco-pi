const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");

type ChildContextRegistry = { isChildSessionContext: () => boolean };

type RegistryCandidate = {} | null | undefined;

function isChildContextRegistry(entry: RegistryCandidate): entry is ChildContextRegistry {
  const boxed: { isChildSessionContext?: RegistryCandidate } = Object(entry);
  if (boxed !== entry || boxed instanceof Function) return false;
  return boxed.isChildSessionContext instanceof Function;
}

export function inSubagentChildLoad(): boolean {
  const entry: RegistryCandidate = Object.getOwnPropertyDescriptor(
    globalThis,
    SUBAGENTS_MANAGER_KEY,
  )?.value;
  if (!isChildContextRegistry(entry)) return false;
  return entry.isChildSessionContext() === true;
}
