import { AsyncLocalStorage } from "node:async_hooks";

const childSessionContext = new AsyncLocalStorage<boolean>();

export function inChildSessionContext(): boolean {
  return childSessionContext.getStore() === true;
}

export function runInChildSessionContext<T>(fn: () => Promise<T>): Promise<T> {
  return childSessionContext.run(true, fn);
}

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
