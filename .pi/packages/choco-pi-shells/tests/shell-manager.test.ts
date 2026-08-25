import assert from "node:assert/strict";
import test from "node:test";

import { ShellManager, type ShellResult } from "../src/shell-manager.ts";

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
