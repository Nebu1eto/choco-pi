import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import {
  descendantGroups,
  descendantPids,
  killProcessTarget,
  killUnixDescendants,
  parseProcessTable,
} from "../src/tools/exec/bridge-client.ts";

const unix = process.platform !== "win32";

test(
  "killing a process that already exited is the expected race and reports nothing",
  { skip: !unix },
  async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    assert.ok(pid);
    await once(child, "exit");
    assert.equal(killProcessTarget(pid), undefined);
  },
);

test(
  "a kill refused for another reason is returned, not swallowed",
  {
    // SIGKILL to pid 1 is refused (EPERM) for an unprivileged user; as root it would succeed.
    skip: !unix || process.getuid?.() === 0,
  },
  () => {
    const failure = killProcessTarget(1);
    assert.ok(failure instanceof Error);
    assert.ok("code" in failure);
    assert.equal(failure.code, "EPERM");
  },
);
test("the process table parses pid, parent and group and skips malformed lines", () => {
  assert.deepEqual(parseProcessTable("  10     1    10\n 11 10 11\n\ngarbage\n 12 11\n"), [
    { pid: 10, parentPid: 1, processGroupId: 10 },
    { pid: 11, parentPid: 10, processGroupId: 11 },
  ]);
});

test("descendants are found transitively regardless of table order", () => {
  const table = [
    { pid: 13, parentPid: 12, processGroupId: 13 },
    { pid: 12, parentPid: 11, processGroupId: 12 },
    { pid: 11, parentPid: 10, processGroupId: 10 },
    { pid: 20, parentPid: 1, processGroupId: 20 },
  ];
  assert.deepEqual([...descendantPids(table, 10)].sort(), [10, 11, 12, 13]);
});

test("groups to kill exclude the root's own entry and the caller's group", () => {
  const table = [
    { pid: 5, parentPid: 1, processGroupId: 5 },
    { pid: 10, parentPid: 5, processGroupId: 5 },
    { pid: 11, parentPid: 10, processGroupId: 5 },
    { pid: 12, parentPid: 10, processGroupId: 12 },
    { pid: 13, parentPid: 12, processGroupId: 12 },
  ];
  const descendants = descendantPids(table, 10);
  assert.deepEqual([...descendantGroups(table, descendants, 10, 5)], [12]);
});
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

test(
  "descendants of a live root, in another process group, are killed and the root is left alone",
  {
    skip: !unix,
  },
  async () => {
    // The shell leads its own group (detached); its background sleep runs in a group of its own
    // because job control (set -m) gives each background job a new group. After the job dies the
    // shell execs a sleep, so the root keeps its pid and nothing is orphaned.
    const shell = spawn("sh", ["-c", "set -m; sleep 60 & echo $!; wait; exec sleep 60"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let sleeper = 0;
    try {
      const [line] = await once(shell.stdout.setEncoding("utf8"), "data");
      sleeper = Number(String(line).trim());
      assert.ok(shell.pid && sleeper > 0);
      assert.equal(isAlive(sleeper), true);
      assert.deepEqual(await killUnixDescendants(shell.pid), []);
      for (let i = 0; i < 50 && isAlive(sleeper); i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(isAlive(sleeper), false, "the descendant is gone");
      assert.equal(isAlive(shell.pid), true, "the root itself is the caller's to kill");
    } finally {
      shell.kill("SIGKILL");
      // On a failure the sleeper survives and holds the stdout pipe; never leave it to the runner.
      if (sleeper > 0 && isAlive(sleeper)) process.kill(sleeper, "SIGKILL");
    }
  },
);
