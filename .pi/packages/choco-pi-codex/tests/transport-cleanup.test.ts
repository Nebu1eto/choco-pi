import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CODEX_TRANSPORT_CLEANUP_SYMBOL,
  registerCodexTransportCleanup,
} from "../src/extension/transport-cleanup.ts";
import { createCodexExtensionRuntime } from "../src/extension/runtime.ts";
import {
  canonicalCompactionRequestBody,
  recordCanonicalSessionResponse,
} from "../src/providers/openai-codex/session-continuity.ts";
import {
  cleanupOpenAICodexTransportSession,
  resetOpenAICodexTransportSession,
} from "../src/providers/openai-codex/transport-cleanup.ts";
import type { ResponsesBody } from "../src/providers/openai-codex/types.ts";
import {
  acquireWebSocket,
  closeOpenAICodexWebSocketSessions,
  isWebSocketSseFallbackActive,
  recordWebSocketSseFallback,
} from "../src/providers/openai-codex/websocket-session-cache.ts";

const TEST_URL = "wss://example.test/v1/responses";
const TEST_ACCOUNT = "account";
const TEST_ENV = { NO_PROXY: "*" };

interface FakeWebSocketEvent {
  code?: number;
  reason?: string;
}

interface CleanupRegistryFixture {
  [CODEX_TRANSPORT_CLEANUP_SYMBOL]?: unknown;
}

interface FakeWebSocketOptions {
  headers?: Record<string, string>;
}

class FakeWebSocket {
  readyState = 0;
  readonly listeners = new Map<string, Set<(event: FakeWebSocketEvent) => void>>();

  constructor(_url: string, _options?: FakeWebSocketOptions) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  addEventListener(name: string, listener: (event: FakeWebSocketEvent) => void): void {
    let listeners = this.listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(name, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(name: string, listener: (event: FakeWebSocketEvent) => void): void {
    this.listeners.get(name)?.delete(listener);
  }

  send(): void {}

  close(): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.emit("close", { code: 1000, reason: "closed" });
  }

  private emit(name: string, event: FakeWebSocketEvent): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener(event);
    }
  }
}

