import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marks resource loading/session construction performed for a subagent. This is
 * async-context-local so concurrent top-level extension work is unaffected.
 */
const childSessionContext = new AsyncLocalStorage<boolean>();

export function inChildSessionContext(): boolean {
  return childSessionContext.getStore() === true;
}

export function runInChildSessionContext<T>(fn: () => Promise<T>): Promise<T> {
  return childSessionContext.run(true, fn);
}

/**
 * Session ids of live child sessions created by the runner. Registered right
 * after `createAgentSession` and before `bindExtensions`, so root extensions
 * that initialise inside the child (outside the async child context) can still
 * recognise it by id. Removed when the manager disposes the session.
 */
const childSessionIds = new Set<string>();

export function registerChildSessionId(id: string): void {
  childSessionIds.add(id);
}

export function unregisterChildSessionId(id: string): void {
  childSessionIds.delete(id);
}

export function isChildSessionId(id: string): boolean {
  return childSessionIds.has(id);
}
