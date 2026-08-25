import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ShellManager, type ShellChangeEvent, type ShellResult } from "../src/shell-manager.ts";

const cwd = process.cwd();

async function waitFor<T>(
  read: () => T,
  accept: (value: T) => boolean,
  timeoutMs = 4_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (!accept(value)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for condition: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = read();
  }
  return value;
}

function readShell(manager: ShellManager, shellId: string, ownerId = "owner") {
  return manager.read({ requesterId: ownerId, isAdmin: false, shellId });
}

function isTerminal(shell: ShellResult): boolean {
  return shell.state !== "running";
}

function escapedDescendantCommand(parentKeepsRunning: boolean): string {
  const descendant = "setInterval(() => {}, 1000)";
  return [
    'const { spawn } = require("node:child_process")',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { detached: true, stdio: ["ignore", 1, 2] })`,
    'process.stdout.write(String(child.pid) + "\\n")',
    "child.unref()",
    ...(parentKeepsRunning
      ? ['process.on("SIGTERM", () => {})', "setInterval(() => {}, 1000)"]
      : []),
  ].join(";");
}

function killFixture(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal("code" in error ? error.code : undefined, "ESRCH");
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    assert.ok(error instanceof Error);
    if (("code" in error ? error.code : undefined) === "ESRCH") return false;
    throw error;
  }
}

test("start returns before completion, keeps streams separate, and later reports exit state", async () => {
  const manager = new ShellManager({ shell: process.execPath, shellArgs: ["-e"] });
  try {
    const startTime = performance.now();
    const started = manager.start({
      ownerId: "owner",
      cwd,
      command:
        'setTimeout(() => { process.stdout.write("out\\n"); process.stderr.write("err\\n"); }, 500); setTimeout(() => process.exit(7), 700)',
    });
    const startElapsedMs = performance.now() - startTime;

    assert.equal(started.state, "running");
    assert.ok(startElapsedMs < 500, `start took ${startElapsedMs.toFixed(1)}ms`);

    const completed = await waitFor(
      () => readShell(manager, started.shellId),
      (result) => isTerminal(result.shell),
    );
    assert.equal(completed.shell.state, "exited");
    assert.equal(completed.shell.exitCode, 7);
    assert.equal(completed.stdout.data, "out\n");
    assert.equal(completed.stderr.data, "err\n");
    assert.ok(completed.shell.endedAt !== undefined);
  } finally {
    await manager.dispose();
  }
});

test("change events report ordered start, stop update, and final snapshots", async () => {
  const manager = new ShellManager({ shell: process.execPath, shellArgs: ["-e"] });
  const events: ShellChangeEvent[] = [];
  manager.onChange((event) => events.push(event));
  try {
    const started = manager.start({
      ownerId: "owner",
      cwd,
      command:
        'process.stdout.write("first"); setTimeout(() => process.stdout.write("second"), 25); setInterval(() => {}, 1000)',
    });
    const stopped = await manager.stop({
      requesterId: "owner",
      isAdmin: false,
      shellId: started.shellId,
    });

    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "update", "end"],
    );
    assert.equal(events[0]?.shell.state, "running");
    assert.equal(events[0]?.shell.endedAt, undefined);
    assert.equal(events[1]?.shell.state, "running");
    assert.equal(events[1]?.shell.endedAt, undefined);
    assert.equal(events[2]?.shell.state, "stopped");
    assert.equal(events[2]?.shell.endedAt, stopped.endedAt);
    assert.ok(events.every((event) => event.shell.shellId === started.shellId));
  } finally {
    await manager.dispose();
  }
});

test("change listener unsubscribe is idempotent", async () => {
  const manager = new ShellManager({ shell: process.execPath, shellArgs: ["-e"] });
  const eventTypes: ShellChangeEvent["type"][] = [];
  const unsubscribe = manager.onChange((event) => eventTypes.push(event.type));
  try {
    const started = manager.start({
      ownerId: "owner",
      cwd,
      command: "setInterval(() => {}, 1000)",
    });
    unsubscribe();
    unsubscribe();
    await manager.stop({ requesterId: "owner", isAdmin: false, shellId: started.shellId });

    assert.deepEqual(eventTypes, ["start"]);
  } finally {
    await manager.dispose();
  }
});

test("change listener exceptions do not interrupt other listeners or shell lifecycle", async () => {
  const manager = new ShellManager({ shell: process.execPath, shellArgs: ["-e"] });
  const eventTypes: ShellChangeEvent["type"][] = [];
  manager.onChange(() => {
    throw new Error("listener failure");
  });
  manager.onChange((event) => eventTypes.push(event.type));
  try {
    const started = manager.start({
      ownerId: "owner",
      cwd,
      command: "setInterval(() => {}, 1000)",
    });
    const stopped = await manager.stop({
      requesterId: "owner",
      isAdmin: false,
      shellId: started.shellId,
    });

    assert.equal(stopped.state, "stopped");
    assert.deepEqual(eventTypes, ["start", "update", "end"]);
  } finally {
    await manager.dispose();
  }
});

test("dispose delivers final change events before clearing listeners", async () => {
  const manager = new ShellManager({ shell: process.execPath, shellArgs: ["-e"] });
  const eventTypes: ShellChangeEvent["type"][] = [];
  manager.onChange((event) => eventTypes.push(event.type));
  manager.start({
    ownerId: "owner",
    cwd,
    command: "setInterval(() => {}, 1000)",
  });

  await manager.dispose();

  assert.deepEqual(eventTypes, ["start", "update", "end"]);
});

test(
  "an escaped descendant holding inherited pipes cannot block natural completion or disposal",
  { skip: process.platform === "win32" },
  async () => {
    const manager = new ShellManager({
      shell: process.execPath,
      shellArgs: ["-e"],
      outputDrainMs: 100,
      killFinalizeMs: 100,
      stopGraceMs: 100,
    });
    const escapedPids: number[] = [];
    try {
      const startedAt = performance.now();
      const started = manager.start({
        ownerId: "owner",
        cwd,
        command: escapedDescendantCommand(false),
      });
      const withPid = await waitFor(
        () => readShell(manager, started.shellId),
        (result) => /^\d+\n$/.test(result.stdout.data),
      );
      escapedPids.push(Number.parseInt(withPid.stdout.data, 10));

      const completed = await waitFor(
        () => readShell(manager, started.shellId),
        (result) => isTerminal(result.shell),
        2_000,
      );
      assert.equal(completed.shell.state, "exited");
      assert.equal(completed.shell.exitCode, 0);
      assert.ok(performance.now() - startedAt < 1_500);

      const stopStartedAt = performance.now();
      assert.equal(
        (await manager.stop({ requesterId: "owner", isAdmin: false, shellId: started.shellId }))
          .state,
        "exited",
      );
      assert.ok(performance.now() - stopStartedAt < 250);

      const disposingShell = manager.start({
        ownerId: "owner",
        cwd,
        command: escapedDescendantCommand(false),
      });
      const disposingWithPid = await waitFor(
        () => readShell(manager, disposingShell.shellId),
        (result) => /^\d+\n$/.test(result.stdout.data),
      );
      escapedPids.push(Number.parseInt(disposingWithPid.stdout.data, 10));
      const disposeStartedAt = performance.now();
      await manager.dispose();
      assert.ok(performance.now() - disposeStartedAt < 1_000);
      assert.notEqual(readShell(manager, disposingShell.shellId).shell.state, "running");
    } finally {
      await manager.dispose();
      for (const pid of escapedPids) killFixture(pid);
    }
  },
);

test(
  "natural drain finalization kills a same-group background job before reporting terminal state",
  { skip: process.platform === "win32" },
  async () => {
    const manager = new ShellManager({
      shell: "/bin/sh",
      shellArgs: ["-c"],
      outputDrainMs: 100,
    });
    let backgroundPid: number | undefined;
    try {
      const started = manager.start({
        ownerId: "owner",
        cwd,
        command: "sleep 30 & echo $!",
      });
      const withPid = await waitFor(
        () => readShell(manager, started.shellId),
        (result) => /^\d+\n$/.test(result.stdout.data),
      );
      const pid = Number.parseInt(withPid.stdout.data, 10);
      backgroundPid = pid;
      assert.equal(processExists(pid), true);

      const completed = await waitFor(
        () => readShell(manager, started.shellId),
        (result) => isTerminal(result.shell),
        2_000,
      );
      assert.equal(completed.shell.state, "exited");
      assert.equal(completed.shell.exitCode, 0);
      await waitFor(
        () => processExists(pid),
        (exists) => !exists,
        2_000,
      );
    } finally {
      await manager.dispose();
      killFixture(backgroundPid);
    }
  },
);

test(
  "redirected stdio finalization kills a same-group background job before disposal",
  { skip: process.platform === "win32" },
  async () => {
    const manager = new ShellManager({ shell: "/bin/sh", shellArgs: ["-c"] });
    let backgroundPid: number | undefined;
    try {
      const started = manager.start({
        ownerId: "owner",
        cwd,
        command: "sleep 30 >/dev/null 2>&1 & echo $!",
      });
      const withPid = await waitFor(
        () => readShell(manager, started.shellId),
        (result) => /^\d+\n$/.test(result.stdout.data),
      );
      const pid = Number.parseInt(withPid.stdout.data, 10);
      backgroundPid = pid;

      const completed = await waitFor(
        () => readShell(manager, started.shellId),
        (result) => isTerminal(result.shell),
        2_000,
      );
      assert.equal(completed.shell.state, "exited");
      assert.equal(completed.shell.exitCode, 0);
      await waitFor(
        () => processExists(pid),
        (exists) => !exists,
        2_000,
      );
      assert.equal(processExists(pid), false);

      await manager.dispose();
      assert.equal(processExists(pid), false);
    } finally {
      await manager.dispose();
      killFixture(backgroundPid);
    }
  },
);

test(
  "SIGKILL escalation force-finalizes once when an escaped descendant prevents close",
  { skip: process.platform === "win32" },
  async () => {
    const manager = new ShellManager({
      shell: process.execPath,
      shellArgs: ["-e"],
      stopGraceMs: 75,
      killFinalizeMs: 75,
      outputDrainMs: 5_000,
    });
    let escapedPid: number | undefined;
    try {
      const started = manager.start({
        ownerId: "owner",
        cwd,
        command: escapedDescendantCommand(true),
      });
      const withPid = await waitFor(
        () => readShell(manager, started.shellId),
        (result) => /^\d+\n$/.test(result.stdout.data),
      );
      escapedPid = Number.parseInt(withPid.stdout.data, 10);

      const stopStartedAt = performance.now();
      const stopped = await manager.stop({
        requesterId: "owner",
        isAdmin: false,
        shellId: started.shellId,
      });
      assert.equal(stopped.state, "stopped");
      assert.equal(stopped.signal, "SIGKILL");
      assert.ok(performance.now() - stopStartedAt < 1_000);

      await new Promise((resolve) => setTimeout(resolve, 200));
      const afterLateEvents = readShell(manager, started.shellId);
      assert.equal(afterLateEvents.shell.endedAt, stopped.endedAt);
      assert.equal(afterLateEvents.shell.state, "stopped");
      assert.equal(afterLateEvents.stdout.data, `${escapedPid}\n`);
    } finally {
      await manager.dispose();
      killFixture(escapedPid);
    }
  },
);

test("cursor reads are incremental and bounded buffers report dropped absolute UTF-8 offsets", async () => {
  const manager = new ShellManager({
    shell: process.execPath,
    shellArgs: ["-e"],
    bufferBytes: 12,
  });
  try {
    const started = manager.start({
      ownerId: "owner",
      cwd,
      command:
        'const bytes = Buffer.from("012345éXYZabcd"); process.stdout.write(bytes.subarray(0, 7)); setTimeout(() => { process.stdout.write(bytes.subarray(7)); process.stderr.write("ERR"); }, 25)',
    });
    await waitFor(
      () => readShell(manager, started.shellId),
      (result) => isTerminal(result.shell),
    );

    const first = manager.read({
      requesterId: "owner",
      isAdmin: false,
      shellId: started.shellId,
      stdoutOffset: 0,
      stderrOffset: 0,
      maxBytes: 4,
    });
    assert.deepEqual(first.stdout, {
      data: "345",
      startOffset: 3,
      nextOffset: 6,
      endOffset: 15,
      dropped: true,
    });
    assert.deepEqual(first.stderr, {
      data: "ERR",
      startOffset: 0,
      nextOffset: 3,
      endOffset: 3,
      dropped: false,
    });

    let offset = first.stdout.nextOffset;
    let remaining = "";
    while (offset < first.stdout.endOffset) {
      const next = manager.read({
        requesterId: "owner",
        isAdmin: false,
        shellId: started.shellId,
        stdoutOffset: offset,
        maxBytes: 4,
      }).stdout;
      assert.equal(next.startOffset, offset);
      assert.equal(next.dropped, false);
      assert.ok(next.nextOffset > offset);
      remaining += next.data;
      offset = next.nextOffset;
    }
    assert.equal(first.stdout.data + remaining, "345éXYZabcd");
    assert.equal(offset, 15);
  } finally {
    await manager.dispose();
  }
});

test(
  "stop terminates the owned detached process group, reaches terminal state, and is idempotent",
  { skip: process.platform === "win32" },
  async () => {
    const manager = new ShellManager({ stopGraceMs: 100 });
    let groupPid: number | undefined;
    try {
      const started = manager.start({
        ownerId: "owner",
        cwd,
        command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(String(process.pid) + "\\n"); setInterval(() => {}, 1000)' & wait`,
      });
      groupPid = started.pid;
      assert.ok(groupPid !== undefined);

      const withPid = await waitFor(
        () => readShell(manager, started.shellId),
        (result) => /^\d+\n$/.test(result.stdout.data),
      );
      const descendantPid = Number.parseInt(withPid.stdout.data, 10);
      assert.ok(Number.isSafeInteger(descendantPid));

      const stopped = await manager.stop({
        requesterId: "owner",
        isAdmin: false,
        shellId: started.shellId,
      });
      assert.equal(stopped.state, "stopped");
      assert.ok(stopped.endedAt !== undefined);

      const stoppedAgain = await manager.stop({
        requesterId: "owner",
        isAdmin: false,
        shellId: started.shellId,
      });
      assert.deepEqual(stoppedAgain, stopped);

      await waitFor(() => {
        try {
          process.kill(descendantPid, 0);
          return false;
        } catch (error) {
          return error instanceof Error && "code" in error && error.code === "ESRCH";
        }
      }, Boolean);
    } finally {
      await manager.dispose();
      if (groupPid !== undefined) {
        try {
          process.kill(-groupPid, "SIGKILL");
        } catch (error) {
          assert.ok(error instanceof Error);
          assert.equal("code" in error ? error.code : undefined, "ESRCH");
        }
      }
    }
  },
);

