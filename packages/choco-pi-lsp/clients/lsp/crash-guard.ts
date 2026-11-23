import { obj, opt, str, union, compile } from "@earendil-works/pi-schema";
import { finiteNum } from "./schema-guards.ts";
import { isRuntimeString } from "../../tools/runtime-values.ts";

const CRASH_GUARD_MARKER = Symbol.for("choco-pi-lsp.lsp-crash-guard.installed");

const ErrorCodeSchema = obj(
  {
    code: opt(union([str(), finiteNum()])),
  },
  { open: true },
);
const isErrorCode = compile(ErrorCodeSchema).check;

const LSP_CRASH_CODES = new Set([
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
  "EPIPE",
  "ECONNRESET",
]);

export function isIgnorableLspRuntimeCrash<T>(err: T): boolean {
  if (!(err instanceof Error)) return false;
  const code = isErrorCode(err) ? err.code : undefined;
  if (isRuntimeString(code) && LSP_CRASH_CODES.has(code)) return true;
  const msg = err.message.toLowerCase();
  const stack = (err.stack ?? "").toLowerCase();
  return (
    msg.includes("stream") ||
    msg.includes("write after end") ||
    stack.includes("vscode-jsonrpc/lib/node/ril.js")
  );
}

export function isLspCrashGuardInstalled(): boolean {
  return Object.hasOwn(process, CRASH_GUARD_MARKER);
}

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
