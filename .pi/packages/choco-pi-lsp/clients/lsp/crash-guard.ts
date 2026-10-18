/**
 * Process-wide guard against vscode-jsonrpc stream teardown crashes.
 *
 * Pi can evaluate this package's module graph more than once per process (an
 * in-process session with another cwd re-evaluates every extension through
 * jiti without a module cache). A module-local "installed" flag therefore let
 * every evaluation add its own `uncaughtException`/`unhandledRejection`
 * listeners, and each listener's closure pinned that whole module graph for
 * the process lifetime. The guard's behavior is identical for every
 * evaluation, so one installation per process is sufficient.
 *
 * This module depends only on typebox and its handlers capture only the
 * classifier below: the first evaluation's listeners are the only ones ever
 * installed, so at most one small module instance stays reachable from them.
 */

import { Type } from "typebox";
import { Value } from "typebox/value";

const CRASH_GUARD_MARKER = Symbol.for("choco-pi-lsp.lsp-crash-guard.installed");

const ErrorCodeSchema = Type.Object(
  {
    code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  },
  { additionalProperties: true },
);

const LSP_CRASH_CODES = new Set([
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
  "EPIPE",
  "ECONNRESET",
]);

export function isIgnorableLspRuntimeCrash<T>(err: T): boolean {
  if (!(err instanceof Error)) return false;
  const code = Value.Check(ErrorCodeSchema, err) ? err.code : undefined;
  if (Value.Check(Type.String(), code) && LSP_CRASH_CODES.has(code)) return true;
  const msg = err.message.toLowerCase();
  const stack = (err.stack ?? "").toLowerCase();
  return (
    msg.includes("stream") ||
    msg.includes("write after end") ||
    stack.includes("vscode-jsonrpc/lib/node/ril.js")
  );
}

/** Whether any evaluation of this package already installed the guard. */
export function isLspCrashGuardInstalled(): boolean {
  return Object.hasOwn(process, CRASH_GUARD_MARKER);
}

/** Install the crash guard at most once per process, across module graphs. */
export function installLspCrashGuard(): void {
  if (isLspCrashGuardInstalled()) return;
  Object.defineProperty(process, CRASH_GUARD_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  process.on("uncaughtException", (err) => {
    if (isIgnorableLspRuntimeCrash(err)) {
      return;
    }
    throw err;
  });

  process.on("unhandledRejection", (reason) => {
    if (isIgnorableLspRuntimeCrash(reason)) {
      return;
    }
    throw reason instanceof Error ? reason : new Error(String(reason));
  });
}
