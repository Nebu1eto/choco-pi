import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../src/agent-manager.ts";
import { cleanupChildSessionOwner, SHELL_MANAGER_SYMBOL } from "../src/child-session-cleanup.ts";
import type { AgentRecord } from "../src/types.ts";

function sessionFixture(sessionId: string, dispose: () => void = () => {}): AgentSession {
  // SAFETY: AgentManager disposal uses only sessionManager.getSessionId and dispose from this fixture.
  return {
    sessionManager: { getSessionId: () => sessionId },
    dispose,
  } as AgentSession;
}

type ShellManagerFixture =
  | { cleanupOwner?: string | ((ownerId: string) => Promise<void>) }
  | null
  | undefined;

function setShellManager(value: ShellManagerFixture): () => void {
  const prior = Reflect.getOwnPropertyDescriptor(globalThis, SHELL_MANAGER_SYMBOL);
  Reflect.set(globalThis, SHELL_MANAGER_SYMBOL, value);
  return () => {
    if (prior) Reflect.defineProperty(globalThis, SHELL_MANAGER_SYMBOL, prior);
    else Reflect.deleteProperty(globalThis, SHELL_MANAGER_SYMBOL);
  };
}

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
  const restore = setShellManager(undefined);
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
      assert.doesNotThrow(() => cleanupChildSessionOwner(session));
    }
    assert.equal(sessionIdReads, 0);
  } finally {
    restore();
  }
});

test("cleanup bridge contains rejected cleanup promises", async () => {
  const restore = setShellManager({
    cleanupOwner: () => Promise.reject(new Error("cleanup failed")),
  });
  try {
    cleanupChildSessionOwner(sessionFixture("child-rejection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    restore();
  }
});

test("removeRecord eviction cleans the child owner before disposing", () => {
  const events: string[] = [];
  const restore = setShellManager({
    cleanupOwner: (ownerId: string) => {
      events.push(`cleanup:${ownerId}`);
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
    assert.deepEqual(events, ["cleanup:child-evicted", "dispose"]);
  } finally {
    manager.dispose();
    restore();
  }
});

test("whole-manager disposal cleans the child owner before disposing", () => {
  const events: string[] = [];
  const restore = setShellManager({
    cleanupOwner: (ownerId: string) => {
      events.push(`cleanup:${ownerId}`);
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
    assert.deepEqual(events, ["cleanup:child-manager", "dispose"]);
  } finally {
    restore();
  }
});