test("owners see and control only their shells while an admin can access all shells", async () => {
  const manager = new ShellManager({
    shell: process.execPath,
    shellArgs: ["-e"],
    stopGraceMs: 100,
  });
  try {
    const alpha = manager.start({ ownerId: "alpha", cwd, command: "setInterval(() => {}, 1000)" });
    const beta = manager.start({ ownerId: "beta", cwd, command: "setInterval(() => {}, 1000)" });

    assert.deepEqual(
      manager.list({ requesterId: "alpha", isAdmin: false }).shells.map((s) => s.shellId),
      [alpha.shellId],
    );
    assert.deepEqual(
      manager.list({ requesterId: "beta", isAdmin: false }).shells.map((s) => s.shellId),
      [beta.shellId],
    );
    assert.deepEqual(
      new Set(manager.list({ requesterId: "root", isAdmin: true }).shells.map((s) => s.shellId)),
      new Set([alpha.shellId, beta.shellId]),
    );
    assert.throws(
      () => manager.read({ requesterId: "beta", isAdmin: false, shellId: alpha.shellId }),
      /Access denied/,
    );
    await assert.rejects(
      manager.stop({ requesterId: "beta", isAdmin: false, shellId: alpha.shellId }),
      /Access denied/,
    );

    assert.equal(
      manager.read({ requesterId: "root", isAdmin: true, shellId: alpha.shellId }).shell.ownerId,
      "alpha",
    );
    assert.equal(
      (await manager.stop({ requesterId: "root", isAdmin: true, shellId: alpha.shellId })).state,
      "stopped",
    );
  } finally {
    await manager.dispose();
  }
});

