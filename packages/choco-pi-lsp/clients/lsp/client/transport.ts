import type { MessageConnection } from "../../deps/vscode-jsonrpc.ts";
import { CancellationTokenSource } from "../../deps/vscode-jsonrpc.ts";
import { isErrorCode, type JsonValue } from "./schemas.ts";

export async function safeSendNotification<P>(
  connection: MessageConnection,
  method: string,
  params: P,
): Promise<boolean> {
  try {
    await connection.sendNotification(method, params);
    return true;
  } catch (err) {
    if (isStreamError(err)) {
      return false;
    }
    throw err;
  }
}

export const activeRequestsByConnection = new WeakMap<MessageConnection, number>();

export async function safeSendRequest<T = JsonValue, P = object>(
  connection: MessageConnection,
  method: string,
  params: P,
  signal?: AbortSignal,
): Promise<T | undefined> {
  if (signal?.aborted) return undefined;

  let tokenSource: InstanceType<typeof CancellationTokenSource> | undefined;
  let onAbort: (() => void) | undefined;
  if (signal) {
    tokenSource = new CancellationTokenSource();
    onAbort = () => tokenSource?.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
  }

  const send = () =>
    tokenSource
      ? connection.sendRequest<T>(method, params, tokenSource.token)
      : connection.sendRequest<T>(method, params);

  activeRequestsByConnection.set(connection, (activeRequestsByConnection.get(connection) ?? 0) + 1);
  try {
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; ; attempt++) {
      try {
        return await send();
      } catch (err) {
        if (isStreamError(err) || isCancellationError(err)) {
          return undefined;
        }
        if (isContentModifiedError(err)) {
          if (attempt < MAX_ATTEMPTS && !signal?.aborted) continue;
          return undefined;
        }
        throw err;
      }
    }
  } finally {
    const remaining = (activeRequestsByConnection.get(connection) ?? 1) - 1;
    if (remaining > 0) activeRequestsByConnection.set(connection, remaining);
    else activeRequestsByConnection.delete(connection);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    tokenSource?.dispose();
  }
}

function isCancellationError<T>(err: T): boolean {
  if (!isErrorCode(err)) return false;
  return err.code === -32800 || err.code === -32802;
}

function isContentModifiedError<T>(err: T): boolean {
  return isErrorCode(err) && err.code === -32801;
}

function isStreamError<T>(err: T): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  const code = isErrorCode(err) ? err.code : undefined;
  return (
    msg.includes("stream") ||
    msg.includes("destroyed") ||
    msg.includes("closed") ||
    msg.includes("disposed") ||
    msg.includes("cancelled") ||
    code === "ERR_STREAM_DESTROYED" ||
    code === "ERR_STREAM_WRITE_AFTER_END" ||
    code === "EPIPE"
  );
}
