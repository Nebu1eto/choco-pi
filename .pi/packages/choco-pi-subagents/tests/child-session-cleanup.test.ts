import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../src/agent-manager.ts";
import {
  cleanupChildSessionOwner,
  CODEX_TRANSPORT_CLEANUP_SYMBOL,
  SHELL_MANAGER_SYMBOL,
} from "../src/child-session-cleanup.ts";
import type { AgentRecord } from "../src/types.ts";

function sessionFixture(sessionId: string, dispose: () => void = () => {}): AgentSession {
  // SAFETY: AgentManager disposal uses only sessionManager.getSessionId and dispose from this fixture.
  return {
    sessionManager: { getSessionId: () => sessionId },
    dispose,
  } as AgentSession;
}

type CleanupFixture =
  | { cleanupOwner?: string | ((ownerId: string) => Promise<void>) }
  | null
  | undefined;

function setCleanupCandidate(symbol: symbol, value: CleanupFixture): () => void {
  const prior = Reflect.getOwnPropertyDescriptor(globalThis, symbol);
  Reflect.set(globalThis, symbol, value);
  return () => {
    if (prior) Reflect.defineProperty(globalThis, symbol, prior);
    else Reflect.deleteProperty(globalThis, symbol);
  };
}

const setShellManager = (value: CleanupFixture) => setCleanupCandidate(SHELL_MANAGER_SYMBOL, value);
const setCodexCleanup = (value: CleanupFixture) =>
  setCleanupCandidate(CODEX_TRANSPORT_CLEANUP_SYMBOL, value);

function addCompletedRecord(manager: AgentManager, session: AgentSession): void {
  Object.defineProperty(manager, "startAgent", {
    value: (_id: string, record: AgentRecord) => {
      record.status = "completed";
      record.completedAt = Date.now();
      record.session = session;
    },
  });
  // SAFETY: The patched startAgent does not observe the placeholder host objects.
  manager.spawn({} as never, {} as never, "general-purpose", "done", {
    description: "done",
    isBackground: false,
  });
}

test("cleanup bridge ignores missing and malformed registries", () => {
  const restoreShell = setShellManager(undefined);
  const restoreCodex = setCodexCleanup(undefined);
  let sessionIdReads = 0;
  const session = {
    sessionManager: {
      getSessionId: () => {
        sessionIdReads++;
        return "child-missing";
      },
    },
  };
  try {
    assert.doesNotThrow(() => cleanupChildSessionOwner(session));
    for (const malformed of [null, {}, { cleanupOwner: "not callable" }]) {
      Reflect.set(globalThis, SHELL_MANAGER_SYMBOL, malformed);
      Reflect.set(globalThis, CODEX_TRANSPORT_CLEANUP_SYMBOL, malformed);
      assert.doesNotThrow(() => cleanupChildSessionOwner(session));
    }
    assert.equal(sessionIdReads, 0);
  } finally {
    restoreCodex();
    restoreShell();
  }
});

test("cleanup bridge contains one rejection and still calls the other candidate", async () => {
  const calls: string[] = [];
  const restoreShell = setShellManager({
    cleanupOwner: () => Promise.reject(new Error("cleanup failed")),
  });
  const restoreCodex = setCodexCleanup({
    cleanupOwner: (ownerId: string) => {
      calls.push(ownerId);
      return Promise.resolve();
    },
  });
  try {
    cleanupChildSessionOwner(sessionFixture("child-rejection"));
    assert.deepEqual(calls, ["child-rejection"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    restoreCodex();
    restoreShell();
  }
});

test("removeRecord eviction starts both child cleanups before disposing without waiting", () => {
  const events: string[] = [];
  const restoreShell = setShellManager({
    cleanupOwner: (ownerId: string) => {
      events.push(`shell:${ownerId}`);
      return new Promise<void>(() => {});
    },
  });
  const restoreCodex = setCodexCleanup({
    cleanupOwner: (ownerId: string) => {
      events.push(`codex:${ownerId}`);
      return Promise.resolve();
    },
  });
  const manager = new AgentManager();
  try {
    addCompletedRecord(
      manager,
      sessionFixture("child-evicted", () => events.push("dispose")),
    );
    manager.clearCompleted();
    assert.deepEqual(events, ["shell:child-evicted", "codex:child-evicted", "dispose"]);
  } finally {
    manager.dispose();
    restoreCodex();
    restoreShell();
  }
});

test("whole-manager disposal still invokes Codex cleanup when the shell registry is malformed", () => {
  const events: string[] = [];
  const restoreShell = setShellManager({ cleanupOwner: "malformed" });
  const restoreCodex = setCodexCleanup({
    cleanupOwner: (ownerId: string) => {
      events.push(`codex:${ownerId}`);
      return Promise.resolve();
    },
  });
  const manager = new AgentManager();
  try {
    addCompletedRecord(
      manager,
      sessionFixture("child-manager", () => events.push("dispose")),
    );
    manager.dispose();
    assert.deepEqual(events, ["codex:child-manager", "dispose"]);
  } finally {
    restoreCodex();
    restoreShell();
  }
});
