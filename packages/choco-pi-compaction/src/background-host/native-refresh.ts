import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isFunction, isNonEmptyString } from "../guards.ts";

import { isStaleContextError } from "@choco-pi/shared/lifecycle";

export type NativeRefreshContext = Pick<
  ExtensionContext,
  "sessionManager" | "model" | "modelRegistry" | "cwd" | "isProjectTrusted"
> & { readonly ui: Pick<ExtensionContext["ui"], "notify"> };

export type SessionNativeRefresher = (ctx: NativeRefreshContext) => void | Promise<void>;

const NATIVE_REFRESHERS_SYMBOL = Symbol.for("choco-pi:compaction-native-session-refreshers");

type RefresherTable = Map<string, Map<string, SessionNativeRefresher>>;

function isRefresherTable<T>(value: T): value is T & RefresherTable {
  if (!(value instanceof Map)) return false;
  for (const [sessionId, contributors] of value) {
    if (!isNonEmptyString(sessionId)) return false;
    if (!(contributors instanceof Map)) return false;
    for (const [id, refresher] of contributors) {
      if (!isNonEmptyString(id)) return false;
      if (!isFunction(refresher)) return false;
    }
  }
  return true;
}

function refresherTable(): RefresherTable {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, NATIVE_REFRESHERS_SYMBOL);
  const found: unknown = descriptor?.value;
  if (isRefresherTable(found)) return found;
  if (descriptor !== undefined) throw new Error("Invalid native compaction refresher table");
  const table: RefresherTable = new Map();
  Object.defineProperty(globalThis, NATIVE_REFRESHERS_SYMBOL, { value: table, configurable: true });
  return table;
}

export function registerSessionNativeRefresher(
  sessionId: string,
  contributorId: string,
  refresher: SessionNativeRefresher,
): () => void {
  const table = refresherTable();
  let contributors = table.get(sessionId);
  if (contributors === undefined) {
    contributors = new Map();
    table.set(sessionId, contributors);
  }
  contributors.set(contributorId, refresher);
  return () => {
    const current = table.get(sessionId);
    if (current?.get(contributorId) !== refresher) return;
    current.delete(contributorId);
    if (current.size === 0) table.delete(sessionId);
  };
}

export function sessionNativeRefreshers(sessionId: string): readonly string[] {
  return [...(refresherTable().get(sessionId)?.keys() ?? [])];
}

export async function refreshSessionNativeState(
  sessionId: string,
  ctx: NativeRefreshContext,
): Promise<void> {
  const refreshers = [...(refresherTable().get(sessionId)?.values() ?? [])];
  const failures: Error[] = [];
  for (const refresher of refreshers) {
    try {
      await refresher(ctx);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (!isStaleContextError(error)) failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Native compaction state refresh failed");
  }
}