test("cleanupOwner stops only that owner's shells and dispose stops the rest once", async () => {
  const manager = new ShellManager({
    shell: process.execPath,
    shellArgs: ["-e"],
    stopGraceMs: 100,
  });
  const first = manager.start({ ownerId: "alpha", cwd, command: "setInterval(() => {}, 1000)" });
  const second = manager.start({ ownerId: "alpha", cwd, command: "setInterval(() => {}, 1000)" });
  const other = manager.start({ ownerId: "beta", cwd, command: "setInterval(() => {}, 1000)" });

  try {
    await manager.cleanupOwner("alpha");
    const afterCleanup = manager.list({ requesterId: "root", isAdmin: true }).shells;
    assert.equal(afterCleanup.find((shell) => shell.shellId === first.shellId)?.state, "stopped");
    assert.equal(afterCleanup.find((shell) => shell.shellId === second.shellId)?.state, "stopped");
    assert.equal(afterCleanup.find((shell) => shell.shellId === other.shellId)?.state, "running");

    const disposing = manager.dispose();
    assert.strictEqual(manager.dispose(), disposing);
    await disposing;
    assert.equal(
      manager
        .list({ requesterId: "root", isAdmin: true })
        .shells.find((shell) => shell.shellId === other.shellId)?.state,
      "stopped",
    );
    assert.throws(
      () => manager.start({ ownerId: "alpha", cwd, command: "process.exit()" }),
      /disposed/,
    );
  } finally {
    await manager.dispose();
  }
});