function responseBody(model = "gpt-test"): ResponsesBody {
  return {
    model,
    store: false,
    stream: true,
    input: [],
    text: { verbosity: "medium" },
    include: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
}

function recordCanonical(sessionId: string): void {
  recordCanonicalSessionResponse({
    sessionId,
    url: TEST_URL,
    accountId: TEST_ACCOUNT,
    requestBody: responseBody(),
    responseItems: [],
  });
}

function hasCanonical(sessionId: string): boolean {
  return (
    canonicalCompactionRequestBody(sessionId, "gpt-test", {
      url: TEST_URL,
      accountId: TEST_ACCOUNT,
    }) !== undefined
  );
}

async function cacheLane(sessionId: string): Promise<void> {
  const acquired = await acquireWebSocket(
    TEST_URL,
    new Headers(),
    sessionId,
    TEST_ACCOUNT,
    undefined,
    100,
    TEST_ENV,
  );
  assert.equal(acquired.reused, false);
  acquired.release({ keep: true });
}

async function laneWasReused(sessionId: string): Promise<boolean> {
  const acquired = await acquireWebSocket(
    TEST_URL,
    new Headers(),
    sessionId,
    TEST_ACCOUNT,
    undefined,
    100,
    TEST_ENV,
  );
  const reused = acquired.reused;
  acquired.release({ keep: true });
  return reused;
}

function installFakeWebSocket(): () => void {
  const previous = Reflect.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Reflect.set(globalThis, "WebSocket", FakeWebSocket);
  return () => {
    if (previous) {
      Reflect.defineProperty(globalThis, "WebSocket", previous);
    } else {
      Reflect.deleteProperty(globalThis, "WebSocket");
    }
  };
}

function restoreSymbol(symbol: symbol): () => void {
  const previous = Reflect.getOwnPropertyDescriptor(globalThis, symbol);
  return () => {
    if (previous) {
      Reflect.defineProperty(globalThis, symbol, previous);
    } else {
      Reflect.deleteProperty(globalThis, symbol);
    }
  };
}

test("scoped cleanup reclaims bare and keepalive transport state without touching siblings", async () => {
  const restoreWebSocket = installFakeWebSocket();
  const restoreCleanup = restoreSymbol(CODEX_TRANSPORT_CLEANUP_SYMBOL);
  closeOpenAICodexWebSocketSessions();

  try {
    const owner = "owner-session";
    const keepalive = `${owner}:cache-keepalive`;
    const sibling = "sibling-session";
    for (const sessionId of [owner, keepalive, sibling]) {
      await cacheLane(sessionId);
      recordCanonical(sessionId);
      recordWebSocketSseFallback(sessionId);
    }

    cleanupOpenAICodexTransportSession(owner);

    assert.equal(await laneWasReused(owner), false);
    assert.equal(await laneWasReused(keepalive), false);
    assert.equal(await laneWasReused(sibling), true);
    assert.equal(hasCanonical(owner), false);
    assert.equal(hasCanonical(keepalive), false);
    assert.equal(hasCanonical(sibling), true);
    assert.equal(isWebSocketSseFallbackActive(owner), false);
    assert.equal(isWebSocketSseFallbackActive(keepalive), false);
    assert.equal(isWebSocketSseFallbackActive(sibling), true);

    const firstCandidate = registerCodexTransportCleanup();
    const secondCandidate = registerCodexTransportCleanup();
    assert.equal(firstCandidate, secondCandidate);
    // SAFETY: The fixture describes only this symbol-keyed optional test slot.
    const registry = globalThis as typeof globalThis & CleanupRegistryFixture;
    assert.equal(registry[CODEX_TRANSPORT_CLEANUP_SYMBOL], firstCandidate);

    const candidateOwner = "candidate-child";
    await cacheLane(candidateOwner);
    await cacheLane(`${candidateOwner}:cache-keepalive`);
    firstCandidate.cleanupOwner(candidateOwner);
    assert.equal(await laneWasReused(candidateOwner), false);
    assert.equal(await laneWasReused(`${candidateOwner}:cache-keepalive`), false);

    // SAFETY: Transport reset does not inspect the ExtensionAPI fixture.
    const runtime = createCodexExtensionRuntime({} as ExtensionAPI);
    const actions = [
      (sessionId: string) => runtime.resetTransport(sessionId),
      (sessionId: string) => runtime.shutdownTransport(sessionId),
    ];
    for (const [index, action] of actions.entries()) {
      const sessionId = `runtime-${index}`;
      await cacheLane(sessionId);
      await cacheLane(`${sessionId}:cache-keepalive`);
      recordWebSocketSseFallback(sessionId);
      recordWebSocketSseFallback(`${sessionId}:cache-keepalive`);
      action(sessionId);
      assert.equal(await laneWasReused(sessionId), false);
      assert.equal(await laneWasReused(`${sessionId}:cache-keepalive`), false);
      assert.equal(isWebSocketSseFallbackActive(sessionId), index === 0);
      assert.equal(isWebSocketSseFallbackActive(`${sessionId}:cache-keepalive`), index === 0);
    }
  } finally {
    closeOpenAICodexWebSocketSessions();
    restoreCleanup();
    restoreWebSocket();
  }
});

test("scoped reset clears reusable lanes while retaining SSE fallback", async () => {
  const restoreWebSocket = installFakeWebSocket();
  closeOpenAICodexWebSocketSessions();

  try {
    const owner = "reset-owner";
    const keepalive = `${owner}:cache-keepalive`;
    const sibling = "reset-sibling";
    for (const sessionId of [owner, keepalive, sibling]) {
      await cacheLane(sessionId);
      recordCanonical(sessionId);
      recordWebSocketSseFallback(sessionId);
    }

    resetOpenAICodexTransportSession(owner);

    assert.equal(await laneWasReused(owner), false);
    assert.equal(await laneWasReused(keepalive), false);
    assert.equal(await laneWasReused(sibling), true);
    assert.equal(hasCanonical(owner), false);
    assert.equal(hasCanonical(keepalive), false);
    assert.equal(hasCanonical(sibling), true);
    assert.equal(isWebSocketSseFallbackActive(owner), true);
    assert.equal(isWebSocketSseFallbackActive(keepalive), true);
    assert.equal(isWebSocketSseFallbackActive(sibling), true);
  } finally {
    closeOpenAICodexWebSocketSessions();
    restoreWebSocket();
  }
});

test("empty owner ids never trigger global transport cleanup or reset", async () => {
  const restoreWebSocket = installFakeWebSocket();
  closeOpenAICodexWebSocketSessions();

  try {
    const sibling = "empty-id-sibling";
    const keepalive = `${sibling}:cache-keepalive`;
    for (const sessionId of [sibling, keepalive]) {
      await cacheLane(sessionId);
      recordCanonical(sessionId);
      recordWebSocketSseFallback(sessionId);
    }

    resetOpenAICodexTransportSession("");
    cleanupOpenAICodexTransportSession("");

    assert.equal(await laneWasReused(sibling), true);
    assert.equal(await laneWasReused(keepalive), true);
    assert.equal(hasCanonical(sibling), true);
    assert.equal(hasCanonical(keepalive), true);
    assert.equal(isWebSocketSseFallbackActive(sibling), true);
    assert.equal(isWebSocketSseFallbackActive(keepalive), true);
  } finally {
    closeOpenAICodexWebSocketSessions();
    restoreWebSocket();
  }
});
