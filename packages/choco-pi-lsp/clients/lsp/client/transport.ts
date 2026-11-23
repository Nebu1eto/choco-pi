/**
 * JSON-RPC send wrappers with active-request tracking and transport error classification.
 */
import type { MessageConnection } from "../../deps/vscode-jsonrpc.ts";
// vscode-jsonrpc v9 ships an `exports` map exposing the Node entry as the
// `./node` subpath (no `.js`); the old `/node.js` file path no longer resolves.
import { CancellationTokenSource } from "../../deps/vscode-jsonrpc.ts";
import { isErrorCode, type JsonValue } from "./schemas.ts";

// Helper to safely send notifications - catches stream destruction
/**
 * Returns `true` once the notification was actually handed to the transport,
 * `false` when a stream error was swallowed (connection error handlers will
 * update state separately). #1669 review F7: callers that mirror what they
 * just told the server locally (`recordSentContent`) MUST gate on this
 * return value — recording a send that never left the process would desync
 * the mirror from what the server actually has, with nothing to self-heal
 * it (the next Incremental range would be computed against content the
 * server never saw).
 */
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
      // Silently ignore - stream was destroyed, connection error handlers will update state
      return false;
    }
    throw err;
  }
}

export const activeRequestsByConnection = new WeakMap<MessageConnection, number>();

// Helper to safely send requests - catches stream destruction
export async function safeSendRequest<T = JsonValue, P = object>(
  connection: MessageConnection,
  method: string,
  params: P,
  // When provided, aborting the signal cancels the in-flight request via
  // vscode-jsonrpc's CancellationToken → an LSP `$/cancelRequest` notification,
  // so a server stops computing a result the agent has already abandoned (#238
  // Item 1). The rejection that follows is swallowed (treated as `undefined`).
  signal?: AbortSignal,
): Promise<T | undefined> {
  // Already abandoned before we even sent — don't bother the server.
  if (signal?.aborted) return undefined;

  let tokenSource: InstanceType<typeof CancellationTokenSource> | undefined;
  let onAbort: (() => void) | undefined;
  if (signal) {
    tokenSource = new CancellationTokenSource();
    onAbort = () => tokenSource?.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
  }

  // Only pass a token when cancellation is wired, so the call shape is unchanged
  // for the (many) requests without a signal.
  const send = () =>
    tokenSource
      ? connection.sendRequest<T>(method, params, tokenSource.token)
      : connection.sendRequest<T>(method, params);

  activeRequestsByConnection.set(connection, (activeRequestsByConnection.get(connection) ?? 0) + 1);
  try {
    // One safe retry on ContentModified (-32801): the document changed under
    // us, so the server discarded the request. A single retry beats returning
    // empty — correctness-under-edit is choco-pi-lsp's whole hot path (#238 Item 2).
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; ; attempt++) {
      try {
        return await send();
      } catch (err) {
        if (isStreamError(err) || isCancellationError(err)) {
          // Stream destroyed, or we cancelled the request on abort — either
          // way there is no result to return.
          return undefined;
        }
        if (isContentModifiedError(err)) {
          // Retry once (unless we've since been aborted); if it's still
          // ContentModified after that, return empty rather than throwing a
          // code callers don't understand. RequestFailed (-32803) and other
          // codes are permanent and fall through to the rethrow below.
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

// vscode-jsonrpc rejects a token-cancelled request with a `ResponseError` whose
// code is `RequestCancelled` (-32800) or `ServerCancelled` (-32802). Treat both
// as "no result" rather than a failure. (isStreamError also matches the
// "cancelled" message text; this adds the structured error-code path.)
function isCancellationError<T>(err: T): boolean {
  if (!isErrorCode(err)) return false;
  return err.code === -32800 || err.code === -32802;
}

// `ContentModified` (-32801): the document changed while the request was in
// flight, so the server couldn't answer against a consistent state. Retryable —
// the only LSP error code worth a second attempt on the edit hot path (#238).
function isContentModifiedError<T>(err: T): boolean {
  return isErrorCode(err) && err.code === -32801;
}

// Helper to detect stream destruction / connection disposal errors.
// vscode-jsonrpc throws these when the LSP server process exits while
// requests are still in flight:
//   "Connection is disposed."
//   "Pending response rejected since connection got disposed"
// Neither phrase contains "stream", "destroyed", or "closed", which is
// why we must also match "disposed" and "cancelled" here.
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
