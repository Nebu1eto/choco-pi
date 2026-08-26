import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../src/agent-manager.ts";
import type { AgentRecord } from "../src/types.ts";

function partialFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: Each test supplies the exact session slice exercised by resumeAgent.
  return fixture as T;
}

function sessionFixture(): AgentSession {
  const messages: AgentSession["messages"] = [];
  return partialFixture<AgentSession>({
    messages,
    async prompt(prompt: string) {
      messages.push(
        partialFixture<AssistantMessage>({
          role: "assistant",
          content: [{ type: "text", text: `reply:${prompt}` }],
          stopReason: "stop",
        }),
      );
    },
    subscribe: () => () => {},
    abort: async () => {},
    dispose: () => {},
    sessionManager: partialFixture<AgentSession["sessionManager"]>({
      getSessionId: () => "resume-alias-session",
    }),
  });
}

function managerWithResumeRecords(): AgentManager {
  const manager = new AgentManager(undefined, 8);
  Object.defineProperty(manager, "startAgent", {
    value: (_id: string, record: AgentRecord) => {
      record.status = "completed";
      record.completedAt = Date.now();
      record.session = sessionFixture();
      record.sessionFile = `/tmp/${record.id}.jsonl`;
    },
  });
  return manager;
}

function spawnCompleted(manager: AgentManager, name: string): string {
  // SAFETY: managerWithResumeRecords replaces startAgent before this placeholder host is observed.
  return manager.spawn({} as never, {} as never, "implementer", name, {
    description: name,
    name,
    isBackground: false,
  });
}

function resolvedLiveId(manager: AgentManager, name: string): string | undefined {
  const resolved = manager.resolveMention(name);
  return resolved?.kind === "live" ? resolved.record.id : undefined;
}

test("successful foreground resume rebinds the alias without changing record identity", async () => {
  const manager = managerWithResumeRecords();
  try {
    const id = spawnCompleted(manager, "implementer-medpath-mise");
    const original = manager.getRecord(id);
    assert.ok(original);
    const stableHandle = original.handle;
    assert.equal(resolvedLiveId(manager, "implementer-medpath-mise"), id);

    const resumed = await manager.resume(id, "continue", undefined, {
      name: "implementer-medpath-mise-fix",
    });

    assert.strictEqual(
      resumed,
      original,
      "Fleet and other record consumers observe the same object",
    );
    assert.equal(resumed.alias, "implementer-medpath-mise-fix");
    assert.equal(resumed.handle, stableHandle);
    assert.equal(manager.getRecord(id), resumed, "UUID lookup remains stable");
    assert.equal(resolvedLiveId(manager, "implementer-medpath-mise-fix"), id);
    assert.equal(manager.resolveMention("implementer-medpath-mise"), undefined);

    await manager.resume(id, "same alias", undefined, { name: "implementer-medpath-mise-fix" });
    assert.equal(original.alias, "implementer-medpath-mise-fix", "same name gains no suffix");

    await manager.resume(id, "no alias parameter");
    assert.equal(original.alias, "implementer-medpath-mise-fix", "omitted name retains the alias");
  } finally {
    manager.dispose();
  }
});

test("reclaimed record rename moves its own tombstone alias without duplicate resolution", async () => {
  const manager = managerWithResumeRecords();
  try {
    const originalId = spawnCompleted(manager, "reclaimed-a");
    const original = manager.getRecord(originalId);
    assert.ok(original?.handle && original.alias && original.sessionFile);
    original.completedAt = 0;
    // SAFETY: This invokes the manager's real age-based eviction seam to retain the resumable tombstone.
    Object.getPrototypeOf(manager).cleanup.call(manager);

    const evicted = manager.resolveMention("reclaimed-a");
    assert.equal(evicted?.kind, "tombstone");
    if (evicted?.kind !== "tombstone") assert.fail("expected reclaimed-a tombstone");

    // SAFETY: managerWithResumeRecords replaces startAgent before these placeholder hosts are observed.
    const reclaimedId = manager.spawn({} as never, {} as never, "implementer", "reopen", {
      description: evicted.entry.description,
      reclaim: { handle: evicted.entry.handle, alias: evicted.entry.alias },
      resumeSessionFile: evicted.entry.sessionFile,
      isBackground: false,
    });
    const reclaimed = manager.getRecord(reclaimedId);
    assert.ok(reclaimed);
    assert.equal(
      manager.resolveMention(originalId),
      undefined,
      "evicted id cannot reopen a duplicate",
    );

    await manager.resume(reclaimedId, "rename to b", undefined, { name: "reclaimed-b" });
    assert.equal(reclaimed.alias, "reclaimed-b");
    assert.equal(manager.resolveMention("reclaimed-a"), undefined, "old alias is fully released");
    assert.equal(resolvedLiveId(manager, "reclaimed-b"), reclaimedId);
    assert.equal(manager.listTombstones()[0]?.alias, "reclaimed-b");
    assert.equal(manager.listTombstones()[0]?.id, reclaimedId);

    await manager.resume(reclaimedId, "rename back to a", undefined, { name: "reclaimed-a" });
    assert.equal(reclaimed.alias, "reclaimed-a", "A → B → A remains unsuffixed");
    assert.equal(manager.listTombstones()[0]?.alias, "reclaimed-a");
    assert.equal(manager.resolveMention("reclaimed-b"), undefined);
  } finally {
    manager.dispose();
  }
});

test("resume alias collisions include live records and tombstones deterministically", async () => {
  const manager = managerWithResumeRecords();
  try {
    const resumedId = spawnCompleted(manager, "original-name");
    const liveCollisionId = spawnCompleted(manager, "rename-target");
    const tombstoneCollisionId = spawnCompleted(manager, "rename-target");
    const resumed = manager.getRecord(resumedId);
    const liveCollision = manager.getRecord(liveCollisionId);
    const tombstoneCollision = manager.getRecord(tombstoneCollisionId);
    assert.ok(resumed && liveCollision && tombstoneCollision);
    assert.equal(liveCollision.alias, "rename-target");
    assert.equal(tombstoneCollision.alias, "rename-target-2");

    resumed.status = "running";
    liveCollision.status = "running";
    tombstoneCollision.completedAt = 0;
    // SAFETY: This invokes the manager's real age-based eviction seam to create a retained tombstone.
    Object.getPrototypeOf(manager).cleanup.call(manager);
    resumed.status = "completed";
    liveCollision.status = "completed";

    await manager.resume(resumedId, "continue", undefined, { name: "rename-target" });
    assert.equal(resumed.alias, "rename-target-3");
  } finally {
    manager.dispose();
  }
});

test("accepted background resume rebinds, while refused resumes preserve the alias", async () => {
  const manager = managerWithResumeRecords();
  try {
    const id = spawnCompleted(manager, "background-old");
    const record = manager.getRecord(id);
    assert.ok(record);

    const accepted = await manager.resume(id, "background", undefined, {
      isBackground: true,
      name: "background-new",
    });
    assert.strictEqual(accepted, record);
    assert.equal(record.alias, "background-new");
    await record.promise;

    record.status = "running";
    const refusedLive = await manager.resume(id, "overlap", undefined, {
      isBackground: true,
      name: "must-not-rename",
    });
    assert.equal(refusedLive, undefined);
    assert.equal(record.alias, "background-new");

    record.status = "completed";
    record.session = undefined;
    const refusedSessionless = await manager.resume(id, "missing session", undefined, {
      name: "must-not-rename-either",
    });
    assert.equal(refusedSessionless, undefined);
    assert.equal(record.alias, "background-new");
  } finally {
    manager.dispose();
  }
});
