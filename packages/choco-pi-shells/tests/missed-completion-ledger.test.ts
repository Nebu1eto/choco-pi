import assert from "node:assert/strict";
import test from "node:test";

import { ShellNotificationGate } from "../src/notification-gate.ts";
import { ShellManager, type ShellResult } from "../src/shell-manager.ts";

function createGate(manager: ShellManager, delivered: ShellResult[]) {
  const gate = new ShellNotificationGate({
    manager,
    flush: (shells) => {
      delivered.push(...shells);
    },
    appendEntry: () => {},
  });
  const unsubscribe = manager.onChange((event) => {
    if (event.type === "end") gate.enqueue(event.shell);
  });
  return {
    gate,
    close: () => {
      gate.shutdown();
      unsubscribe();
    },
  };
}

async function complete(manager: ShellManager, ownerId: string): Promise<ShellResult> {
  const terminal = new Promise<ShellResult>((resolve) => {
    const unsubscribe = manager.onChange((event) => {
      if (event.type !== "end" || event.shell.ownerId !== ownerId) return;
      unsubscribe();
      resolve(event.shell);
    });
  });
  manager.start({ ownerId, cwd: process.cwd(), command: "process.stdout.write('done')" });
  return terminal;
}

function createManager(): ShellManager {
  return new ShellManager({ shell: process.execPath, shellArgs: ["-e"] });
}

test("completion while switched away is reconciled for its owner exactly once", async () => {
  const manager = createManager();
  const delivered: ShellResult[] = [];
  const activation = createGate(manager, delivered);
  try {
    activation.gate.sessionStart("owner", []);
    activation.gate.sessionStart("other", []);
    const result = await complete(manager, "owner");
    activation.gate.turnEnd();
    assert.deepEqual(delivered, []);
    activation.gate.sessionStart("owner", []);
    activation.gate.turnEnd();
    activation.gate.sessionStart("other", []);
    activation.gate.sessionStart("owner", []);
    activation.gate.turnEnd();
    assert.deepEqual(delivered, [result]);
    assert.deepEqual(manager.pendingCompletions("owner"), []);
  } finally {
    activation.close();
    await manager.dispose();
  }
});

test("completion in the reload listener gap is delivered by the successor", async () => {
  const manager = createManager();
  const delivered: ShellResult[] = [];
  const old = createGate(manager, delivered);
  old.gate.sessionStart("owner", []);
  old.close();
  const result = await complete(manager, "owner");
  const successor = createGate(manager, delivered);
  try {
    successor.gate.sessionStart("owner", []);
    successor.gate.turnEnd();
    successor.gate.activateOwner("owner");
    successor.gate.turnEnd();
    assert.deepEqual(delivered, [result]);
  } finally {
    successor.close();
    await manager.dispose();
  }
});

test("active-owner completion is delivered normally and never redelivered after reload", async () => {
  const manager = createManager();
  const delivered: ShellResult[] = [];
  const old = createGate(manager, delivered);
  old.gate.sessionStart("owner", []);
  const result = await complete(manager, "owner");
  old.gate.turnEnd();
  assert.deepEqual(delivered, [result]);
  old.close();
  const successor = createGate(manager, delivered);
  try {
    // Even a stale persisted pending entry must not replay an acknowledged result.
    successor.gate.sessionStart("owner", [
      {
        type: "custom",
        customType: "shell-completion-pending",
        data: { keys: [`${result.shellId}:${result.endedAt}`], shells: [result] },
      },
    ]);
    successor.gate.enqueue(result);
    successor.gate.turnEnd();
    assert.deepEqual(delivered, [result]);
  } finally {
    successor.close();
    await manager.dispose();
  }
});

test("switching with a held completion cannot deliver it into another owner's session", async () => {
  const manager = createManager();
  const delivered: ShellResult[] = [];
  const activation = createGate(manager, delivered);
  try {
    activation.gate.sessionStart("owner", []);
    const result = await complete(manager, "owner");
    activation.gate.activateOwner("other");
    activation.gate.turnEnd();
    assert.deepEqual(delivered, []);
    activation.gate.activateOwner("owner");
    activation.gate.turnEnd();
    assert.deepEqual(delivered, [result]);
  } finally {
    activation.close();
    await manager.dispose();
  }
});

test("overlapping listeners cannot deliver an acknowledged completion twice", async () => {
  const manager = createManager();
  const delivered: ShellResult[] = [];
  const first = createGate(manager, delivered);
  const second = createGate(manager, delivered);
  try {
    first.gate.sessionStart("owner", []);
    second.gate.sessionStart("owner", []);
    const result = await complete(manager, "owner");
    first.gate.turnEnd();
    second.gate.turnEnd();
    assert.deepEqual(delivered, [result]);
  } finally {
    first.close();
    second.close();
    await manager.dispose();
  }
});

test("stale delivery leaves the ledger available to the replacement listener", async () => {
  const manager = createManager();
  const delivered: ShellResult[] = [];
  const stale = new ShellNotificationGate({
    manager,
    flush: () => {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    },
    appendEntry: () => {},
  });
  stale.sessionStart("owner", []);
  const result = await complete(manager, "owner");
  stale.activateOwner("owner");
  stale.turnEnd();
  assert.deepEqual(manager.pendingCompletions("owner"), [result]);
  const successor = createGate(manager, delivered);
  try {
    successor.gate.sessionStart("owner", []);
    successor.gate.turnEnd();
    assert.deepEqual(delivered, [result]);
  } finally {
    stale.shutdown();
    successor.close();
    await manager.dispose();
  }
});

test("unacknowledged completions survive record eviction pressure", async () => {
  const manager = new ShellManager({
    shell: process.execPath,
    shellArgs: ["-e"],
    completedRecordCap: 0,
  });
  const delivered: ShellResult[] = [];
  try {
    const result = await complete(manager, "owner");
    assert.equal(
      manager.read({ requesterId: "owner", isAdmin: false, shellId: result.shellId }).stdout.data,
      "done",
    );
    const activation = createGate(manager, delivered);
    activation.gate.sessionStart("owner", []);
    activation.gate.turnEnd();
    activation.close();
    assert.deepEqual(delivered, [result]);
    assert.throws(
      () => manager.read({ requesterId: "owner", isAdmin: false, shellId: result.shellId }),
      /Shell not found/,
    );
  } finally {
    await manager.dispose();
  }
});
