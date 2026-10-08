import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  CodexStreamEventSchema,
  type CodexStreamEvent,
  type WebSocketEvent,
  type WebSocketLike,
} from "./types.ts";
import { DEFAULT_WEBSOCKET_CLOSE_TIMEOUT_MS } from "./constants.ts";
import {
  extractWebSocketCloseError,
  extractWebSocketError,
  isWebSocketMessageTooBigError,
} from "./websocket-connection.ts";
import { extractCodexTurnStateFromWebSocketEvent } from "./turn-state.ts";

const StringSchema = Type.String();
const ArrayBufferDataSchema = Type.Object({
  arrayBuffer: Type.Function([], Type.Unknown()),
});

export async function decodeWebSocketData(data: WebSocketEvent["data"]): Promise<string | null> {
  if (Check(StringSchema, data)) return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (Check(ArrayBufferDataSchema, data)) {
    const arrayBuffer = await data.arrayBuffer();
    if (arrayBuffer instanceof ArrayBuffer) {
      return new TextDecoder().decode(new Uint8Array(arrayBuffer));
    }
  }
  return null;
}

export function parseWebSocket(
  socket: WebSocketLike,
  signal: AbortSignal | undefined,
  idleTimeoutMs?: number,
  onTurnState?: (value: string) => void,
): AsyncIterable<CodexStreamEvent> {
  const queue: CodexStreamEvent[] = [];
  let pending: (() => void) | null = null;
  let done = false;
  let returning = false;
  let failed: Error | null = null;
  let closeError: Error | null = null;
  let sawCompletion = false;
  let idleTimedOut = false;
  let pendingMessages = 0;
  let messageChain = Promise.resolve();
  let socketError: Error | null = null;
  let socketErrorTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let active = true;

  const invalidate = () => {
    active = false;
    generation++;
    pendingMessages = 0;
  };
  const owns = (owner: number) => active && generation === owner && !signal?.aborted;

  const wake = () => {
    if (!pending) return;
    const resolve = pending;
    pending = null;
    resolve();
  };

  const onMessage = (event: WebSocketEvent) => {
    const owner = generation;
    const data = event.data;
    if (!owns(owner)) return;
    pendingMessages++;
    wake();
    messageChain = messageChain
      .then(async () => {
        if (!owns(owner)) return;
        const text = await decodeWebSocketData(data);
        if (!owns(owner) || !text) return;
        let parsed: CodexStreamEvent;
        try {
          const candidate: object = JSON.parse(text);
          if (!Check(CodexStreamEventSchema, candidate)) return;
          parsed = candidate;
        } catch {
          // Codex ignores malformed individual events and keeps the live stream.
          return;
        }
        const turnState = extractCodexTurnStateFromWebSocketEvent(parsed);
        if (turnState) onTurnState?.(turnState);
        if (!owns(owner)) return;
        const type = parsed.type ?? "";
        if (
          type === "response.completed" ||
          type === "response.done" ||
          type === "response.incomplete"
        ) {
          sawCompletion = true;
          closeError = null;
          done = true;
        }
        queue.push(parsed);
        if (sawCompletion) {
          invalidate();
          wake();
        }
      })
      .catch((error) => {
        if (!owns(owner)) return;
        failed = error instanceof Error ? error : new Error(String(error));
        done = true;
        invalidate();
        wake();
      })
      .finally(() => {
        if (!owns(owner)) return;
        pendingMessages--;
        wake();
      });
  };

  const onError = (event: WebSocketEvent) => {
    const owner = generation;
    if (!owns(owner)) return;
    socketError = extractWebSocketError(event);
    if (socketErrorTimer) clearTimeout(socketErrorTimer);
    socketErrorTimer = setTimeout(() => {
      if (!owns(owner)) return;
      failed = socketError;
      done = true;
      invalidate();
      wake();
    }, DEFAULT_WEBSOCKET_CLOSE_TIMEOUT_MS);
  };

  const onClose = (event: WebSocketEvent) => {
    if (!active) return;
    if (socketErrorTimer) clearTimeout(socketErrorTimer);
    if (sawCompletion) {
      done = true;
      wake();
      return;
    }
    if (!closeError) {
      const error = extractWebSocketCloseError(event);
      if (isWebSocketMessageTooBigError(error)) {
        failed = null;
        closeError = error;
      } else if (socketError) {
        failed = socketError;
      } else {
        closeError = error;
      }
    }
    done = true;
    wake();
  };

  const onAbort = () => {
    invalidate();
    failed = new Error("Request was aborted");
    done = true;
    wake();
  };

  async function* events(): AsyncGenerator<CodexStreamEvent> {
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);

    try {
      while (true) {
        if (returning) return;
        if (signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (queue.length > 0) {
          const event = queue.shift();
          if (event) yield event;
          continue;
        }
        if (failed && (pendingMessages === 0 || idleTimedOut)) break;
        if (done && pendingMessages === 0) break;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>((resolve) => {
          pending = resolve;
          if (idleTimeoutMs && idleTimeoutMs > 0) {
            timeout = setTimeout(() => {
              invalidate();
              idleTimedOut = true;
              failed = new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
              done = true;
              wake();
            }, idleTimeoutMs);
          }
        }).finally(() => {
          if (timeout) clearTimeout(timeout);
        });
      }

      if (failed) throw failed;
      if (closeError && !sawCompletion) throw closeError;
      if (!sawCompletion) {
        throw new Error("WebSocket stream closed before response.completed");
      }
    } finally {
      invalidate();
      if (socketErrorTimer) clearTimeout(socketErrorTimer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  const iterator = events();
  // A generator suspended at an internal await cannot observe return() until next() settles.
  // This wrapper invalidates ownership synchronously and wakes the loop to exit;
  // any later decode continuation sees stale ownership and cannot mutate the stream.
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => iterator.next(),
        return: () => {
          returning = true;
          invalidate();
          wake();
          return iterator.return(undefined);
        },
      };
    },
  };
}

export async function* startWebSocketOutputOnFirstEvent(
  events: AsyncIterable<CodexStreamEvent>,
  onStart: () => void,
): AsyncIterable<CodexStreamEvent> {
  let started = false;
  for await (const event of events) {
    if (!started) {
      started = true;
      onStart();
    }
    yield event;
  }
}
