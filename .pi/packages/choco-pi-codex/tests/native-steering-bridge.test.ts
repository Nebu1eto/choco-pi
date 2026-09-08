import assert from "node:assert/strict";
import test from "node:test";
import {
  registerNativeSteeringBridge,
  type NativeSteeringCandidate,
} from "../src/extension/native-steering-bridge.ts";
import {
  closeNativeSteering,
  openNativeSteering,
  steerNativeResponse,
} from "../src/providers/openai-codex/native-steering.ts";
import type {
  CodexStreamEvent,
  ResponsesBody,
  WebSocketEvent,
  WebSocketLike,
} from "../src/providers/openai-codex/types.ts";

const NATIVE_STEERING_SYMBOL: unique symbol = Symbol.for("choco-pi-codex:native-steering");

interface NativeSteeringRegistryFixture {
  [NATIVE_STEERING_SYMBOL]?: NativeSteeringCandidate | null;
}

class Socket implements WebSocketLike {
  private readonly listeners = new Map<string, Set<(event: WebSocketEvent) => void>>();

  send(): void {}

  close(): void {
    for (const listener of this.listeners.get("close") ?? []) listener({ code: 1000 });
  }

  addEventListener(type: string, listener: (event: WebSocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: WebSocketEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(event: CodexStreamEvent): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(event) });
    }
  }
}

function responseBody(): ResponsesBody {
  return {
    model: "gpt-6-astra",
    store: false,
    stream: true,
    input: [],
    text: { verbosity: "low" },
    include: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
}

function restoreSymbol(symbol: symbol): () => void {
  const previous = Reflect.getOwnPropertyDescriptor(globalThis, symbol);
  return () => {
    if (previous) Reflect.defineProperty(globalThis, symbol, previous);
    else Reflect.deleteProperty(globalThis, symbol);
  };
}

test("native steering bridge reports only pending owner steers", async () => {
  const restoreBridge = restoreSymbol(NATIVE_STEERING_SYMBOL);
  closeNativeSteering();

  try {
    const candidate = registerNativeSteeringBridge();
    const secondCandidate = registerNativeSteeringBridge();
    assert.equal(candidate, secondCandidate);
    assert.equal(Object.isFrozen(candidate), true);
    assert.equal(candidate.isNativeSteerPending instanceof Function, true);
    // SAFETY: The fixture describes only this symbol-keyed optional test slot.
    const registry = globalThis as typeof globalThis & NativeSteeringRegistryFixture;
    assert.equal(registry[NATIVE_STEERING_SYMBOL], candidate);
    assert.equal(candidate.isNativeSteerPending("unknown-owner"), false);

    const owner = "pending-owner";
    const socket = new Socket();
    const connection = openNativeSteering(socket, owner);
    connection.begin(responseBody());
    const events = connection.responseEvents(undefined, 1000)[Symbol.asyncIterator]();
    socket.emit({ type: "response.created", response: { id: "response-1" } });
    await events.next();

    assert.equal(steerNativeResponse(owner, "follow up"), true);
    assert.equal(candidate.isNativeSteerPending(owner), true);
    connection.close();
    assert.equal(candidate.isNativeSteerPending(owner), false);
  } finally {
    closeNativeSteering();
    restoreBridge();
  }
});
