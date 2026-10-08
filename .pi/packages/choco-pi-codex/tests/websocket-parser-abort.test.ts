import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { parseWebSocket } from "../src/providers/openai-codex/websocket-parser.ts";
import { createCodexTurnState } from "../src/providers/openai-codex/turn-state.ts";
import type { WebSocketEvent, WebSocketLike } from "../src/providers/openai-codex/types.ts";

class FakeSocket implements WebSocketLike {
  readonly listeners = new Map<string, Set<(event: WebSocketEvent) => void>>();

  send(): void {}
  close(): void {}

  addEventListener(type: string, listener: (event: WebSocketEvent) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: WebSocketEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(data: WebSocketEvent["data"]): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data });
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

function deferred<T>() {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      assert.ok(settle);
      settle(value);
    },
  };
}

function delayedMetadata() {
  const started = deferred<void>();
  const decoded = deferred<ArrayBuffer>();
  return {
    started: started.promise,
    data: {
      arrayBuffer() {
        started.resolve(undefined);
        return decoded.promise;
      },
    },
    release() {
      decoded.resolve(
        new TextEncoder().encode(
          JSON.stringify({ type: "response.metadata", headers: { "x-codex-turn-state": "old" } }),
        ).buffer,
      );
    },
  };
}

for (const stop of ["abort", "idle timeout", "return", "pending return"] as const) {
  test(`a delayed decode cannot capture after ${stop} and a new turn`, async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const state = createCodexTurnState();
    const delayed = delayedMetadata();
    // Deliberately use the shared capture directly to independently test parser ownership.
    const iterator = parseWebSocket(socket, controller.signal, 25, state.capture)[
      Symbol.asyncIterator
    ]();
    const first = iterator.next();
    const isReturn = stop === "return" || stop === "pending return";
    const rejected = isReturn ? undefined : assert.rejects(first, /aborted|idle timeout/);
    if (stop === "return") {
      socket.emit(JSON.stringify({ type: "response.created" }));
      assert.equal((await first).done, false);
    }
    socket.emit(delayed.data);
    await delayed.started;
    if (stop === "abort") controller.abort();
    if (isReturn) await iterator.return?.();
    else await rejected;
    if (stop === "pending return") assert.equal((await first).done, true);
    assert.equal(socket.listenerCount(), 0);
    state.beginTurn();
    const nextSocket = new FakeSocket();
    const nextTurn = parseWebSocket(nextSocket, undefined, 0, state.captureForTurn())[
      Symbol.asyncIterator
    ]();
    const metadata = nextTurn.next();
    delayed.release();
    await setImmediate();
    assert.equal(state.current(), undefined);
    nextSocket.emit(
      JSON.stringify({ type: "response.metadata", headers: { "x-codex-turn-state": "new" } }),
    );
    assert.equal((await metadata).value?.type, "response.metadata");
    assert.equal(state.current(), "new");
    const completed = nextTurn.next();
    nextSocket.emit(JSON.stringify({ type: "response.completed" }));
    assert.equal((await completed).value?.type, "response.completed");
    assert.equal((await nextTurn.next()).done, true);
    assert.equal(nextSocket.listenerCount(), 0);
    assert.equal(socket.listenerCount(), 0);
  });
}

test("turn-bound capture cannot pre-empt metadata after beginTurn or reset", () => {
  const state = createCodexTurnState();
  const oldCapture = state.captureForTurn();
  state.beginTurn();
  oldCapture("old");
  assert.equal(state.current(), undefined);
  const currentCapture = state.captureForTurn();
  currentCapture("new");
  oldCapture("old");
  assert.equal(state.current(), "new");
  state.reset();
  currentCapture("old");
  assert.equal(state.current(), undefined);
});

test("terminal completion invalidates queued message decoding", async () => {
  const socket = new FakeSocket();
  const state = createCodexTurnState();
  const iterator = parseWebSocket(socket, undefined, 25, state.capture)[Symbol.asyncIterator]();
  const first = iterator.next();
  socket.emit(JSON.stringify({ type: "response.completed" }));
  socket.emit(
    JSON.stringify({ type: "response.metadata", headers: { "x-codex-turn-state": "late" } }),
  );
  assert.equal((await first).value?.type, "response.completed");
  assert.equal((await iterator.next()).done, true);
  await setImmediate();
  assert.equal(state.current(), undefined);
  assert.equal(socket.listenerCount(), 0);
});
