/**
 * Per-session refresh of provider-native compaction state.
 *
 * Every extension that keeps provider-native replay state for a session
 * (this package's Anthropic and xAI replay bindings, the Codex package's
 * committed-checkpoint restore) registers a refresher under that session's ID.
 * `refreshSessionNativeState` runs them all, so a caller that knows only the
 * session — the subagent bridge reattaching a child after cancel or resume —
 * can restore the session's committed native checkpoints without importing any
 * provider package.
 *
 * The table is process-global: each AgentSession runs its own extension
 * factories, and extension copies may load through separate module instances.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { isStaleContextError } from "../lifecycle.ts";

/** The context a refresher reads; a live `ExtensionContext` satisfies it. */
export type NativeRefreshContext = Pick<
  ExtensionContext,
  "sessionManager" | "model" | "modelRegistry" | "cwd" | "isProjectTrusted"
> & { readonly ui: Pick<ExtensionContext["ui"], "notify"> };

/** Restores one contributor's native state for the session it was registered under. */
export type SessionNativeRefresher = (ctx: NativeRefreshContext) => void | Promise<void>;

const NATIVE_REFRESHERS_SYMBOL = Symbol.for("choco-pi:compaction-native-session-refreshers");

type RefresherTable = Map<string, Map<string, SessionNativeRefresher>>;

const RefresherSchema = Type.Function([Type.Unknown()], Type.Unknown());

function isRefresherTable<T>(value: T): value is T & RefresherTable {
  if (!(value instanceof Map)) return false;
  for (const [sessionId, contributors] of value) {
    if (!Value.Check(Type.String({ minLength: 1 }), sessionId)) return false;
    if (!(contributors instanceof Map)) return false;
    for (const [id, refresher] of contributors) {
      if (!Value.Check(Type.String({ minLength: 1 }), id)) return false;
      if (!Value.Check(RefresherSchema, refresher)) return false;
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

/**
 * Register `contributorId`'s refresher for `sessionId`, replacing that
 * contributor's previous one. The returned unregister removes only this exact
 * refresher, so an older registration's cleanup never drops a newer one.
 */
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

/** Contributor IDs registered for a session (diagnostics and tests). */
export function sessionNativeRefreshers(sessionId: string): readonly string[] {
  return [...(refresherTable().get(sessionId)?.keys() ?? [])];
}

/**
 * Re-run every registered native-state restore for `sessionId` with `ctx`
 * (the session's own context). Contributors run in registration order; each
 * rechecks its own lifecycle, so a refresher whose session was replaced does
 * nothing. A stale-context failure is contained; any other failure is
 * rethrown after every contributor ran (an `AggregateError` when several fail).
 */
export async function refreshSessionNativeState(
  sessionId: string,
  ctx: NativeRefreshContext,
): Promise<void> {
  // Snapshot before the first await: a contributor may unregister while another runs.
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