test("completed record retention evicts oldest terminal records but never running records", async () => {
  const manager = new ShellManager({
    shell: process.execPath,
    shellArgs: ["-e"],
    completedRecordCap: 2,
  });
  try {
    const running = manager.start({
      ownerId: "owner",
      cwd,
      command: "setInterval(() => {}, 1000)",
    });
    const completedIds: string[] = [];
    for (const output of ["first", "second", "third"]) {
      const started = manager.start({
        ownerId: "owner",
        cwd,
        command: `process.stdout.write(${JSON.stringify(output)})`,
      });
      completedIds.push(started.shellId);
      await waitFor(
        () => readShell(manager, started.shellId),
        (result) => isTerminal(result.shell),
      );
    }

    assert.throws(() => readShell(manager, completedIds[0] ?? ""), /Shell not found/);
    assert.equal(readShell(manager, completedIds[1] ?? "").stdout.data, "second");
    assert.equal(readShell(manager, completedIds[2] ?? "").stdout.data, "third");
    assert.equal(readShell(manager, running.shellId).shell.state, "running");
    assert.deepEqual(
      manager.list({ requesterId: "owner", isAdmin: false }).shells.map((shell) => shell.shellId),
      [running.shellId, completedIds[1], completedIds[2]],
    );
  } finally {
    await manager.dispose();
  }
});

test("start rejects missing and non-directory cwd before retaining a shell record", async () => {
  const manager = new ShellManager({ shell: process.execPath, shellArgs: ["-e"] });
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "choco-pi-shells-cwd-"));
  const fixtureFile = join(fixtureDirectory, "file");
  const missingDirectory = join(fixtureDirectory, "missing");
  writeFileSync(fixtureFile, "fixture");
  try {
    for (const invalidCwd of [missingDirectory, fixtureFile]) {
      assert.throws(
        () =>
          manager.start({
            ownerId: "owner",
            cwd: invalidCwd,
            command: "process.exit()",
          }),
        /cwd is not an existing directory/,
      );
    }
    assert.deepEqual(manager.list({ requesterId: "owner", isAdmin: false }).shells, []);
  } finally {
    await manager.dispose();
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});
